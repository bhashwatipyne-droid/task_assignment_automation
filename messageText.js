// ============================================================
// MESSAGE TEXT
// Pulls the text out of a WhatsApp message in any of the shapes a
// manager's tasklist can arrive in. WhatsApp wraps a message in another
// message when disappearing messages are on, or it was sent view-once or as
// a document with a caption, so the wrappers are opened one by one.
// ============================================================

const WRAPPERS = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
];

function extractMessageText(message) {

    let current = message;

    for (let depth = 0; current && depth < 6; depth++) {

        if (current.conversation) return current.conversation;

        if (current.extendedTextMessage?.text) return current.extendedTextMessage.text;
        if (current.imageMessage?.caption) return current.imageMessage.caption;
        if (current.videoMessage?.caption) return current.videoMessage.caption;
        if (current.documentMessage?.caption) return current.documentMessage.caption;

        if (current.buttonsResponseMessage?.selectedDisplayText) {
            return current.buttonsResponseMessage.selectedDisplayText;
        }

        if (current.listResponseMessage?.title) return current.listResponseMessage.title;

        if (current.templateButtonReplyMessage?.selectedDisplayText) {
            return current.templateButtonReplyMessage.selectedDisplayText;
        }

        const wrapper = WRAPPERS.find(name => current[name]?.message);

        current = wrapper ? current[wrapper].message : null;

    }

    return "";

}

module.exports = { extractMessageText };
