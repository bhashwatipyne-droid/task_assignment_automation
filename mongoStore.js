// ============================================================
// MONGO STORE  -  WhatsApp tasklists straight into MongoDB (no n8n)
// ============================================================
//
// Writes ONLY to these collections in the `pmt` database:
//
//   whatsapp_messages    one raw row per tasklist message
//   whatsapp_tasklists   one document per tasklist message (raw text,
//                        calls, who sent it, parser version)
//   tasklist_items       one document per task line. THIS is the record the
//                        PMT backend (backend/planning.py) reads: resolved
//                        client / project / deliverable ids, the PMT user it is
//                        assigned to, who assigned it, and its life cycle:
//
//                          needs_review -> (manager resolves) -> pending
//                          pending      -> accepted | declined   (by assignee)
//                          needs_review -> rejected              (by manager)
//
//   nlp_match_logs       one document per task line: the NLP scores, the
//                        runners-up, the margin between #1 and #2, the
//                        decision taken and why. For observability only.
//
//   tasks                legacy flat rows from the old n8n flow. Nothing in PMT
//                        reads them, so they are OFF unless WRITE_TASKS=true.
//
// It only READS `users`, `clients`, `projects` and `deliverables` (to map
// assignee names and to re-check every matched id against the live data). It
// never writes to work_items or any other existing collection.
//
// A line is only queued (`pending`) when everything is certain. It goes to
// `needs_review` instead when
//   - the matcher flagged it (tie between clients, ambiguous project, weak
//     match, unknown project ...)
//   - two deliverables score almost the same
//   - the assignee name matches no PMT user, or more than one
//   - a matched id no longer exists / is hidden / was merged, or the project
//     does not belong to the matched client (the lexicon is a snapshot)
//
// Safe by design
//   - idempotent: the same message or task line is never stored twice
//     (unique indexes + upserts), so restarts and re-deliveries are harmless;
//     an existing line is never overwritten, so an accepted task stays accepted
//   - nothing is lost if MongoDB is unreachable: the payload is saved to
//     ./outbox/ and retried automatically
//   - DRY_RUN=true shows exactly what would be written, writes nothing
//   - the connection string is never printed
//
// .env
//   MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster1.ahn4oou.mongodb.net/?retryWrites=true&w=majority
//   MONGODB_DB=pmt
//   DRY_RUN=true
//   MANAGER_MAP=9198xxxxxx=Vanshika Shah,9199xxxxxx=Sakshi Agrawal   (optional)
//   WRITE_TASKS=false          (legacy flat `tasks` rows, off by default)
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
const LOGS = "nlp_match_logs";

const OUTBOX_DIR = path.join(__dirname, "outbox");

const USER_CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

// Two deliverables closer than this are a coin flip: send to review.
// (The matcher already does the same for projects, at 0.15.)
const DELIVERABLE_AMBIGUITY_MARGIN = 0.10;

// A tasklist is a day plan: due at the end of the working day (India time).
const DUE_TIME_IST = "18:00:00+05:30";

// Accounts that can never do production work, so never an assignee.
const NON_ASSIGNEE_ROLES = new Set(["admin", "hr"]);


const isDryRun = () =>
    /^(1|true|yes|on)$/i.test(process.env.DRY_RUN || "");


// Legacy flat `tasks` rows: opt in only.
const writeTasks = () =>
    /^(1|true|yes|on)$/i.test(process.env.WRITE_TASKS || "");


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


const cap = (v) =>
    v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : "";


const uniq = (list) =>
    Array.from(new Set(list.filter(Boolean)));


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

    // the PMT task card asks "what is pending for this person?"
    await db.collection(ITEMS).createIndex(
        { assignee_user_id: 1, status: 1 },
        { name: "assignee_status" }
    );

    await db.collection(MESSAGES).createIndex(
        { message_id: 1 },
        { unique: true, name: "uniq_message_id" }
    );

    // one log row per task line of a message
    await db.collection(LOGS).createIndex(
        { message_id: 1, seq: 1 },
        { unique: true, name: "uniq_message_line" }
    );

    await db.collection(LOGS).createIndex(
        { decision: 1, created_at: -1 },
        { name: "decision_date" }
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
        !NON_ASSIGNEE_ROLES.has((u.role || "").toLowerCase()) &&
        (u.name || "").trim().toLowerCase().split(/\s+/)[0] === first
    );

    let pool = sameFirst;

    if (wanted) {

        const inTeam = sameFirst.filter(u =>
            (u.department || "").toLowerCase() === wanted
        );

        if (inTeam.length) {
            pool = inTeam;
        }

        // The name exists, but only in another department. Guessing across
        // teams would hand the task to the wrong person: a human decides.
        else if (sameFirst.length) {
            return {
                user: null,
                reason: `"${name}" is not in the ${cap(team)} team in PMT (found: ` +
                    sameFirst.map(u => `${u.name}, ${u.department}`).join(" / ") + ")"
            };
        }

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
// WHO SENT THE TASKLIST  (shown on the task card as "from")
// ------------------------------------------------------------
//
// MANAGER_MAP=<phone>=<PMT user name>,...   (last 10 digits are compared)
// Without a mapping the card says "<Team> team manager".

function managerMap() {

    const map = new Map();

    (process.env.MANAGER_MAP || "").split(",").forEach(pair => {

        const at = pair.indexOf("=");

        if (at < 1) return;

        const digits = pair.slice(0, at).replace(/\D/g, "").slice(-10);
        const name = pair.slice(at + 1).trim();

        if (digits && name) map.set(digits, name);

    });

    return map;

}


function resolveAssigner(payload, team, userList = users) {

    const map = managerMap();

    const numbers = [payload.sender_alt_number, payload.sender_number]
        .filter(Boolean)
        .map(n => String(n).replace(/\D/g, "").slice(-10));

    let mapped = null;

    for (const n of numbers) {
        if (map.has(n)) { mapped = map.get(n); break; }
    }

    let user = null;

    if (mapped) {

        const hits = userList.filter(u =>
            (u.name || "").trim().toLowerCase() === mapped.toLowerCase()
        );

        if (hits.length === 1) user = hits[0];

    }

    if (user) {
        return {
            assigned_by_user_id: user.id,
            assigned_by_name: user.name,
            assigned_by_role: [user.department, user.role].filter(Boolean).join(" ").trim()
        };
    }

    return {
        assigned_by_user_id: null,
        assigned_by_name: mapped || (team ? `${cap(team)} team manager` : "Manager (WhatsApp)"),
        assigned_by_role: team ? `${cap(team)} team` : "WhatsApp tasklist"
    };

}


// ------------------------------------------------------------
// RE-CHECK THE MATCH AGAINST THE LIVE DATA
// ------------------------------------------------------------
//
// The matcher works from lexicon.json, a snapshot. A project can be merged,
// hidden or deleted after the snapshot was built, and a stale id must never
// reach a worksheet.

async function loadReferences(tasks) {

    if (!db) return null;

    const clientIds = uniq(tasks.map(t => t.client_id));
    const projectIds = uniq(tasks.map(t => t.project_id));
    const deliverableIds = uniq(tasks.map(t => t.db_deliverable_id));

    const fetchBy = (name, ids, projection) =>
        ids.length
            ? db.collection(name)
                .find({ id: { $in: ids } }, { projection: { _id: 0, ...projection } })
                .toArray()
            : Promise.resolve([]);

    const [clients, projects, deliverables] = await Promise.all([
        fetchBy("clients", clientIds, { id: 1, name: 1 }),
        fetchBy("projects", projectIds, { id: 1, name: 1, client_id: 1, hidden: 1, duplicate_of: 1 }),
        fetchBy("deliverables", deliverableIds, { id: 1, name: 1, project_id: 1 })
    ]);

    return {
        clients: new Map(clients.map(c => [c.id, c])),
        projects: new Map(projects.map(p => [p.id, p])),
        deliverables: new Map(deliverables.map(d => [d.id, d]))
    };

}


// -> { checked, problems: [text], cleared: { client_id, project_id, deliverable_id } }
function validateRefs(t, refs) {

    const problems = [];
    const cleared = {};

    if (!refs) {
        return { checked: false, problems, cleared };
    }

    if (t.client_id && !refs.clients.has(t.client_id)) {
        problems.push(`Client "${t.client_name || t.client_id}" no longer exists in PMT`);
        cleared.client_id = true;
    }

    if (t.project_id) {

        const project = refs.projects.get(t.project_id);

        if (!project) {
            problems.push(`Project "${t.project_name}" (${t.project_id}) no longer exists in PMT`);
            cleared.project_id = true;
        }

        else if (project.hidden) {
            problems.push(`Project "${project.name}" is hidden in PMT`);
            cleared.project_id = true;
        }

        else if (project.duplicate_of) {
            problems.push(`Project "${project.name}" was merged into another project`);
            cleared.project_id = true;
        }

        else if (t.client_id && project.client_id && project.client_id !== t.client_id) {
            problems.push(`Project "${project.name}" belongs to a different client than the one matched`);
            cleared.project_id = true;
        }

    }

    if (t.db_deliverable_id) {

        const d = refs.deliverables.get(t.db_deliverable_id);

        if (!d) {
            problems.push(`Deliverable "${t.db_deliverable}" no longer exists in PMT`);
            cleared.deliverable_id = true;
        }

        else if (t.project_id && !cleared.project_id && d.project_id !== t.project_id) {
            problems.push(`Deliverable "${d.name}" belongs to a different project than the one matched`);
            cleared.deliverable_id = true;
        }

    }

    // a deliverable only means something under its project
    if (cleared.project_id) cleared.deliverable_id = true;

    return { checked: true, problems, cleared };

}


// Gap between the best and second-best score, or null with fewer than two.
function margin(alts) {

    if (!Array.isArray(alts) || alts.length < 2) return null;

    return Number((alts[0].score - alts[1].score).toFixed(3));

}


// ------------------------------------------------------------
// BUILD DOCUMENTS  (+ validation)
// ------------------------------------------------------------

function buildDocuments(payload, userList = users, refs = null) {

    const parsed = payload.parsed_tasklist || {};

    const tasks = parsed.tasks || [];

    const team = payload.team || parsed.team || null;

    const received = payload.timestamp ? new Date(payload.timestamp) : new Date();

    const workDate = istDate(received);

    const stamp = nowIso();

    const assigner = resolveAssigner(payload, team, userList);

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
    const logs = [];
    const seen = new Set();
    const skipped = [];

    tasks.forEach((t, i) => {

        const key = dedupeKey(workDate, t.assignee, t.raw_line);

        const baseLog = {
            message_id: payload.message_id,
            seq: i + 1,
            work_date: workDate,
            team: team,
            raw_line: t.raw_line,
            assignee_name: t.assignee,
            dedupe_key: key,
            match_method: t.match_method || null,
            lexicon_built_at: payload.lexicon_built_at || null,
            created_at: stamp
        };

        // the same line twice in one message is stored once
        if (seen.has(key)) {

            skipped.push(t.raw_line);

            logs.push({
                id: newId(),
                ...baseLog,
                decision: "duplicate_line",
                review_reasons: [],
                validation_problems: []
            });

            return;
        }

        seen.add(key);

        const reasons = (t.review_reasons || []).slice();

        // ---- assignee ----------------------------------------
        const { user, reason } = resolveAssignee(t.assignee, team, userList);

        if (reason) reasons.push(reason);

        // ---- match re-checked against the live data -----------
        const check = validateRefs(t, refs);

        check.problems.forEach(p => reasons.push(p));

        const clientId = check.cleared.client_id ? null : (t.client_id || null);
        const projectId = check.cleared.project_id ? null : (t.project_id || null);
        const deliverableId = check.cleared.deliverable_id ? null : (t.db_deliverable_id || null);

        // ---- deliverable tie (the matcher does not check this) ----
        const dAlts = t.deliverable_alternatives || [];

        if (
            deliverableId &&
            dAlts.length > 1 &&
            dAlts[0].id === t.db_deliverable_id &&
            dAlts[0].score - dAlts[1].score < DELIVERABLE_AMBIGUITY_MARGIN
        ) {
            reasons.push(
                `Ambiguous deliverable: "${dAlts[0].deliverable}" / "${dAlts[1].deliverable}"`
            );
        }

        if (!t.deliverable_name && !t.project_name && !t.project_text) {
            reasons.push("Task has no usable text");
        }

        // never queue a task whose client or project is not confirmed
        if (!clientId || !projectId) {
            reasons.push("Client or project is not confirmed");
        }

        const needsReview = reasons.length > 0 || t.needs_review === true;

        const finalReasons = Array.from(new Set(reasons));

        items.push({

            id: newId(),

            message_id: payload.message_id,
            seq: i + 1,

            work_date: workDate,
            team: team,

            assignee_name: t.assignee,
            assignee_user_id: user ? user.id : null,
            assignee_pmt_name: user ? user.name : null,

            ...assigner,

            client_id: clientId,
            client_name: t.client_name || null,

            project_id: projectId,
            project_name: t.project_name || null,
            project_text: t.project_text || null,

            deliverable_name: t.deliverable_name || null,
            db_deliverable: t.db_deliverable || null,
            deliverable_id: deliverableId,

            action: t.action || null,
            notes: t.notes || null,
            slot: t.slot || null,
            priority: t.priority || null,

            // plan data. The tasklist has no estimate or quantity: the PMT
            // backend shows its default estimate until a person sets one.
            due_at: `${workDate}T${DUE_TIME_IST}`,
            est_minutes: null,

            confidence: t.confidence || null,
            client_source: t.client_source || null,
            alternatives: t.alternatives || [],

            // what the matcher said before the live re-check
            nlp_ids: {
                client_id: t.client_id || null,
                project_id: t.project_id || null,
                deliverable_id: t.db_deliverable_id || null
            },

            needs_review: needsReview,
            review_reasons: finalReasons,

            status: needsReview ? "needs_review" : "pending",

            // life cycle (filled by the PMT backend)
            work_item_id: null,
            accepted_at: null,
            declined_at: null,
            decline_reason: null,
            questions: [],
            history: [{
                at: stamp,
                by: "system",
                action: needsReview ? "flagged" : "queued",
                detail: finalReasons.join("; ")
            }],

            raw_line: t.raw_line,
            dedupe_key: key,

            source: "whatsapp",

            created_at: stamp,
            updated_at: stamp

        });

        logs.push({
            id: newId(),
            ...baseLog,
            decision: needsReview ? "needs_review" : "queued",
            client_name: t.client_name || null,
            project_name: t.project_name || null,
            deliverable_name: t.deliverable_name || null,
            matched: {
                client_id: clientId,
                project_id: projectId,
                deliverable_id: deliverableId
            },
            // the matcher's own numbers: confidence per field, the raw
            // scoring behind them, and the runners-up. The matcher gives
            // scores, not statistical intervals; the margin between #1 and #2
            // is the uncertainty signal.
            scores: {
                client: t.confidence ? t.confidence.client : null,
                project: t.confidence ? t.confidence.project : null,
                deliverable: t.confidence ? t.confidence.deliverable : null,
                project_detail: t.scores ? t.scores.project : null,
                deliverable_detail: t.scores ? t.scores.deliverable : null
            },
            margin: {
                project: margin(t.alternatives),
                deliverable: margin(dAlts)
            },
            alternatives: {
                projects: t.alternatives || [],
                deliverables: dAlts
            },
            client_source: t.client_source || null,
            assignee_resolved: !!user,
            review_reasons: finalReasons,
            validation_checked: check.checked,
            validation_problems: check.problems
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

    // Legacy flat `tasks` rows (WRITE_TASKS=true only): clean lines only
    const tasksDocs = items
        .filter(i => !i.needs_review)
        .map(i => {

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
                deliverable_id: i.deliverable_id || null,
                dedupe_key: i.dedupe_key,
                created_at: stamp
            };
        });

    return { tasklist, items, logs, skipped, workDate, message, tasksDocs };

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

    const refs = await loadReferences((payload.parsed_tasklist || {}).tasks || []);

    const { tasklist, items, logs, skipped, workDate, message, tasksDocs } =
        buildDocuments(payload, users, refs);

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

    // 3. the NLP log (first decision is kept; a re-delivery only counts up)
    let logged = 0;

    if (logs.length) {

        const stamp = nowIso();

        const result = await db.collection(LOGS).bulkWrite(
            logs.map(doc => ({
                updateOne: {
                    filter: { message_id: doc.message_id, seq: doc.seq },
                    update: {
                        $setOnInsert: doc,
                        $set: { last_seen_at: stamp },
                        $inc: { seen_count: 1 }
                    },
                    upsert: true
                }
            })),
            { ordered: false }
        );

        logged = result.upsertedCount || 0;

    }

    // 4. legacy flat `tasks` (WRITE_TASKS=true only)
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
        legacy_tasks_inserted: tasksInserted,
        message_new: (messageResult.upsertedCount || 0) > 0,
        tasks_in_message: items.length,
        tasks_inserted: inserted,
        tasks_already_stored: items.length - inserted,
        duplicate_lines_skipped: skipped.length,
        logs_inserted: logged,
        needs_review: items.filter(i => i.needs_review).length,
        queued: items.filter(i => !i.needs_review).length,
        work_date: workDate
    };

}


async function saveTasklist(payload) {

    // ---- dry run: show, do not write -----------------------
    if (isDryRun()) {

        await loadUsers();

        let refs = null;

        try {
            refs = await loadReferences((payload.parsed_tasklist || {}).tasks || []);
        }
        catch (error) {
            log("Dry run: could not re-check ids against PMT:", error.message);
        }

        const { tasklist, items, skipped, logs } = buildDocuments(payload, users, refs);

        log("DRY RUN, would write:");
        log(`  ${MESSAGES}: 1 row`);
        log(`  ${TASKLISTS}: 1 document (message ${tasklist.message_id}, ${tasklist.task_count} tasks, ${tasklist.calls.length} calls)`);
        log(`  ${ITEMS}: ${items.length} documents (${items.filter(i => i.needs_review).length} need review, ${skipped.length} duplicate lines skipped)`);
        log(`  ${LOGS}: ${logs.length} documents` + (refs ? "" : "  (ids NOT re-checked: no database connection)"));

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
            `Stored ${summary.tasks_inserted} new task(s)` +
            (summary.tasks_already_stored ? `, ${summary.tasks_already_stored} already stored` : "") +
            `, ${summary.queued} queued for the assignee, ${summary.needs_review} need review (work date ${summary.work_date})`
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


// test hooks: let tests inject a fake database
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
    resolveAssigner,
    validateRefs,
    loadReferences,
    istDate,
    flushOutbox,
    persist,
    _useDatabaseForTest
};
