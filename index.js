require("dns").setServers(["8.8.8.8", "1.1.1.1"]);

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require("@whiskeysockets/baileys");

const P = require("pino");
const express = require("express");
const qrcode = require("qrcode-terminal");
const { createQrPage } = require("./qrPage");

require("dotenv").config();

// Tasklist parsing (team detection + client / project / deliverable split)
const {
    detectTeam,
    isTaskListMessage,
    parseTaskList
} = require("./tasklistParser");

// Direct MongoDB storage (replaces the n8n webhook)
const store = require("./mongoStore");
const TEAM_ROSTER = require("./teamRoster.json");

// Only used to log which lexicon build made each match
const matcher = require("./tasklistMatcher");


// When WhatsApp says the message was sent (Baileys gives seconds, sometimes
// as a Long). A message delivered late, or again after a reconnect, must keep
// its real day, not the day it happened to arrive.
function messageTime(message) {

    const raw = message.messageTimestamp;

    const seconds =
        raw && typeof raw.toNumber === "function"
            ? raw.toNumber()
            : Number(raw);

    if (Number.isFinite(seconds) && seconds > 0) {
        return new Date(seconds * 1000).toISOString();
    }

    return new Date().toISOString();

}


// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

// n8n is no longer needed. Set FORWARD_TO_N8N=true to also post every
// manager message to the webhook (off by default).
const FORWARD_TO_N8N =
    /^(1|true|yes|on)$/i.test(process.env.FORWARD_TO_N8N || "");

const N8N_WEBHOOK_URL =
    process.env.N8N_WEBHOOK_URL || "";


// ============================================================
// KEYWORDS FROM .ENV
// ============================================================
//
// KEYWORDS=content,design,tasklist
//

const KEYWORDS =
    (process.env.KEYWORDS || "")
        .split(",")
        .map(keyword =>
            keyword.trim().toLowerCase()
        )
        .filter(Boolean);


// ============================================================
// ASSIGNEES FROM .ENV
// ============================================================
//
// ASSIGNEES=Harshal,Vanshika,Krishna,Ratnesh,Milind,...
//

const ASSIGNEES =
    (process.env.ASSIGNEES || "")
        .split(",")
        .map(name =>
            name.trim()
        )
        .filter(Boolean);


// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Normalize group names
function normalizeGroupName(name) {

    return (name || "")
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

}


// Get manager numbers
function getManagerNumbers() {

    return (process.env.MANAGER_JIDS || "")
        .split(",")
        .map(number =>
            number
                .trim()
                .replace(/\D/g, "")
        )
        .filter(Boolean);

}


// Extract number from WhatsApp JID
function extractNumberFromJid(jid) {

    if (!jid) {
        return "";
    }

    return jid
        .split("@")[0]
        .replace(/\D/g, "");

}


// Keyword detection
function detectKeywords(text) {

    const lowerText =
        (text || "").toLowerCase();

    return KEYWORDS.filter(keyword =>
        lowerText.includes(keyword)
    );

}


// ============================================================
// EXPRESS SERVER
// ============================================================

const app = express();

// Password-protected PNG page for linking WhatsApp (on only when QR_PAGE_TOKEN is set).
const qrPage = createQrPage();
app.set("trust proxy", 1); // Render sits behind one proxy: real client IP for the /qr throttle

app.use(express.json());


// Link-WhatsApp QR image (HTTP Basic auth, password = QR_PAGE_TOKEN)
app.get("/qr", (req, res, next) => qrPage.handler(req, res).catch(next));


// Health check
app.get("/", (req, res) => {

    res.json({
        status: "running",
        service: "WhatsApp PMT Listener",
        whatsapp: "listener active"
    });

});


// ============================================================
// START WHATSAPP
// ============================================================

async function startWhatsApp() {

    console.log("");
    console.log("========================================");
    console.log("STARTING WHATSAPP LISTENER");
    console.log("========================================");
    console.log("");


    // ========================================================
    // AUTHENTICATION
    // ========================================================

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            "./auth_info"
        );


    // ========================================================
    // CREATE WHATSAPP SOCKET
    // ========================================================

    const sock =
        makeWASocket({

            auth: state,

            logger:
                P({
                    level: "silent"
                }),

            browser:
                Browsers.windows("Chrome"),

            markOnlineOnConnect: false,

            generateHighQualityLinkPreview: false

        });


    // Save credentials
    sock.ev.on(
        "creds.update",
        saveCreds
    );


    // ========================================================
    // CONNECTION EVENTS
    // ========================================================

    sock.ev.on(
        "connection.update",
        async (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;


            // ------------------------------------------------
            // QR CODE
            // ------------------------------------------------

            if (qr && qrPage.enabled) {

                // Shown as an image on /qr; never printed to the logs.
                qrPage.setQr(qr);
                console.log("QR code ready: open /qr on this service to scan it.");

            } else if (qr) {

                console.log("");
                console.log("========================================");
                console.log("SCAN THIS QR CODE WITH WHATSAPP");
                console.log("========================================");

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );

                console.log("========================================");
                console.log("Open WhatsApp on your phone:");
                console.log("Settings → Linked Devices → Link a Device");
                console.log("");

            }


            // ------------------------------------------------
            // CONNECTED
            // ------------------------------------------------

            if (connection === "open") {

                qrPage.markLinked();

                console.log("");
                console.log("========================================");
                console.log("WHATSAPP CONNECTED SUCCESSFULLY");
                console.log("========================================");
                console.log("");
                console.log("Waiting for WhatsApp messages...");
                console.log("");


                // Allowed groups
                console.log("Allowed Groups:");

                const allowedGroups =
                    (process.env.ALLOWED_GROUP_NAMES || "")
                        .split(",")
                        .map(normalizeGroupName)
                        .filter(Boolean);

                allowedGroups.forEach(group => {
                    console.log(`  - ${group}`);
                });

                console.log("");


                // Managers
                console.log("Manager Numbers:");

                getManagerNumbers().forEach(number => {
                    console.log(`  - ${number}`);
                });

                console.log("");


                // Keywords
                console.log("Tasklist Keywords:");

                KEYWORDS.forEach(keyword => {
                    console.log(`  - ${keyword}`);
                });

                console.log("");


                // Assignees
                console.log("Configured Assignees:");

                ASSIGNEES.forEach(name => {
                    console.log(`  - ${name}`);
                });

                console.log("");

            }


            // ------------------------------------------------
            // CONNECTION CLOSED
            // ------------------------------------------------

            if (connection === "close") {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;

                console.log("");
                console.log("========================================");
                console.log("WHATSAPP CONNECTION CLOSED");
                console.log("Status Code:", statusCode);
                console.log("========================================");

                if (shouldReconnect) {

                    console.log("Reconnecting...");

                    setTimeout(
                        () => {
                            startWhatsApp();
                        },
                        3000
                    );

                }

                else {

                    console.log("");
                    console.log("WhatsApp logged out.");
                    console.log("Delete the auth_info folder");
                    console.log("and restart to scan a new QR.");

                }

            }

        }
    );


    // ========================================================
    // RECEIVE MESSAGES
    // ========================================================

    sock.ev.on(
        "messages.upsert",
        async ({
            messages,
            type
        }) => {

            // Only new messages
            if (type !== "notify") {
                return;
            }


            for (const message of messages) {

                // Ignore empty message
                if (!message.message) {
                    continue;
                }


                const remoteJid =
                    message.key.remoteJid;


                // Ignore status
                if (remoteJid === "status@broadcast") {
                    continue;
                }


                // ============================================
                // GROUPS ONLY
                // ============================================

                const isGroup =
                    remoteJid &&
                    remoteJid.endsWith("@g.us");

                if (!isGroup) {

                    console.log("Private chat ignored.");
                    continue;

                }


                // ============================================
                // GROUP METADATA
                // ============================================

                let metadata;

                try {

                    metadata =
                        await sock.groupMetadata(
                            remoteJid
                        );

                }

                catch (error) {

                    console.log("Could not read group metadata.");
                    continue;

                }

                const groupName =
                    metadata.subject || "";


                // ============================================
                // ALLOWED GROUPS
                // ============================================

                const allowedGroups =
                    (process.env.ALLOWED_GROUP_NAMES || "")
                        .split(",")
                        .map(normalizeGroupName)
                        .filter(Boolean);

                const normalizedGroupName =
                    normalizeGroupName(groupName);

                if (!allowedGroups.includes(normalizedGroupName)) {

                    console.log(
                        `Ignoring unauthorized group: ${groupName}`
                    );
                    continue;

                }


                // ============================================
                // SENDER + MANAGER DETECTION
                // ============================================

                const sender =
                    message.key.participant ||
                    remoteJid;

                const managerNumbers =
                    getManagerNumbers();

                const senderJid =
                    message.key.participant ||
                    message.key.remoteJid ||
                    "";

                const senderAltJid =
                    message.key.participantAlt ||
                    "";

                const senderNumber =
                    extractNumberFromJid(senderJid);

                const senderAltNumber =
                    extractNumberFromJid(senderAltJid);

                const isManagerByNumber =
                    managerNumbers.includes(senderNumber) ||
                    managerNumbers.includes(senderAltNumber);

                const fromManager =
                    message.key.fromMe === true ||
                    isManagerByNumber;


                // ============================================
                // DEBUG INFORMATION
                // ============================================

                console.log("");
                console.log("=================================");
                console.log("MESSAGE RECEIVED");
                console.log("Group:", groupName);
                console.log("Sender JID:", senderJid);
                console.log("Sender Alt JID:", senderAltJid || "(none)");
                console.log("Sender Number:", senderNumber || "(none)");
                console.log("Sender Alt Number:", senderAltNumber || "(none)");
                console.log("Manager Numbers:", managerNumbers);
                console.log("From Me:", message.key.fromMe);
                console.log("From Manager:", fromManager);
                console.log("=================================");


                // Ignore non-managers
                if (!fromManager) {

                    console.log(
                        `Ignoring non-manager message from: ${senderJid}`
                    );
                    continue;

                }


                // ============================================
                // EXTRACT MESSAGE TEXT
                // ============================================

                let text = "";

                if (message.message.conversation) {

                    text =
                        message.message.conversation;

                }

                else if (message.message.extendedTextMessage) {

                    text =
                        message.message
                            .extendedTextMessage
                            .text;

                }

                else if (message.message.imageMessage?.caption) {

                    text =
                        message.message
                            .imageMessage
                            .caption;

                }

                else if (message.message.videoMessage?.caption) {

                    text =
                        message.message
                            .videoMessage
                            .caption;

                }

                if (!text) {

                    console.log(
                        "Received non-text message. Ignoring."
                    );
                    continue;

                }


                // ============================================
                // KEYWORDS / TEAM / TASKLIST
                // ============================================

                const detectedKeywords =
                    detectKeywords(text);

                const isTaskList =
                    isTaskListMessage(text);

                const team =
                    detectTeam(text);

                console.log("");
                console.log("Detected Keywords:", detectedKeywords);
                console.log("Detected Team:", team || "(none)");
                console.log("Is Tasklist:", isTaskList);
                console.log("");


                // ============================================
                // PARSE TASKLIST
                // ============================================

                let parsedTaskList = null;

                if (isTaskList) {

                    // env list + live PMT users + bundled roster, so every
                    // team member (test accounts included) is recognised
                    const knownAssignees = [...new Set([
                        ...ASSIGNEES,
                        ...store.assigneeNames(await store.loadUsers()),
                        ...store.assigneeNames(TEAM_ROSTER)
                    ])];

                    parsedTaskList =
                        parseTaskList(
                            text,
                            knownAssignees
                        );

                    console.log("========================================");
                    console.log("PARSED TASKLIST");
                    console.log("========================================");

                    console.log(
                        JSON.stringify(
                            parsedTaskList,
                            null,
                            2
                        )
                    );

                    if (parsedTaskList.warnings.length > 0) {

                        console.log("Warnings:");

                        parsedTaskList.warnings.forEach(w => {
                            console.log(`  - ${w}`);
                        });

                    }

                    console.log("========================================");
                    console.log("");

                }


                // ============================================
                // BUILD PAYLOAD
                // ============================================

                const payload = {

                    message_id: message.key.id,

                    chat_id: remoteJid,

                    group_name: groupName,

                    sender:
                        fromManager
                            ? "MANAGER"
                            : sender,

                    sender_jid: senderJid,

                    sender_alt_jid: senderAltJid,

                    sender_number: senderNumber,

                    sender_alt_number: senderAltNumber,

                    from_manager: fromManager,

                    is_group: isGroup,

                    message: text,

                    detected_keywords: detectedKeywords,

                    is_tasklist: isTaskList,

                    team: team,

                    parsed_tasklist: parsedTaskList,

                    lexicon_built_at:
                        matcher.lexiconInfo().built_at,

                    timestamp:
                        messageTime(message)

                };


                // ============================================
                // DISPLAY FINAL PAYLOAD
                // ============================================

                console.log("");
                console.log("========================================");
                console.log("        NEW MANAGER MESSAGE");
                console.log("========================================");
                console.log("Group:", payload.group_name);
                console.log("Sender:", payload.sender);
                console.log("Team:", payload.team);
                console.log("Is Tasklist:", payload.is_tasklist);
                console.log("Detected Keywords:", payload.detected_keywords);
                console.log("----------------------------------------");
                console.log("PARSED TASKS:");

                console.log(
                    JSON.stringify(
                        payload.parsed_tasklist,
                        null,
                        2
                    )
                );

                console.log("========================================");
                console.log("");


                // ============================================
                // STORE IN MONGODB
                // ============================================

                if (isTaskList) {

                    try {

                        const outcome =
                            await store.saveTasklist(payload);

                        console.log(
                            "Store result:",
                            JSON.stringify(outcome)
                        );

                    }

                    catch (error) {

                        console.error("");
                        console.error("========================================");
                        console.error("FAILED TO STORE TASKLIST");
                        console.error("========================================");
                        console.error(error.message);
                        console.error("");

                    }

                }

                else {

                    console.log(
                        "Manager message is not a tasklist. Not stored."
                    );

                }


                // ============================================
                // OPTIONAL: ALSO FORWARD TO N8N
                // ============================================

                if (
                    FORWARD_TO_N8N &&
                    N8N_WEBHOOK_URL &&
                    N8N_WEBHOOK_URL.trim() !== ""
                ) {

                    try {

                        const response =
                            await fetch(
                                N8N_WEBHOOK_URL,
                                {

                                    method: "POST",

                                    headers: {
                                        "Content-Type":
                                            "application/json"
                                    },

                                    body:
                                        JSON.stringify(payload)

                                }
                            );

                        console.log("n8n HTTP Status:", response.status);

                    }

                    catch (error) {

                        console.error(
                            "n8n forward failed:",
                            error.message
                        );

                    }

                }

            }

        }
    );

}


// ============================================================
// START EXPRESS SERVER
// ============================================================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log("========================================");
        console.log(`Listener server running on port ${PORT}`);
        console.log("========================================");
        console.log("");

    }
);


// ============================================================
// START WHATSAPP
// ============================================================

// Connect to MongoDB first (the listener keeps running even if
// MongoDB is unreachable: tasklists wait in ./outbox and are retried)
store.init()
    .catch((error) => {
        console.error("Store init error:", error.message);
    })
    .then(() => startWhatsApp())
    .catch(
        (error) => {

            console.error("");
            console.error("========================================");
            console.error("FAILED TO START WHATSAPP");
            console.error("========================================");
            console.error(error);

        }
    );


// ============================================================
// CLEAN SHUTDOWN
// ============================================================

process.on("SIGINT", async () => {

    console.log("");
    console.log("Shutting down...");

    await store.close();

    process.exit(0);

});
