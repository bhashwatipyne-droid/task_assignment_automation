const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require("@whiskeysockets/baileys");

const P = require("pino");
const express = require("express");
const qrcode = require("qrcode-terminal");

require("dotenv").config();

// Tasklist parsing (team detection + client / project / deliverable split)
const {
    detectTeam,
    isTaskListMessage,
    parseTaskList
} = require("./tasklistParser");


// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

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

app.use(express.json());


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

            if (qr) {

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

                    parsedTaskList =
                        parseTaskList(
                            text,
                            ASSIGNEES
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

                    timestamp:
                        new Date().toISOString()

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
                // SEND TO N8N
                // ============================================

                if (
                    N8N_WEBHOOK_URL &&
                    N8N_WEBHOOK_URL.trim() !== ""
                ) {

                    try {

                        console.log("Sending message to n8n...");

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

                        const responseText =
                            await response.text();

                        console.log("n8n HTTP Status:", response.status);
                        console.log("n8n Response:", responseText);

                    }

                    catch (error) {

                        console.error("");
                        console.error("========================================");
                        console.error("FAILED TO SEND MESSAGE TO N8N");
                        console.error("========================================");
                        console.error(error.message);
                        console.error("");

                    }

                }

                else {

                    console.log("N8N_WEBHOOK_URL is not configured.");
                    console.log("Message was received successfully,");
                    console.log("but it was NOT sent to n8n.");

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

startWhatsApp()
    .catch(
        (error) => {

            console.error("");
            console.error("========================================");
            console.error("FAILED TO START WHATSAPP");
            console.error("========================================");
            console.error(error);

        }
    );