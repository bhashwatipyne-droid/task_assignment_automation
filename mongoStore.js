// ============================================================
// MONGO STORE  -  WhatsApp tasklists straight into MongoDB (no n8n)
// ============================================================
//
// Writes ONLY to these collections in the `pmt` database:
//
//   whatsapp_messages    one raw row per tasklist message (same shape the
//                        old n8n flow used)
//   tasks                one document per clean task line, in the same
//                        shape the old n8n flow used, so PMT reads it as before
//                        (lines flagged "needs review" are NOT put here)
//   (set WRITE_TASKS=false to skip the `tasks` collection)
//
// plus two detail collections:
//
//   whatsapp_tasklists   one document per tasklist message (raw text,
//                        calls, who sent it, parser version)
//   tasklist_items       one document per task line, with the resolved
//                        client / project / deliverable ids, the PMT user
//                        it is assigned to, and a review status
//
// It never touches work_items, deliverables, projects or any other
// existing collection (it only READS `users` to map assignee names).
//
// Safe by design
//   - idempotent: the same message or task line is never stored twice
//     (unique indexes + upserts), so restarts and re-deliveries are harmless
//   - nothing is lost if MongoDB is unreachable: the payload is saved to
//     ./outbox/ and retried automatically
//   - DRY_RUN=true shows exactly what would be written, writes nothing
//   - the connection string is never printed
//
// .env
//   MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster1.ahn4oou.mongodb.net/?retryWrites=true&w=majority
//   MONGODB_DB=pmt
//   DRY_RUN=true
//   WRITE_TASKS=true
// ============================================================

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");


let MongoClient = null;

try {
    ({ MongoClient } = require("mongodb"));
}
catch (error) {
    // reported in init()
}


const DB_NAME = process.env.MONGODB_DB || "pmt";

const TASKLISTS = "whatsapp_tasklists";
const ITEMS = "tasklist_items";
const MESSAGES = "whatsapp_messages";
const TASKS = "tasks";

const OUTBOX_DIR = path.join(__dirname, "outbox");

const USER_CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;


const isDryRun = () =>
    /^(1|true|yes|on)$/i.test(process.env.DRY_RUN || "");


const writeTasks = () =>
    !/^(0|false|no|off)$/i.test(process.env.WRITE_TASKS || "true");


let client = null;
let db = null;
let users = [];
let usersLoadedAt = 0;
let retryTimer = null;


// ------------------------------------------------------------
// SMALL HELPERS
// ------------------------------------------------------------

const log = (...args) => console.log("[store]", ...args);


function newId() {
    return crypto.randomUUID();
}


// YYYY-MM-DD in India time
function istDate(date = new Date()) {

    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);

}


function nowIso() {
    return new Date().toISOString();
}


function dedupeKey(workDate, assignee, rawLine) {

    const norm = (rawLine || "")
        .toLowerCase()
        .replace(/^\s*[-•·▪●–—*\d.)]+\s+/, "")
        .replace(/\s+/g, " ")
        .trim();

    return crypto
        .createHash("sha1")
        .update([workDate, (assignee || "").toLowerCase(), norm].join("|"))
        .digest("hex")
        .slice(0, 20);

}


// ------------------------------------------------------------
// CONNECT
// ------------------------------------------------------------

async function connect() {

    const uri = process.env.MONGODB_URI;

    if (!uri) {
        log("MONGODB_URI is not set.");
        return false;
    }

    if (!MongoClient) {
        log("The 'mongodb' package is not installed. Run: npm install mongodb");
        return false;
    }

    try {

        client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 8000,
            appName: "whatsapp-pmt-listener"
        });

        await client.connect();

        db = client.db(DB_NAME);

        await db.command({ ping: 1 });

        log(`Connected to MongoDB database "${DB_NAME}"`);

        return true;

    }

    catch (error) {

        // never print the URI, it contains the password
        log("Could not connect to MongoDB:", error.message);

        try { if (client) await client.close(); } catch (e) { /* ignore */ }

        client = null;
        db = null;

        return false;

    }

}


async function ensureIndexes() {

    if (!db || isDryRun()) return;

    await db.collection(TASKLISTS).createIndex(
        { message_id: 1 },
        { unique: true, name: "uniq_message_id" }
    );

    await db.collection(ITEMS).createIndex(
        { work_date: 1, assignee_name: 1, dedupe_key: 1 },
        { unique: true, name: "uniq_task_per_day" }
    );

    await db.collection(ITEMS).createIndex(
        { status: 1, work_date: -1 },
        { name: "status_date" }
    );

    await db.collection(ITEMS).createIndex(
        { assignee_user_id: 1, work_date: -1 },
        { name: "assignee_date" }
    );

    await db.collection(MESSAGES).createIndex(
        { message_id: 1 },
        { unique: true, name: "uniq_message_id" }
    );

    if (writeTasks()) {
        await db.collection(TASKS).createIndex(
            { due_date: 1, assignee: 1, dedupe_key: 1 },
            { unique: true, name: "uniq_task_per_day" }
        );
    }

}


async function init() {

    const ok = await connect();

    if (ok) {

        await ensureIndexes();

        await loadUsers(true);

        await flushOutbox();

    }

    else {

        scheduleRetry();

    }

    if (isDryRun()) {
        log("DRY_RUN is ON: nothing will be written to MongoDB.");
    }

    return ok;

}


function scheduleRetry() {

    if (retryTimer) return;

    retryTimer = setInterval(async () => {

        if (!db) {

            const ok = await connect();

            if (ok) {
                await ensureIndexes();
                await loadUsers(true);
            }

        }

        if (db) await flushOutbox();

    }, RETRY_MS);

    retryTimer.unref();

}


async function close() {

    if (retryTimer) clearInterval(retryTimer);

    try { if (client) await client.close(); } catch (e) { /* ignore */ }

}


// ------------------------------------------------------------
// PMT USERS  (assignee first name -> user id)
// ------------------------------------------------------------

async function loadUsers(force = false) {

    if (!db) return users;

    if (!force && Date.now() - usersLoadedAt < USER_CACHE_MS) {
        return users;
    }

    try {

        users = await db.collection("users")
            .find(
                { active: { $ne: false } },
                { projection: { _id: 0, id: 1, name: 1, username: 1, role: 1, department: 1 } }
            )
            .toArray();

        usersLoadedAt = Date.now();

    }

    catch (error) {
        log("Could not load PMT users:", error.message);
    }

    return users;

}


const TEAM_DEPARTMENT = {
    content: "content",
    design: "design"
};


// Maps "Harshal" + team -> one PMT user, or null with a reason.
function resolveAssignee(name, team, userList = users) {

    const first = (name || "").trim().toLowerCase().split(/\s+/)[0];

    if (!first) {
        return { user: null, reason: "No assignee name" };
    }

    const wanted = TEAM_DEPARTMENT[team] || null;

    const isTest = (u) =>
        /\btest(ing)?\b/i.test(`${u.name} ${u.username}`);

    const sameFirst = userList.filter(u =>
        !isTest(u) &&
        (u.name || "").trim().toLowerCase().split(/\s+/)[0] === first
    );

    let pool = sameFirst;

    if (wanted) {

        const inTeam = sameFirst.filter(u =>
            (u.department || "").toLowerCase() === wanted
        );

        if (inTeam.length) pool = inTeam;

    }

    if (pool.length === 1) {
        return { user: pool[0], reason: null };
    }

    if (pool.length === 0) {
        return { user: null, reason: `No PMT user found for "${name}"` };
    }

    return {
        user: null,
        reason: `More than one PMT user matches "${name}": ` +
            pool.map(u => u.name).join(" / ")
    };

}


// ------------------------------------------------------------
// BUILD DOCUMENTS  (+ validation)
// ------------------------------------------------------------

function buildDocuments(payload, userList = users) {

    const parsed = payload.parsed_tasklist || {};

    const tasks = parsed.tasks || [];

    const team = payload.team || parsed.team || null;

    const received = payload.timestamp ? new Date(payload.timestamp) : new Date();

    const workDate = istDate(received);

    const stamp = nowIso();

    const tasklist = {

        id: newId(),

        message_id: payload.message_id,

        chat_id: payload.chat_id,
        group_name: payload.group_name,

        sender_number: payload.sender_alt_number || payload.sender_number || null,

        team: team,

        work_date: workDate,

        raw_text: payload.message,

        task_count: tasks.length,

        calls: parsed.calls || [],

        warnings: parsed.warnings || [],

        parser: {
            lexicon_built_at: payload.lexicon_built_at || null,
            method: tasks.length ? tasks[0].match_method || null : null
        },

        source: "whatsapp",

        created_at: stamp

    };

    const items = [];
    const seen = new Set();
    const skipped = [];

    tasks.forEach((t, i) => {

        const key = dedupeKey(workDate, t.assignee, t.raw_line);

        // the same line twice in one message is stored once
        if (seen.has(key)) {
            skipped.push(t.raw_line);
            return;
        }

        seen.add(key);

        const reasons = (t.review_reasons || []).slice();

        const { user, reason } = resolveAssignee(t.assignee, team, userList);

        if (reason) reasons.push(reason);

        if (!t.deliverable_name && !t.project_name && !t.project_text) {
            reasons.push("Task has no usable text");
        }

        const needsReview = reasons.length > 0 || t.needs_review === true;

        items.push({

            id: newId(),

            message_id: payload.message_id,
            seq: i + 1,

            work_date: workDate,
            team: team,

            assignee_name: t.assignee,
            assignee_user_id: user ? user.id : null,
            assignee_pmt_name: user ? user.name : null,

            client_id: t.client_id || null,
            client_name: t.client_name || null,

            project_id: t.project_id || null,
            project_name: t.project_name || null,
            project_text: t.project_text || null,

            deliverable_name: t.deliverable_name || null,
            db_deliverable: t.db_deliverable || null,

            action: t.action || null,
            notes: t.notes || null,
            slot: t.slot || null,
            priority: t.priority || null,

            confidence: t.confidence || null,
            client_source: t.client_source || null,
            alternatives: t.alternatives || [],

            needs_review: needsReview,
            review_reasons: Array.from(new Set(reasons)),

            status: needsReview ? "needs_review" : "pending",

            raw_line: t.raw_line,
            dedupe_key: key,

            source: "whatsapp",

            created_at: stamp,
            updated_at: stamp

        });

    });

    const message = {
        message_id: payload.message_id,
        chat_id: payload.chat_id,
        group_name: payload.group_name,
        sender: payload.sender || "MANAGER",
        from_manager: payload.from_manager === true,
        is_group: payload.is_group === true,
        message: payload.message,
        received_at: stamp,
        processing_status: "Processed"
    };

    const cap = (v) =>
        v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : "";

    // PMT `tasks` rows: clean lines only (flagged lines stay in tasklist_items)
    const tasksDocs = items
        .filter(i => !i.needs_review)
        .map(i => {

            const d = i.db_deliverable;

            const notes = [
                i.notes,
                i.slot ? `Slot: ${i.slot}` : null,
                `Match status: ${i.client_id && i.project_id ? "Matched" : "Partial"}`,
                `Source line: ${i.raw_line}`
            ].filter(Boolean).join(" | ");

            return {
                task_code: `WA-${i.message_id}-${i.seq}`,
                due_date: i.work_date,
                department: cap(i.team),
                assignee: i.assignee_pmt_name || i.assignee_name,
                assignee_user_id: i.assignee_user_id,
                client: i.client_name || "",
                project: i.project_name || i.project_text || "",
                task: i.deliverable_name || i.project_text || i.project_name || "",
                format: i.action || "",
                priority: i.priority ? cap(String(i.priority)) : "Normal",
                status: "Pending",
                notes: notes,
                created_by: "WhatsApp Manager",
                notification_status: "Not Sent",
                source_message_id: i.message_id,
                client_id: i.client_id || null,
                project_id: i.project_id || null,
                deliverable_id: (d && typeof d === "object" && (d.id || d.deliverable_id)) || null,
                dedupe_key: i.dedupe_key,
                created_at: stamp
            };
        });

    return { tasklist, items, skipped, workDate, message, tasksDocs };

}


// ------------------------------------------------------------
// OUTBOX  (nothing is lost while MongoDB is unreachable)
// ------------------------------------------------------------

function writeOutbox(payload) {

    try {

        fs.mkdirSync(OUTBOX_DIR, { recursive: true });

        const file = path.join(
            OUTBOX_DIR,
            `${(payload.message_id || newId()).replace(/[^\w-]/g, "_")}.json`
        );

        fs.writeFileSync(file, JSON.stringify(payload));

        log(`Saved to ${file}. It will be retried automatically.`);

        return true;

    }

    catch (error) {
        log("Could not write outbox file:", error.message);
        return false;
    }

}


async function flushOutbox() {

    if (!db || isDryRun() || !fs.existsSync(OUTBOX_DIR)) return;

    const files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith(".json"));

    for (const file of files) {

        const full = path.join(OUTBOX_DIR, file);

        try {

            const payload = JSON.parse(fs.readFileSync(full, "utf8"));

            await persist(payload);

            fs.unlinkSync(full);

            log(`Outbox: stored ${file}`);

        }

        catch (error) {
            log(`Outbox: ${file} still failing (${error.message})`);
        }

    }

}


// ------------------------------------------------------------
// WRITE
// ------------------------------------------------------------

async function persist(payload) {

    await loadUsers();

    const { tasklist, items, skipped, workDate, message, tasksDocs } = buildDocuments(payload);

    // 0. raw message row
    await db.collection(MESSAGES).updateOne(
        { message_id: message.message_id },
        { $setOnInsert: message },
        { upsert: true }
    );

    // 1. the message
    const messageResult = await db.collection(TASKLISTS).updateOne(
        { message_id: tasklist.message_id },
        { $setOnInsert: tasklist },
        { upsert: true }
    );

    // 2. every task (existing ones are left exactly as they are)
    let inserted = 0;

    if (items.length) {

        const ops = items.map(doc => ({
            updateOne: {
                filter: {
                    work_date: doc.work_date,
                    assignee_name: doc.assignee_name,
                    dedupe_key: doc.dedupe_key
                },
                update: { $setOnInsert: doc },
                upsert: true
            }
        }));

        const result = await db.collection(ITEMS).bulkWrite(ops, { ordered: false });

        inserted = result.upsertedCount || 0;

    }

    // 3. PMT `tasks` (clean lines only)
    let tasksInserted = 0;

    if (writeTasks() && tasksDocs.length) {

        const result = await db.collection(TASKS).bulkWrite(
            tasksDocs.map(doc => ({
                updateOne: {
                    filter: { due_date: doc.due_date, assignee: doc.assignee, dedupe_key: doc.dedupe_key },
                    update: { $setOnInsert: doc },
                    upsert: true
                }
            })),
            { ordered: false }
        );

        tasksInserted = result.upsertedCount || 0;

    }

    return {
        pmt_tasks_inserted: tasksInserted,
        message_new: (messageResult.upsertedCount || 0) > 0,
        tasks_in_message: items.length,
        tasks_inserted: inserted,
        tasks_already_stored: items.length - inserted,
        duplicate_lines_skipped: skipped.length,
        needs_review: items.filter(i => i.needs_review).length,
        work_date: workDate
    };

}


async function saveTasklist(payload) {

    // ---- dry run: show, do not write -----------------------
    if (isDryRun()) {

        await loadUsers();

        const { tasklist, items, skipped, tasksDocs } = buildDocuments(payload);

        log("DRY RUN, would write:");
        log(`  ${MESSAGES}: 1 row;  ${TASKS}: ${writeTasks() ? tasksDocs.length : 0} documents (clean lines only)`);
        log(`  ${TASKLISTS}: 1 document (message ${tasklist.message_id}, ${tasklist.task_count} tasks, ${tasklist.calls.length} calls)`);
        log(`  ${ITEMS}: ${items.length} documents (${items.filter(i => i.needs_review).length} need review, ${skipped.length} duplicate lines skipped)`);

        items.forEach(i => {
            log(
                `   - ${i.assignee_name.padEnd(9)} -> ${(i.assignee_pmt_name || "UNMAPPED").padEnd(18)} | ` +
                `${(i.client_name || "?").slice(0, 22).padEnd(22)} | ` +
                `${(i.project_name || "-").slice(0, 34).padEnd(34)} | ` +
                `${(i.deliverable_name || "-").slice(0, 30).padEnd(30)} | ${i.status}`
            );
        });

        return { dry_run: true, tasks_in_message: items.length };

    }

    // ---- real write ----------------------------------------
    if (!db) {

        const ok = await connect();

        if (ok) {
            await ensureIndexes();
            await loadUsers(true);
        }

    }

    if (!db) {

        writeOutbox(payload);

        scheduleRetry();

        return { stored: false, queued_in_outbox: true };

    }

    try {

        const summary = await persist(payload);

        log(
            `Stored ${summary.tasks_inserted} new task(s), ${summary.pmt_tasks_inserted} into PMT tasks` +
            (summary.tasks_already_stored ? `, ${summary.tasks_already_stored} already stored` : "") +
            `, ${summary.needs_review} need review (work date ${summary.work_date})`
        );

        return { stored: true, ...summary };

    }

    catch (error) {

        log("Write failed:", error.message);

        writeOutbox(payload);

        scheduleRetry();

        return { stored: false, queued_in_outbox: true, error: error.message };

    }

}


// test hook: lets tests inject a fake database
function _useDatabaseForTest(fakeDb, userList) {
    db = fakeDb;
    users = userList || [];
    usersLoadedAt = Date.now();
}


module.exports = {
    init,
    close,
    saveTasklist,
    buildDocuments,
    resolveAssignee,
    istDate,
    flushOutbox,
    _useDatabaseForTest
};
