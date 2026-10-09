// Writes the tasklist_items documents the listener produces for a realistic
// tasklist, so the PMT backend tests can be run against the REAL shape.
//
//   node test/make-fixture.js <output.json>
"use strict";

const fs = require("fs");
const { FakeDb } = require("./fakeDb");
const { parseTaskList, detectTeam } = require("../tasklistParser");
const store = require("../mongoStore");
const lex = require("../lexicon.json");

process.env.MANAGER_MAP = "919800000001=Vanshika Shah";

const USERS = [
    { id: "manager-hp", name: "Harshal Pawar", role: "manager", department: "Content" },
    { id: "manager-vs", name: "Vanshika Shah", role: "manager", department: "Content" },
    { id: "member-rb", name: "Ratnesh Bor", role: "member", department: "Content" }
];

const text = `Content Team
Harshal
- ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority
Ratnesh
- ICICI Contra investing blog
Vanshika
- Invesco Concept Presentations - Pitch narrative
- Totally unknown thing xyz`;

const db = new FakeDb();
db.collection("clients").docs.push(...lex.clients.map(c => ({ id: c.id, name: c.name })));
db.collection("projects").docs.push(...lex.projects.map(p => ({ id: p.id, name: p.name, client_id: p.client_id, hidden: false })));
db.collection("deliverables").docs.push(...lex.deliverables.map(d => ({ id: d.id, name: d.name, project_id: d.project_id })));
store._useDatabaseForTest(db, USERS);

(async () => {
    await store.persist({
        message_id: "FIXTURE1",
        chat_id: "120363@g.us",
        group_name: "Content Tasklist",
        sender: "MANAGER",
        sender_number: "919800000001",
        sender_alt_number: "",
        from_manager: true,
        is_group: true,
        message: text,
        team: detectTeam(text),
        parsed_tasklist: parseTaskList(text, ["Harshal", "Vanshika", "Ratnesh"]),
        lexicon_built_at: lex.built_at,
        timestamp: "2026-10-09T05:00:00.000Z"
    });

    fs.writeFileSync(process.argv[2], JSON.stringify({
        items: db.all("tasklist_items"),
        logs: db.all("nlp_match_logs")
    }, null, 2));

    console.log(db.all("tasklist_items").map(i => `${i.seq} ${i.status.padEnd(12)} ${i.assignee_pmt_name || "-"} | ${i.raw_line}`).join("\n"));
})();
