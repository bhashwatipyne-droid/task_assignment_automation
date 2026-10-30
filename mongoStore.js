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

const matcher = require("./tasklistMatcher");
const learned = require("./learned");
const { buildLexicon } = require("./lexiconBuilder");


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
// Tasks nobody has acted on yet. Only these can be withdrawn or re-teamed.
const WAITING_STATUSES = ["needs_review", "pending"];
const MESSAGES = "whatsapp_messages";
const TASKS = "tasks";
const LOGS = "nlp_match_logs";

// OUTBOX_DIR can point at a persistent disk so queued payloads survive a redeploy
const OUTBOX_DIR = process.env.OUTBOX_DIR
    ? path.resolve(process.env.OUTBOX_DIR)
    : path.join(__dirname, "outbox");

// A payload that keeps failing for a reason other than MongoDB being down is
// moved to outbox/failed after this many attempts, so it stops being retried
// forever and is easy to find.
const OUTBOX_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 10;
const outboxFailures = new Map();

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


function dedupeKey(workDate, assignee, rawLine, copyIndex, copyTotal, dupIndex) {

    const norm = (rawLine || "")
        .toLowerCase()
        .replace(/^\s*[-•·▪●–—*\d.)]+\s+/, "")
        .replace(/\s+/g, " ")
        .trim();

    // "2 Minimalist" is two tasks with identical text: the copy number keeps
    // them apart. A normal line (no copies) hashes exactly as before.
    const parts = [workDate, (assignee || "").toLowerCase(), norm];

    if (copyTotal > 1) parts.push(`#${copyIndex}`);

    // the same text from a DIFFERENT line of the message (2nd, 3rd...);
    // the first one keeps the plain key, so a re-sent message never duplicates it
    if (dupIndex > 1) parts.push(`dup${dupIndex}`);

    return crypto
        .createHash("sha1")
        .update(parts.join("|"))
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


// ------------------------------------------------------------
// LEXICON  (what the matcher scores task lines against)
// lexicon.json is only the starting point: projects and deliverables are
// renamed, moved and merged in PMT every day, and a snapshot of last week
// flags good lines ("deliverable belongs to a different project", "project
// no longer exists"). So the matcher is rebuilt from the live database, at
// start-up and before a tasklist is read once the copy is older than
// LEXICON_MAX_AGE_MS (5 minutes by default).
// ------------------------------------------------------------

const LEXICON_MAX_AGE_MS = Number(process.env.LEXICON_MAX_AGE_MS) || 5 * 60 * 1000;

let lexiconRefreshedAt = 0;


async function refreshLexicon(force = false) {

    if (!db) return false;

    if (!force && Date.now() - lexiconRefreshedAt < LEXICON_MAX_AGE_MS) {
        return false;
    }

    try {

        const [projects, deliverables, clients] = await Promise.all([
            db.collection("projects").find(
                {},
                { projection: { _id: 0, id: 1, name: 1, client_id: 1, status: 1, hidden: 1, duplicate_of: 1, start_date: 1, end_date: 1, created_at: 1, updated_at: 1 } }
            ).toArray(),
            db.collection("deliverables").find(
                {},
                { projection: { _id: 0, id: 1, name: 1, project_id: 1, type: 1, start_dt: 1, end_dt: 1, created_at: 1, updated_at: 1 } }
            ).toArray(),
            db.collection("clients").find({}, { projection: { _id: 0, id: 1, name: 1 } }).toArray()
        ]);

        // never replace a good lexicon with one built from an empty read
        if (!projects.length || !clients.length) {
            log("Lexicon not rebuilt: the database returned no projects or clients.");
            return false;
        }

        const lexicon = buildLexicon(projects, deliverables, clients);

        matcher.useLexicon(lexicon);

        // what the managers' earlier decisions taught (learned.js); never blocks the rebuild
        matcher.useLearned(await learned.loadFromDb(db, log));

        lexiconRefreshedAt = Date.now();

        log(
            `Lexicon rebuilt from live PMT data: ${lexicon.stats.live_projects} projects, ` +
            `${lexicon.stats.deliverables} deliverables, ${lexicon.stats.clients} clients.`
        );

        return true;

    }

    catch (error) {
        log("Could not rebuild the lexicon from PMT, keeping the previous one:", error.message);
        return false;
    }

}


// What managers decided (held items resolved, Planning card edits, Work Sheet row
// edits) becomes rules in nlp_learned_rules. That used to happen only at start-up
// and when the next tasklist arrived, so a decision did not show in PMT's
// "Learned from your decisions" list until then. This is the cheap part of
// refreshLexicon on its own, run on a timer.
const LEARNED_REFRESH_MS = Number(process.env.LEARNED_REFRESH_MS) || 2 * 60 * 1000;
let learnedTimer = null;

async function refreshLearned() {
    if (!db) return false;
    const lookups = await learned.loadFromDb(db, log); // never throws
    if (!lookups) return false;
    matcher.useLearned(lookups);
    return true;
}

function startLearnedRefresh() {
    if (learnedTimer || LEARNED_REFRESH_MS <= 0) return;
    learnedTimer = setInterval(() => { refreshLearned().catch(() => {}); }, LEARNED_REFRESH_MS);
    if (learnedTimer.unref) learnedTimer.unref();
}


const TEAM_DEPARTMENT = {
    content: "content",
    design: "design",
    animation: "animation"
};


const normName = (v) => (v || "").trim().toLowerCase().replace(/\s+/g, " ");

const firstName = (v) => normName(v).split(" ")[0];

const isTestAccount = (u) =>
    /\btest(ing)?\b/i.test(`${u.name} ${u.username}`);

const assignable = (u) =>
    !NON_ASSIGNEE_ROLES.has((u.role || "").toLowerCase());


// Every spelling a tasklist may use for a PMT user, for the parser's
// assignee list: first name (real accounts only, so "Ratnesh" is never
// ambiguous), full name and username (test accounts included, so
// "Bhashwati Testing" is recognised as one person).
function assigneeNames(userList = users) {

    const out = new Set();

    userList.filter(assignable).forEach(u => {

        if (u.name) out.add(u.name.trim());
        if (u.username) out.add(u.username.trim());

        if (!isTestAccount(u) && u.name) {
            out.add(u.name.trim().split(/\s+/)[0]);
        }

    });

    return [...out];

}


// Maps "Harshal" / "Bhashwati Testing" + team -> one PMT user, or null
// with a reason. A full name or username is exact and wins; a bare first
// name prefers real accounts and falls back to a test account only when
// no real one shares the name.
function resolveAssignee(name, team, userList = users) {

    const wantedName = normName(name);
    const first = firstName(name);

    if (!first) {
        return { user: null, reason: "No assignee name" };
    }

    const wanted = TEAM_DEPARTMENT[team] || null;

    const candidates = userList.filter(assignable);

    // ---- 1. exact full name / username ----
    let exact = candidates.filter(u =>
        normName(u.name) === wantedName || normName(u.username) === wantedName
    );

    // ---- 2. first name only ----
    let pool = exact;

    if (!pool.length && !wantedName.includes(" ")) {

        const sameFirst = candidates.filter(u => firstName(u.name) === first);
        const real = sameFirst.filter(u => !isTestAccount(u));

        pool = real.length ? real : sameFirst;

    }

    if (wanted && pool.length) {

        const inTeam = pool.filter(u =>
            (u.department || "").toLowerCase() === wanted
        );

        if (inTeam.length) {
            pool = inTeam;
        }

        // The name exists, but only in another department. Guessing across
        // teams would hand the task to the wrong person: a human decides.
        else {
            return {
                user: null,
                team_mismatch: true,
                found_departments: Array.from(new Set(pool.map(u => u.department).filter(Boolean))),
                reason: `"${name}" is not in the ${cap(team)} team in PMT (found: ` +
                    pool.map(u => `${u.name}, ${u.department}`).join(" / ") + ")"
            };
        }

    }

    if (pool.length === 1) {
        return { user: pool[0], reason: null };
    }

    if (pool.length === 0) {
        // a line under a "Team" heading names nobody: the manager picks who in PMT
        if (/^team$/i.test(String(name).trim())) {
            return { user: null, reason: `No one is named: the line is under a "Team" heading. Choose who it is for` };
        }
        return { user: null, reason: `No PMT user found for "${name}"` };
    }

    return {
        user: null,
        reason: `More than one PMT user matches "${name}": ` +
            pool.map(u => u.name).join(" / ")
    };

}


// A line under a "Team" heading is a task for the whole team: the manager who
// posted the list owns it and everyone else in that team is a collaborator
// (PMT tags them on the owner's Work Sheet row once it is accepted). Needs the
// poster to be known (MANAGER_MAP); without it the line is held and a manager
// picks the owner in PMT.
const isTeamLine = (name) => /^team$/i.test(String(name || "").trim());

function wholeTeam(assigner, team, userList = users) {

    const dept = TEAM_DEPARTMENT[team];

    if (!dept || !assigner || !assigner.assigned_by_user_id) return null;

    const sameTeam = (u) => (u.department || "").toLowerCase() === dept;

    const owner = userList.find(u => u.id === assigner.assigned_by_user_id);

    if (!owner || !assignable(owner) || !sameTeam(owner)) return null;

    const collaborators = userList
        .filter(u => u.id !== owner.id && assignable(u) && sameTeam(u) && !isTestAccount(u))
        .map(u => u.id);

    return { owner, collaborators };

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

    // an edited message keeps the day of the message it replaces
    const workDate = payload.work_date_override || istDate(received);

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

        const key = dedupeKey(workDate, t.assignee, t.raw_line, t.copy_index, t.copy_total, t.dup_index);

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
        let { user, reason, team_mismatch, found_departments } =
            resolveAssignee(t.assignee, team, userList);

        // "Team" heading: the poster owns it, the rest of the team collaborate
        let collaborators = [];

        const everyone = !user && isTeamLine(t.assignee) ? wholeTeam(assigner, team, userList) : null;

        if (everyone) {
            user = everyone.owner;
            reason = null;
            collaborators = everyone.collaborators;
        }

        if (reason) reasons.push(reason);

        // A person from the other team in a tasklist is usually a wrong header
        // (e.g. "Content tasklist" typed above a Design list). PMT shows a task
        // only to its own team, so say so loudly instead of failing silently.
        if (team_mismatch) {
            log(
                `WARNING: team mismatch. "${t.assignee}" is in ` +
                `${(found_departments || []).join(" / ") || "another department"} in PMT, ` +
                `but this message is a ${cap(team)} tasklist. ` +
                `The task is held for review and the assignee will not see it. ` +
                `If the header is wrong, fix it and send the message again.`
            );
        }

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

        // The client is certain (named in the text) and the only problem is that no
        // project of that client matches: the assignee still gets the task, marked
        // "project to be confirmed", instead of it waiting in the review queue.
        // Anything ambiguous, guessed or weak still goes to a manager.
        const allReasons = Array.from(new Set(reasons.concat(t.review_reasons || [])));

        const projectOnlyMissing =
            !!clientId &&
            !projectId &&
            !!user &&
            !team_mismatch &&
            t.client_source === "name in text" &&
            allReasons.length > 0 &&
            allReasons.every(r =>
                /^No matching project in the database/.test(r) ||
                /^Project not found in the database/.test(r) ||
                /^Client or project is not confirmed/.test(r)
            );

        const needsReview = projectOnlyMissing
            ? false
            : (reasons.length > 0 || t.needs_review === true);

        const finalReasons = projectOnlyMissing ? [] : Array.from(new Set(reasons));

        items.push({

            id: newId(),

            message_id: payload.message_id,
            // every live message that asserts this task (a re-send adds one)
            source_message_ids: [payload.message_id],
            seq: i + 1,

            work_date: workDate,
            team: team,
            team_mismatch: team_mismatch === true,

            assignee_name: t.assignee,
            assignee_user_id: user ? user.id : null,
            assignee_pmt_name: user ? user.name : null,
            ...(collaborators.length ? { collaborator_user_ids: collaborators } : {}),

            ...assigner,

            client_id: clientId,
            client_name: t.client_name || null,

            project_id: projectId,
            project_name: t.project_name || null,
            project_text: t.project_text || null,
            project_unconfirmed: projectOnlyMissing,

            deliverable_name: t.deliverable_name || null,
            db_deliverable: t.db_deliverable || null,
            deliverable_id: deliverableId,

            // PMT deliverable type for the Work Sheet when no deliverable of that
            // name exists yet: the matched deliverable's own type ("database") or
            // the closing word of the line, e.g. "... > Carousel" ("line")
            deliverable_type: t.deliverable_type || null,
            // set when the type came from what a manager chose for this wording
            // (learned.js): PMT then keeps it over the deliverable's own type
            // (also set for a closing "changes" / "review", which beats it too)
            deliverable_type_corrected: Boolean(t.learned_type || t.type_wins),
            type_source: t.type_source || null,
            type_candidates: t.type_candidates || [],

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

            // "2 Minimalist" becomes two tasks: 1 of 2, 2 of 2 (null otherwise)
            copy_index: t.copy_total > 1 ? t.copy_index : null,
            copy_total: t.copy_total > 1 ? t.copy_total : null,
            dup_index: t.dup_index > 1 ? t.dup_index : null,

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

    return {
        tasklist, items, logs, skipped, workDate, message, tasksDocs,
        delivery: deliverySummary(items)
    };

}


// ------------------------------------------------------------
// DELIVERY SUMMARY  (who got a sticky note and who did not)
// A person "received" tasks when at least one of their tasks was queued
// for them. A task held for review is invisible to the assignee, so a
// person whose every task is held, or who maps to no PMT user, received
// nothing. Someone with only some tasks held is listed as "partly held".
// ------------------------------------------------------------
function deliverySummary(items) {

    const people = new Map();

    for (const i of items) {

        const key = i.assignee_user_id || `name:${normName(i.assignee_name)}`;

        if (!people.has(key)) {
            people.set(key, {
                name: i.assignee_pmt_name || i.assignee_name || "(no name)",
                total: 0,
                delivered: 0,
                held: 0,
                reasons: []
            });
        }

        const p = people.get(key);

        p.total += 1;

        if (!i.needs_review && i.assignee_user_id) {
            p.delivered += 1;
            continue;
        }

        p.held += 1;

        const why = i.assignee_user_id
            ? (i.review_reasons || [])[0]
            : (i.review_reasons || []).find(r => /assignee|name/i.test(r)) || "No PMT user for this name";

        if (why && !p.reasons.includes(why)) p.reasons.push(why);

    }

    const all = [...people.values()];
    const received = all.filter(p => p.delivered > 0);
    const notReceived = all.filter(p => p.delivered === 0);
    const partlyHeld = received.filter(p => p.held > 0);

    const short = (s) => (s.length > 90 ? s.slice(0, 87) + "..." : s);

    const why = (p) => p.reasons.slice(0, 2).map(short).join(" / ") || "needs review";

    let text =
        `Sticky notes: ${received.length} ${received.length === 1 ? "person" : "people"} received tasks, ` +
        `${notReceived.length} could not.`;

    if (notReceived.length) {
        text += " Did not receive: " +
            notReceived.map(p => `${p.name} (${p.held} held: ${why(p)})`).join("; ") + ".";
    }

    if (partlyHeld.length) {
        text += " Some tasks held for: " +
            partlyHeld.map(p => `${p.name} (${p.held} of ${p.total} held: ${why(p)})`).join("; ") + ".";
    }

    return {
        received: received.map(p => p.name),
        not_received: notReceived.map(p => ({ name: p.name, held: p.held, reasons: p.reasons })),
        partly_held: partlyHeld.map(p => ({ name: p.name, held: p.held, of: p.total, reasons: p.reasons })),
        text
    };

}


// ------------------------------------------------------------
// OUTBOX  (nothing is lost while MongoDB is unreachable)
// ------------------------------------------------------------

// Writes the file under a temporary name and renames it, so a crash or a full
// disk never leaves half a payload that looks complete. Returns false when the
// payload was NOT saved: callers must not tell anyone it is queued then.
function writeOutboxFile(name, payload) {

    try {

        fs.mkdirSync(OUTBOX_DIR, { recursive: true });

        const file = path.join(OUTBOX_DIR, `${name.replace(/[^\w-]/g, "_")}.json`);
        const temp = `${file}.tmp`;

        fs.writeFileSync(temp, JSON.stringify(payload));
        fs.renameSync(temp, file);

        log(`Saved to ${file}. It will be retried automatically.`);

        return true;

    }

    catch (error) {
        log("COULD NOT WRITE OUTBOX FILE (the data is NOT saved):", error.message);
        return false;
    }

}


function writeOutbox(payload) {
    return writeOutboxFile(payload.message_id || newId(), payload);
}


// A delete/edit seen while MongoDB is down is kept the same way and applied
// once it is back (withdrawing is idempotent).
function writeWithdrawEvent(messageId, reason) {
    return writeOutboxFile(`withdraw-${messageId}`, { type: "withdraw", message_id: messageId, reason });
}


// MongoDB being unreachable is expected and temporary - it must never push a
// payload towards quarantine. Anything else (bad data, a bug) will not fix itself.
function isConnectivityError(error) {

    const text = `${error && error.name} ${error && error.code} ${error && error.message}`;

    return /MongoNetwork|MongoServerSelection|MongoNotConnected|MongoTopology|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|not connected|topology|socket/i.test(text);

}


function outboxFailedCount() {

    try {

        const failedDir = path.join(OUTBOX_DIR, "failed");

        return fs.existsSync(failedDir)
            ? fs.readdirSync(failedDir).filter(f => f.endsWith(".json")).length
            : 0;

    }
    catch (error) {
        return 0;
    }

}


function outboxCount() {

    try {
        return fs.existsSync(OUTBOX_DIR)
            ? fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith(".json")).length
            : 0;
    }
    catch (error) {
        return 0;
    }

}


async function flushOutbox() {

    if (!db || isDryRun() || !fs.existsSync(OUTBOX_DIR)) return;

    const files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith(".json"));

    for (const file of files) {

        const full = path.join(OUTBOX_DIR, file);

        try {

            const payload = JSON.parse(fs.readFileSync(full, "utf8"));

            if (payload.type === "withdraw") {

                const outcome = await withdrawMessage(payload.message_id, payload.reason, false);

                // still not connected: leave the file for the next round
                if (outcome.error) throw new Error(outcome.error);

            }

            else {
                await persist(payload);
            }

            fs.unlinkSync(full);

            outboxFailures.delete(file);

            log(`Outbox: stored ${file}`);

        }

        catch (error) {

            // a file that is not valid JSON can never succeed: quarantine at once
            const unreadable = error instanceof SyntaxError;

            const failures = isConnectivityError(error) && !unreadable
                ? 0
                : (outboxFailures.get(file) || 0) + 1;

            outboxFailures.set(file, failures);

            if (unreadable || failures >= OUTBOX_MAX_ATTEMPTS) {

                try {

                    const failedDir = path.join(OUTBOX_DIR, "failed");

                    fs.mkdirSync(failedDir, { recursive: true });
                    fs.renameSync(full, path.join(failedDir, file));
                    outboxFailures.delete(file);

                    log(`Outbox: ${file} failed ${failures} times (${error.message}) and was moved to ${failedDir}. Look at it by hand.`);

                }

                catch (moveError) {
                    log(`Outbox: ${file} failed ${failures} times and could not be moved:`, moveError.message);
                }

            }

            else {
                log(`Outbox: ${file} still failing (${error.message})`);
            }

        }

    }

}


// ------------------------------------------------------------
// WRITE
// ------------------------------------------------------------

async function persist(payload) {

    await loadUsers();

    const refs = await loadReferences((payload.parsed_tasklist || {}).tasks || []);

    const { tasklist, items, logs, skipped, workDate, message, tasksDocs, delivery } =
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

    // 2. every task. An existing one is left exactly as it is, except:
    //    - a withdrawn one (its message was deleted or edited) is restored;
    //    - one still waiting (needs_review / pending) that was filed under the
    //      other team is moved to this message's team and re-checked.
    //    Accepted, accepting and declined tasks are never touched.
    let inserted = 0;
    let updated = 0;

    for (const doc of items) {

        const filter = {
            work_date: doc.work_date,
            assignee_name: doc.assignee_name,
            dedupe_key: doc.dedupe_key
        };

        const result = await db.collection(ITEMS).updateOne(
            filter,
            { $setOnInsert: doc },
            { upsert: true }
        );

        if (result.upsertedCount) {
            inserted += 1;
            continue;
        }

        const existing = await db.collection(ITEMS).findOne(filter);

        if (!existing) continue;

        const restoring = existing.status === "withdrawn";
        const reTeaming = WAITING_STATUSES.includes(existing.status) &&
            (existing.team || null) !== (doc.team || null);

        if (restoring || reTeaming) {

            const { id, created_at, history, ...fresh } = doc;

            const detail = restoring
                ? "Message sent again after it was withdrawn"
                : `Message sent again as a ${cap(doc.team)} tasklist (was ${cap(existing.team)})`;

            const change = await db.collection(ITEMS).updateOne(
                { id: existing.id, status: existing.status },
                {
                    $set: { ...fresh, updated_at: nowIso() },
                    $push: {
                        history: {
                            at: nowIso(),
                            by: "system",
                            action: restoring ? "restored" : "re-teamed",
                            detail
                        }
                    }
                }
            );

            if (change.modifiedCount) {
                updated += 1;
                log(`Task "${doc.raw_line}" for ${doc.assignee_name}: ${detail}.`);
            }

            continue;

        }

        // Plain re-delivery or re-post: leave the task alone, but remember that
        // this message asserts it too, so deleting the older one keeps it.
        // $addToSet is atomic: two reposts at once cannot overwrite each other
        if (Array.isArray(existing.source_message_ids)) {
            await db.collection(ITEMS).updateOne(
                { id: existing.id },
                { $addToSet: { source_message_ids: doc.message_id } }
            );
        }
        else {
            // item written before source_message_ids existed
            const known = [existing.message_id];

            if (!known.includes(doc.message_id)) {
                await db.collection(ITEMS).updateOne(
                    { id: existing.id },
                    { $set: { source_message_ids: [...known, doc.message_id] } }
                );
            }
        }

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
        tasks_updated: updated,
        tasks_already_stored: items.length - inserted - updated,
        duplicate_lines_skipped: skipped.length,
        logs_inserted: logged,
        needs_review: items.filter(i => i.needs_review).length,
        queued: items.filter(i => !i.needs_review).length,
        delivery: delivery,
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

        const { tasklist, items, skipped, logs, delivery } = buildDocuments(payload, users, refs);

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

        log("  " + delivery.text);

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

        const saved = writeOutbox(payload);

        scheduleRetry();

        return saved
            ? { stored: false, queued_in_outbox: true }
            : { stored: false, queued_in_outbox: false, error: "MongoDB is down and the outbox file could not be written" };

    }

    try {

        const summary = await persist(payload);

        log(
            `Stored ${summary.tasks_inserted} new task(s)` +
            (summary.tasks_updated ? `, ${summary.tasks_updated} updated or restored` : "") +
            (summary.tasks_already_stored ? `, ${summary.tasks_already_stored} already stored` : "") +
            `, ${summary.queued} queued for the assignee, ${summary.needs_review} need review (work date ${summary.work_date})`
        );

        // who got a sticky note and who did not, by name
        log(summary.delivery.text);

        return { stored: true, ...summary };

    }

    catch (error) {

        log("Write failed:", error.message);

        const saved = writeOutbox(payload);

        scheduleRetry();

        return { stored: false, queued_in_outbox: saved, error: error.message };

    }

}


// ------------------------------------------------------------
// MESSAGE DELETED OR EDITED IN WHATSAPP
// ------------------------------------------------------------
//
// A deleted message stops asserting its tasks. Tasks nobody has acted on
// (needs_review / pending) become `withdrawn`, which PMT never shows. Tasks
// that were accepted, are being accepted, or were declined stay exactly as they
// are: work may already have started. A task another live message also
// asserts (it was re-posted) stays too. An edit is a withdraw of the old
// message followed by a normal save of the new text (restoring unchanged
// lines), which is done by the caller.

async function withdrawMessage(messageId, reason = "message deleted in WhatsApp", queueIfDown = true) {

    const none = { withdrawn: 0, kept_in_use: 0, kept_other_message: 0 };

    if (!messageId || isDryRun()) return none;

    if (!db) {

        log(`Cannot withdraw ${messageId} yet: MongoDB is not connected.`);

        // keep the delete/edit so it is applied when MongoDB is back
        if (!queueIfDown) return { ...none, error: "not connected" };

        const saved = writeWithdrawEvent(messageId, reason);

        scheduleRetry();

        return saved
            ? { ...none, queued_in_outbox: true }
            : { ...none, error: "not connected, and the outbox file could not be written" };

    }

    const found = new Map();

    for (const filter of [{ source_message_ids: messageId }, { message_id: messageId }]) {
        const rows = await db.collection(ITEMS).find(filter).toArray();
        rows.forEach(r => found.set(r.id, r));
    }

    const result = { ...none };

    for (const item of found.values()) {

        let remaining;

        if (Array.isArray(item.source_message_ids)) {

            // atomic: another message adding itself at the same moment is not undone
            await db.collection(ITEMS).updateOne(
                { id: item.id },
                { $pull: { source_message_ids: messageId } }
            );

            const fresh = await db.collection(ITEMS).findOne({ id: item.id });

            remaining = (fresh && fresh.source_message_ids) || [];

            if (fresh) item.status = fresh.status;

        }

        else {
            // item written before source_message_ids existed
            remaining = [item.message_id].filter(id => id !== messageId);
        }

        if (remaining.length) {

            result.kept_other_message += 1;
            continue;

        }

        if (!WAITING_STATUSES.includes(item.status)) {

            // accepted / accepting / declined / already withdrawn
            if (item.status !== "withdrawn") result.kept_in_use += 1;
            continue;

        }

        const change = await db.collection(ITEMS).updateOne(
            { id: item.id, status: item.status },
            {
                $set: {
                    status: "withdrawn",
                    source_message_ids: [],
                    withdrawn_at: nowIso(),
                    updated_at: nowIso()
                },
                $push: {
                    history: {
                        at: nowIso(),
                        by: "system",
                        action: "withdrawn",
                        detail: reason
                    }
                }
            }
        );

        if (change.modifiedCount) result.withdrawn += 1;

    }

    await db.collection(TASKLISTS).updateOne(
        { message_id: messageId },
        { $set: { withdrawn_at: nowIso(), withdrawn_reason: reason } }
    );

    log(
        `Message ${messageId} (${reason}): ${result.withdrawn} task(s) withdrawn` +
        (result.kept_in_use ? `, ${result.kept_in_use} kept (already accepted or declined)` : "") +
        (result.kept_other_message ? `, ${result.kept_other_message} kept (also sent in another message)` : "")
    );

    return result;

}


// The work date of a message already saved, so an edit stays on the same day.
async function workDateOf(messageId) {

    if (!db || !messageId) return null;

    const row = await db.collection(TASKLISTS).findOne({ message_id: messageId });

    return row ? row.work_date || null : null;

}


// test hooks: let tests inject a fake database
function _useDatabaseForTest(fakeDb, userList) {
    db = fakeDb;
    users = userList || [];
    usersLoadedAt = Date.now();
}


function getDb() {
    return db;
}


module.exports = {
    init,
    getDb,
    close,
    saveTasklist,
    buildDocuments,
    deliverySummary,
    resolveAssignee,
    assigneeNames,
    loadUsers,
    refreshLexicon,
    refreshLearned,
    startLearnedRefresh,
    resolveAssigner,
    wholeTeam,
    validateRefs,
    loadReferences,
    istDate,
    flushOutbox,
    outboxCount,
    outboxFailedCount,
    persist,
    withdrawMessage,
    workDateOf,
    _useDatabaseForTest
};
