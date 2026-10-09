// Integration tests for the WhatsApp -> NLP -> MongoDB half of the flow.
// Real parser, real matcher, real lexicon.json; only MongoDB is faked.
//
//   npm test
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { FakeDb } = require("./fakeDb");
const { parseTaskList, detectTeam } = require("../tasklistParser");
const store = require("../mongoStore");
const lex = require("../lexicon.json");

const OUTBOX = path.join(__dirname, "..", "outbox");

const USERS = [
    { id: "manager-hp", name: "Harshal Pawar", role: "manager", department: "Content" },
    { id: "manager-vs", name: "Vanshika Shah", role: "manager", department: "Content" },
    { id: "member-vt", name: "Vanshika testing", role: "manager", department: "Content" },
    { id: "member-rb", name: "Ratnesh Bor", role: "member", department: "Content" },
    { id: "member-rt", name: "Ratnesh Testing", role: "member", department: "Content" },
    { id: "manager-sa", name: "Sakshi Agrawal", role: "manager", department: "Content" },
    { id: "admin-sc", name: "Sakshi Chaurasia", role: "admin", department: "Administration" },
    { id: "member-an", name: "Aniket Bangal", role: "member", department: "Design" }
];

const ASSIGNEES = ["Harshal", "Vanshika", "Ratnesh", "Sakshi", "Aniket", "Nobody"];

const GOOD = `Content Team
Harshal
- ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority`;

let n = 0;

function payloadFor(text, extra = {}) {
    n += 1;
    return {
        message_id: "MSG" + n,
        chat_id: "120363@g.us",
        group_name: "Content Tasklist",
        sender: "MANAGER",
        sender_number: "919800000001",
        sender_alt_number: "",
        from_manager: true,
        is_group: true,
        message: text,
        team: detectTeam(text),
        parsed_tasklist: parseTaskList(text, ASSIGNEES),
        lexicon_built_at: lex.built_at,
        timestamp: "2026-10-09T05:00:00.000Z",     // 10:30 IST on 9 Oct
        ...extra
    };
}

// the live PMT data, built from the same snapshot the matcher uses
function liveDb(mutate) {
    const db = new FakeDb();
    db.collection("clients").docs.push(...lex.clients.map(c => ({ id: c.id, name: c.name })));
    db.collection("projects").docs.push(...lex.projects.map(p => ({ id: p.id, name: p.name, client_id: p.client_id, hidden: false })));
    db.collection("deliverables").docs.push(...lex.deliverables.map(d => ({ id: d.id, name: d.name, project_id: d.project_id })));
    if (mutate) mutate(db);
    store._useDatabaseForTest(db, USERS);
    return db;
}

test.beforeEach(() => {
    delete process.env.DRY_RUN;
    delete process.env.WRITE_TASKS;
    delete process.env.MANAGER_MAP;
    fs.rmSync(OUTBOX, { recursive: true, force: true });
});

test.after(() => fs.rmSync(OUTBOX, { recursive: true, force: true }));


// ---------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------

test("a certain line is queued for the assignee with live-checked ids", async () => {
    const db = liveDb();
    const result = await store.persist(payloadFor(GOOD));

    assert.equal(result.tasks_inserted, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.needs_review, 0);

    const [item] = db.all("tasklist_items");
    assert.equal(item.status, "pending");
    assert.equal(item.assignee_user_id, "manager-hp");
    assert.equal(item.client_id, "CLIENT - 006");
    assert.equal(item.project_name, "IPru Pharma ETF Campaign");
    assert.ok(item.project_id);
    assert.ok(item.deliverable_id, "the matched DB deliverable id is kept");
    assert.equal(item.priority, "High");
    assert.equal(item.work_date, "2026-10-09");
    assert.equal(item.due_at, "2026-10-09T18:00:00+05:30");
    assert.equal(item.assigned_by_name, "Content team manager");
    assert.equal(item.work_item_id, null);
    assert.equal(item.history[0].action, "queued");
});

test("the legacy flat `tasks` collection is off by default and on by request", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD));
    assert.equal(db.all("tasks").length, 0);

    process.env.WRITE_TASKS = "true";
    await store.persist(payloadFor(GOOD.replace("Harshal", "Ratnesh")));
    assert.equal(db.all("tasks").length, 1);
});

test("a manager mapped in MANAGER_MAP shows up as the assigner", async () => {
    process.env.MANAGER_MAP = "+91 98000 00001=Vanshika Shah";
    const db = liveDb();
    await store.persist(payloadFor(GOOD));
    const [item] = db.all("tasklist_items");
    assert.equal(item.assigned_by_user_id, "manager-vs");
    assert.equal(item.assigned_by_name, "Vanshika Shah");
    assert.equal(item.assigned_by_role, "Content manager");
});

test("the work date is the day WhatsApp says it was sent, not the day it arrived", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD, { timestamp: "2026-10-07T20:00:00.000Z" })); // 8 Oct 01:30 IST
    assert.equal(db.all("tasklist_items")[0].work_date, "2026-10-08");
});


// ---------------------------------------------------------------
// ambiguous / failed matches are never assigned
// ---------------------------------------------------------------

test("an ambiguous project goes to review, not to the assignee", async () => {
    const db = liveDb();
    const text = `Content Team
Vanshika
- Invesco Concept Presentations - Pitch narrative`;
    await store.persist(payloadFor(text));
    const [item] = db.all("tasklist_items");
    assert.equal(item.status, "needs_review");
    assert.ok(item.review_reasons.some(r => r.startsWith("Ambiguous project")), item.review_reasons.join(" | "));
});

test("a line the matcher cannot place goes to review with no ids", async () => {
    const db = liveDb();
    await store.persist(payloadFor(`Content Team
Vanshika
- Totally unknown thing xyz`));
    const [item] = db.all("tasklist_items");
    assert.equal(item.status, "needs_review");
    assert.equal(item.client_id, null);
    assert.equal(item.project_id, null);
});

test("a tie between clients goes to review", async () => {
    const db = liveDb();
    await store.persist(payloadFor(`Content Team
Harshal
- Franklin US Equity IFSC Fund - Campaign - Script`));
    const [item] = db.all("tasklist_items");
    assert.equal(item.status, "needs_review");
});

test("two near-equal deliverables go to review (the matcher does not check this itself)", () => {
    const d = lex.deliverables[0];
    const task = {
        assignee: "Harshal",
        client_id: d.client_id, client_name: "X",
        project_id: d.project_id, project_name: "P",
        deliverable_name: "Script", db_deliverable: d.name, db_deliverable_id: d.id,
        deliverable_alternatives: [
            { id: d.id, deliverable: "Script A", score: 0.81 },
            { id: "other", deliverable: "Script B", score: 0.77 }
        ],
        confidence: { client: 0.95, project: 0.9, deliverable: 0.81 },
        needs_review: false, review_reasons: [], raw_line: "- X P - Script"
    };
    const refs = {
        clients: new Map([[d.client_id, { id: d.client_id }]]),
        projects: new Map([[d.project_id, { id: d.project_id, client_id: d.client_id }]]),
        deliverables: new Map([[d.id, { id: d.id, project_id: d.project_id }]])
    };
    const { items } = store.buildDocuments(
        { message_id: "T", parsed_tasklist: { tasks: [task] }, team: "content" }, USERS, refs);
    assert.equal(items[0].status, "needs_review");
    assert.match(items[0].review_reasons.join("|"), /Ambiguous deliverable/);

    task.deliverable_alternatives[1].score = 0.40;       // clear winner
    const ok = store.buildDocuments(
        { message_id: "T2", parsed_tasklist: { tasks: [task] }, team: "content" }, USERS, refs);
    assert.equal(ok.items[0].status, "pending");
});


// ---------------------------------------------------------------
// the lexicon is a snapshot: ids are re-checked against live data
// ---------------------------------------------------------------

const PHARMA = "79dac8f2-5c2b-44de-a246-40177d4ef9cf";

for (const [label, mutate, expected] of [
    ["deleted", db => { db.collection("projects").docs = db.collection("projects").docs.filter(p => p.id !== PHARMA); }, /no longer exists/],
    ["hidden", db => { db.collection("projects").docs.find(p => p.id === PHARMA).hidden = true; }, /is hidden/],
    ["merged", db => { db.collection("projects").docs.find(p => p.id === PHARMA).duplicate_of = "other"; }, /was merged/],
    ["moved to another client", db => { db.collection("projects").docs.find(p => p.id === PHARMA).client_id = "CLIENT - 001"; }, /different client/]
]) {
    test(`a matched project that is ${label} is cleared and sent to review`, async () => {
        const db = liveDb(mutate);
        await store.persist(payloadFor(GOOD));
        const [item] = db.all("tasklist_items");
        assert.equal(item.status, "needs_review");
        assert.equal(item.project_id, null, "a dead id must never reach a worksheet");
        assert.equal(item.deliverable_id, null);
        assert.equal(item.nlp_ids.project_id, PHARMA, "what the matcher said is kept for the reviewer");
        assert.match(item.review_reasons.join(" | "), expected);
        const [entry] = db.all("nlp_match_logs");
        assert.ok(entry.validation_problems.length >= 1);
    });
}

test("a deliverable that now sits under another project is flagged", async () => {
    const db = liveDb(d => {
        const live = d.collection("deliverables").docs;
        const hit = live.find(x => x.id === "e50514ec-a1ee-4296-9536-ad2388b43c50");
        hit.project_id = "PROJECT - 001";
    });
    await store.persist(payloadFor(GOOD));
    const [item] = db.all("tasklist_items");
    assert.equal(item.status, "needs_review");
    assert.equal(item.deliverable_id, null);
    assert.ok(item.project_id, "the project itself is still fine");
});


// ---------------------------------------------------------------
// assignee mapping
// ---------------------------------------------------------------

test("assignees: test accounts and admins are never picked; unknown and duplicate names go to review", () => {
    const pick = (name, team) => store.resolveAssignee(name, team, [
        ...USERS, { id: "member-hx", name: "Harshal Patil", role: "member", department: "Content" }
    ]);
    assert.equal(pick("Ratnesh", "content").user.id, "member-rb");     // not "Ratnesh Testing"
    assert.equal(pick("Vanshika", "content").user.id, "manager-vs");   // not "Vanshika testing"
    assert.equal(pick("Sakshi", "content").user.id, "manager-sa");     // not the admin Sakshi
    assert.equal(pick("Sakshi", "design").user, null);                 // only a Content Sakshi exists
    assert.match(pick("Sakshi", "design").reason, /not in the Design team/);
    assert.match(pick("Harshal", "content").reason, /More than one PMT user/);
    assert.match(pick("Nobody", "content").reason, /No PMT user found/);
});

test("an unmapped assignee is stored but sent to review", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD.replace("Harshal", "Nobody")));
    const [item] = db.all("tasklist_items");
    assert.equal(item.assignee_user_id, null);
    assert.equal(item.status, "needs_review");
});


// ---------------------------------------------------------------
// duplicates, retries, redeliveries
// ---------------------------------------------------------------

test("re-delivering a message stores nothing twice and never undoes an accepted task", async () => {
    const db = liveDb();
    const payload = payloadFor(GOOD);

    await store.persist(payload);
    db.all("tasklist_items")[0].status = "accepted";              // the assignee accepted it
    db.all("tasklist_items")[0].work_item_id = "wi-1";

    const again = await store.persist(payload);

    assert.equal(again.tasks_inserted, 0);
    assert.equal(again.tasks_already_stored, 1);
    assert.equal(db.all("tasklist_items").length, 1);
    assert.equal(db.all("whatsapp_messages").length, 1);
    assert.equal(db.all("whatsapp_tasklists").length, 1);
    assert.equal(db.all("tasklist_items")[0].status, "accepted");
    assert.equal(db.all("tasklist_items")[0].work_item_id, "wi-1");
    assert.equal(db.all("nlp_match_logs").length, 1);
    assert.equal(db.all("nlp_match_logs")[0].seen_count, 2, "the log counts the redelivery");
});

test("the same task re-posted in a NEW message the same day is not duplicated", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD));
    await store.persist(payloadFor("Content Team\nHarshal\n  * ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority".replace("  *", "-")));
    assert.equal(db.all("tasklist_items").length, 1);
    assert.equal(db.all("whatsapp_messages").length, 2);
});

test("the same line twice in one message is stored once and logged as a duplicate", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD + "\n" + GOOD.split("\n")[2]));
    assert.equal(db.all("tasklist_items").length, 1);
    assert.deepEqual(db.all("nlp_match_logs").map(l => l.decision).sort(), ["duplicate_line", "queued"]);
});

test("the same task on another day is a new task", async () => {
    const db = liveDb();
    await store.persist(payloadFor(GOOD));
    await store.persist(payloadFor(GOOD, { timestamp: "2026-10-10T05:00:00.000Z" }));
    assert.equal(db.all("tasklist_items").length, 2);
});

test("MongoDB down: the payload waits in the outbox, then is stored once on retry", async () => {
    const db = liveDb();
    db.failWrites = true;

    const first = await store.saveTasklist(payloadFor(GOOD));
    assert.equal(first.stored, false);
    assert.equal(first.queued_in_outbox, true);
    assert.equal(fs.readdirSync(OUTBOX).length, 1);
    assert.equal(db.all("tasklist_items").length, 0);

    db.failWrites = false;
    await store.flushOutbox();
    await store.flushOutbox();                                    // a second flush is a no-op

    assert.equal(fs.readdirSync(OUTBOX).length, 0);
    assert.equal(db.all("tasklist_items").length, 1);
    assert.equal(db.all("tasklist_items")[0].status, "pending");
});

test("DRY_RUN writes nothing", async () => {
    process.env.DRY_RUN = "true";
    const db = liveDb();
    const r = await store.saveTasklist(payloadFor(GOOD));
    assert.equal(r.dry_run, true);
    for (const name of ["whatsapp_messages", "whatsapp_tasklists", "tasklist_items", "nlp_match_logs", "tasks"]) {
        assert.equal(db.all(name).length, 0, name);
    }
});


// ---------------------------------------------------------------
// observability
// ---------------------------------------------------------------

test("every line leaves an NLP log with scores, runners-up and the margin", async () => {
    const db = liveDb();
    await store.persist(payloadFor(`Content Team
Harshal
- ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority
Vanshika
- Invesco Concept Presentations - Pitch narrative
- Totally unknown thing xyz`));

    const logs = db.all("nlp_match_logs");
    assert.equal(logs.length, 3);

    const ok = logs.find(l => l.decision === "queued");
    assert.equal(ok.scores.client, 0.95);
    assert.ok(ok.scores.project > 0 && ok.scores.deliverable > 0);
    assert.ok(ok.scores.project_detail.raw > 0);
    assert.ok(ok.scores.deliverable_detail.mass > 0);
    assert.equal(ok.lexicon_built_at, lex.built_at);
    assert.equal(ok.validation_checked, true);

    const close = logs.find(l => l.raw_line.includes("Pitch narrative"));
    assert.equal(close.decision, "needs_review");
    assert.ok(close.margin.project < 0.15, "a close call shows a small margin");
    assert.ok(close.alternatives.projects.length >= 2);

    const unknown = logs.find(l => l.raw_line.includes("xyz"));
    assert.equal(unknown.decision, "needs_review");
    assert.deepEqual(unknown.matched, { client_id: null, project_id: null, deliverable_id: null });
});
