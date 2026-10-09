
require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");

const P = require("pino");
const qrcode = require("qrcode-terminal");
const path = require("path");

const {
  detectTeam,
  isTaskListMessage,
  parseTaskList,
} = require("./tasklistParser");

// ============================================================
// CONFIGURATION
// ============================================================

const AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";

const KEYWORDS = (process.env.KEYWORDS || "content,design,tasklist,project,client")
  .split(",")
  .map((keyword) => keyword.trim().toLowerCase())
  .filter(Boolean);

const ASSIGNEES = (process.env.ASSIGNEES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

function normalizeGroupName(name) {
  return String(name || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const ALLOWED_GROUPS = (process.env.ALLOWED_GROUP_NAMES || "")
  .split(",")
  .map(normalizeGroupName)
  .filter(Boolean);

const MANAGER_NUMBERS = (process.env.MANAGER_JIDS || "")
  .split(",")
  .map((number) => number.trim().replace(/\D/g, ""))
  .filter(Boolean);

let reconnectTimer = null;
let starting = false;
let stopping = false;

// ============================================================
// HELPERS
// ============================================================

function log(label, ...values) {
  console.log(`[${new Date().toLocaleString()}] [${label}]`, ...values);
}

function extractNumberFromJid(jid) {
  if (!jid) return "";
  return String(jid).split("@")[0].replace(/\D/g, "");
}

function getMessageText(message) {
  let current = message;

  for (let i = 0; current && i < 6; i++) {
    if (current.conversation) return current.conversation;
    if (current.extendedTextMessage?.text) return current.extendedTextMessage.text;
    if (current.imageMessage?.caption) return current.imageMessage.caption;
    if (current.videoMessage?.caption) return current.videoMessage.caption;
    if (current.documentMessage?.caption) return current.documentMessage.caption;

    if (current.buttonsResponseMessage?.selectedDisplayText) {
      return current.buttonsResponseMessage.selectedDisplayText;
    }

    if (current.listResponseMessage?.title) {
      return current.listResponseMessage.title;
    }

    if (current.templateButtonReplyMessage?.selectedDisplayText) {
      return current.templateButtonReplyMessage.selectedDisplayText;
    }

    current =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.documentWithCaptionMessage?.message ||
      null;
  }

  return "";
}

function detectKeywords(text) {
  const lowerText = String(text || "").toLowerCase();
  return KEYWORDS.filter((keyword) => lowerText.includes(keyword));
}

function identifySender(message) {
  const senderJid =
    message.key?.participant ||
    message.key?.remoteJid ||
    "";

  const senderAltJid = message.key?.participantAlt || "";

  const senderNumber = extractNumberFromJid(senderJid);
  const senderAltNumber = extractNumberFromJid(senderAltJid);

  const fromManager =
    message.key?.fromMe === true ||
    MANAGER_NUMBERS.includes(senderNumber) ||
    MANAGER_NUMBERS.includes(senderAltNumber);

  return {
    fromManager,
    senderJid,
    senderAltJid,
    senderNumber,
    senderAltNumber,
  };
}

function printJson(label, value) {
  console.log(`${label}:\n${JSON.stringify(value, null, 2)}`);
}

// ============================================================
// WHATSAPP LISTENER
// ============================================================

async function startWhatsApp() {
  if (starting || stopping) return;

  starting = true;

  log("SYSTEM", "Starting terminal-only WhatsApp PMT listener.");
  log("SYSTEM", `Authentication folder: ${path.resolve(AUTH_DIR)}`);
  log("SYSTEM", `Managers: ${MANAGER_NUMBERS.join(", ") || "(none configured)"}`);
  log("SYSTEM", `Allowed groups: ${ALLOWED_GROUPS.join(", ") || "(none configured)"}`);
  log("SYSTEM", `Keywords: ${KEYWORDS.join(", ")}`);
  log("SYSTEM", "Private chats and non-manager messages will be ignored.");
  log("SYSTEM", "n8n disabled; MongoDB disconnected; no database writes.");

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState(path.resolve(AUTH_DIR));

    const sock = makeWASocket({
      auth: state,
      logger: P({ level: "silent" }),
      browser: Browsers.windows("Chrome"),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n========================================");
        console.log("WHATSAPP QR CODE REQUIRED");
        console.log("WhatsApp > Settings > Linked Devices > Link a Device");
        qrcode.generate(qr, { small: true });
        console.log("========================================\n");
      }

      if (connection === "connecting") {
        log("WHATSAPP", "Connecting...");
      }

      if (connection === "open") {
        starting = false;
        log("WHATSAPP", "Connected successfully.");
        log("WHATSAPP", "Waiting for manager messages in allowed groups.");
      }

      if (connection !== "close") return;

      starting = false;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode ??
        "unknown";

      log("WHATSAPP", `Connection closed. Status code: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        log("ERROR", "WhatsApp logged out. Re-authentication may be required.");
        return;
      }

      if (statusCode === 440) {
        log("ERROR", "Session conflict. Check for another listener using this session.");
      }

      if (!stopping && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startWhatsApp().catch((error) => {
            log("ERROR", error.stack || error.message);
          });
        }, 5000);
      }
    });

    // ========================================================
    // RECEIVE MESSAGES
    // ========================================================

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages || []) {
        if (!message?.message) {
          log("SKIP", "Empty message.");
          continue;
        }

        const remoteJid = message.key?.remoteJid || "";

        if (remoteJid === "status@broadcast") {
          log("SKIP", "Ignoring WhatsApp status.");
          continue;
        }

        // Ignore messages sent by this account.
        if (message.key?.fromMe) {
          log("SKIP", "Ignoring message sent by this account.");
          continue;
        }

        // PRIVATE CHAT FILTER
        if (!remoteJid.endsWith("@g.us")) {
          log("SKIP", "Private/non-group message ignored.");
          continue;
        }

        // GROUP METADATA
        let metadata;

        try {
          metadata = await sock.groupMetadata(remoteJid);
        } catch (error) {
          log("SKIP", `Could not read group metadata: ${error.message}`);
          continue;
        }

        const groupName = metadata.subject || remoteJid;
        const normalizedGroupName = normalizeGroupName(groupName);

        // Fail closed when no groups are configured.
        if (!ALLOWED_GROUPS.length) {
          log("SKIP", "No ALLOWED_GROUP_NAMES configured. Ignoring group.");
          continue;
        }

        // ALLOWED GROUP FILTER
        if (!ALLOWED_GROUPS.includes(normalizedGroupName)) {
          log("SKIP", `Ignoring unauthorized group: ${groupName}`);
          continue;
        }

        // MANAGER FILTER
        const sender = identifySender(message);

        log("MESSAGE CHECK", "=================================");
        log("GROUP", groupName);
        log("Sender JID", sender.senderJid || "(none)");
        log("Sender Alt JID", sender.senderAltJid || "(none)");
        log("Sender Number", sender.senderNumber || "(none)");
        log("Sender Alt Number", sender.senderAltNumber || "(none)");
        log("Manager Numbers", MANAGER_NUMBERS);
        log("From Manager", sender.fromManager);
        log("=================================");

        if (!sender.fromManager) {
          log(
            "SKIP",
            `Ignoring non-manager message from: ${sender.senderJid || "unknown"}`
          );
          continue;
        }

        // TEXT EXTRACTION
        const text = getMessageText(message.message).trim();

        if (!text) {
          log("SKIP", "Manager message has no supported text/caption.");
          continue;
        }

        // KEYWORDS / TEAM / TASKLIST
        const detectedKeywords = detectKeywords(text);
        const isTaskList = isTaskListMessage(text);
        const team = detectTeam(text);

        log("MANAGER MESSAGE", `Group: ${groupName}`);
        log("Detected Keywords", detectedKeywords);
        log("Detected Team", team || "(none)");
        log("Is Tasklist", isTaskList);
        console.log("Message text:\n" + text);

        // PARSE TASKLIST
        let parsedTaskList = null;

        if (isTaskList) {
          try {
            parsedTaskList = parseTaskList(text, ASSIGNEES);
            printJson("PARSED TASKLIST", parsedTaskList);

            if (parsedTaskList?.warnings?.length) {
              console.log("Warnings:");
              parsedTaskList.warnings.forEach((warning) => {
                console.log(` - ${warning}`);
              });
            }
          } catch (error) {
            log("PARSER ERROR", error.stack || error.message);
          }
        }

        // TERMINAL OUTPUT PAYLOAD
        const payload = {
          message_id: message.key?.id || null,
          chat_id: remoteJid,
          group_name: groupName,
          sender: "MANAGER",
          sender_jid: sender.senderJid,
          sender_alt_jid: sender.senderAltJid,
          sender_number: sender.senderNumber,
          sender_alt_number: sender.senderAltNumber,
          from_manager: true,
          is_group: true,
          message: text,
          detected_keywords: detectedKeywords,
          is_tasklist: isTaskList,
          team,
          parsed_tasklist: parsedTaskList,
          timestamp: message.messageTimestamp
            ? new Date(
                Number(message.messageTimestamp) * 1000
              ).toISOString()
            : new Date().toISOString(),
        };

        console.log("\n========================================");
        console.log("FILTERED MANAGER MESSAGE — TERMINAL ONLY");
        console.log("========================================");
        printJson("PAYLOAD", payload);
        console.log("n8n: disabled");
        console.log("MongoDB: not connected");
        console.log("Database inserts/updates: none");
        console.log("========================================\n");
      }
    });
  } catch (error) {
    starting = false;
    log("START ERROR", error.stack || error.message);

    if (!stopping && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp().catch((err) => {
          log("ERROR", err.stack || err.message);
        });
      }, 5000);
    }
  }
}

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown(signal) {
  log("SYSTEM", `${signal} received. Shutting down.`);
  stopping = true;

  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = null;
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startWhatsApp().catch((error) => {
  log("FATAL", error.stack || error.message);
});
