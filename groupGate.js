// ============================================================
// GROUP GATE
// Which WhatsApp groups the listener accepts tasklists from.
//
//   ALLOWED_GROUP_JIDS   comma-separated group ids (1203...@g.us). When set it
//                        is the ONLY check: a renamed group keeps working and
//                        a different group with the same name is refused.
//   ALLOWED_GROUP_NAMES  comma-separated group names, used when no ids are set.
// ============================================================

function normalizeGroupName(name) {

    return (name || "")
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

}


function list(value) {

    return (value || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);

}


function allowedJids() {
    return list(process.env.ALLOWED_GROUP_JIDS).map(jid => jid.toLowerCase());
}


function allowedNames() {
    return list(process.env.ALLOWED_GROUP_NAMES).map(normalizeGroupName).filter(Boolean);
}


// Is this group accepted? (subject may be unknown for delete / edit notices)
function isGroupAllowed(jid, subject) {

    const jids = allowedJids();

    if (jids.length) return jids.includes(String(jid || "").toLowerCase());

    return allowedNames().includes(normalizeGroupName(subject));

}


// Delete / edit notices carry no group name. With ids configured they are
// checked too; with names only, they are accepted as before (they can only
// touch a message that was stored from an accepted group).
function isUpdateAllowed(jid) {

    const jids = allowedJids();

    return jids.length === 0 || jids.includes(String(jid || "").toLowerCase());

}


module.exports = { normalizeGroupName, allowedJids, allowedNames, isGroupAllowed, isUpdateAllowed };
