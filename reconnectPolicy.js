"use strict";

// ============================================================
// WHEN TO RECONNECT TO WHATSAPP
// ============================================================
//
// A deploy starts the new copy of the listener while the old copy is still
// running (Render stops the old one about two minutes later). Both use the
// same WhatsApp login, so each connect makes WhatsApp close the other with
// status 440 "connection replaced". If the closed copy reconnects after 30
// seconds it replaces the new copy, which reconnects, and the two keep taking
// the login from each other until the old one is stopped.
//
// A copy that was replaced therefore waits a long time before it tries again,
// and longer after each repeat. A deploy ends the old copy long before that, so
// the new copy keeps the login; a person who left another copy running is told
// by the log line and the service takes the login back on its own once that
// copy is stopped.

const REPLACED = 440;

const BACKOFF_START_MS = 3000;
const BACKOFF_MAX_MS = 60000;

const REPLACED_WAIT_MS = 5 * 60 * 1000;
const REPLACED_WAIT_MAX_MS = 30 * 60 * 1000;

// a connection that stayed open this long was a real session, not a fight
const STABLE_MS = 2 * 60 * 1000;


// attempts: failed attempts in a row (0 after a connection opened)
// replacedStreak: times in a row the login was taken by another copy
function reconnectDelay(statusCode, attempts = 0, replacedStreak = 0) {

    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** attempts);

    if (statusCode !== REPLACED) return backoff;

    const wait = Math.min(
        REPLACED_WAIT_MAX_MS,
        REPLACED_WAIT_MS * 2 ** Math.max(0, replacedStreak - 1)
    );

    return Math.max(backoff, wait);

}


// the streak of "replaced" closes after one more close
function nextReplacedStreak(streak, statusCode, openForMs) {

    let next = openForMs > STABLE_MS ? 0 : streak;

    if (statusCode === REPLACED) next += 1;

    return next;

}


module.exports = {
    REPLACED,
    STABLE_MS,
    reconnectDelay,
    nextReplacedStreak
};
