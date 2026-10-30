"use strict";
// Learning from the manager's decisions on held lines (PMT > Planning > Held items).
//
//   exact rule   a line the manager has resolved before, worded the same, goes
//                straight to the project, deliverable and deliverable type they chose.
//                When several people resolved it, the answer that clearly wins
//                (see MIN_AGREEMENT) is the rule; a tie or a split makes none.
//   closer rule  the last word of a line ("Review", "Changes") that people have
//                typed to the same deliverable type on MIN_CLOSER_LINES different
//                lines, never to another, fills the type of a line whose type
//                nothing else could read.
//   alias rule   a first word ("TFP", "BBNPP") the manager has resolved to the
//                same client at least MIN_ALIAS_LINES times, never to another,
//                settles a client tie.
//
// Rules are rebuilt from tasklist_items that a person resolved (resolved_by set:
// held items, or an edit on the Planning card) and from Work Sheet rows of accepted
// tasks that someone changed afterwards (the row differs from row_snapshot, what
// PMT made it with). They are kept in nlp_learned_rules so a manager can switch
// one off (disabled: true).
// Nothing here changes the matcher's own scoring.
const { words, stem, dropTrailingStamps } = require("./textUtils");

const MIN_ALIAS_LINES = 3;
// Different lines with the same closing word that people typed to the same type
const MIN_CLOSER_LINES = 3;
const ARROW_RE = /\s*(?:-+>|[>›»→])+\s*/;
// How much of the people who resolved one line must agree for it to become a rule
const MIN_AGREEMENT = 0.75;
const RULES = "nlp_learned_rules";

// "Absl Apex > IE campaign > Tool kit 3 (first cut today)" -> the words, without
// the trailing timing note, so the same task worded the same matches next week.
const lineKey = raw => words(String(raw || "").replace(/\([^)]*\)\s*$/, "")).join(" ");

const leadWord = raw => words(String(raw || ""))[0] || "";

// The stemmed last word of a line's closing part ("... > Scripting Reviews ->
// "review"), ignoring timing notes in brackets and trailing date stamps. Only
// arrowed lines have a closing part; others return "".
function closerKey(raw) {
    const parts = dropTrailingStamps(String(raw || "").split(ARROW_RE));
    if (parts.length < 2) return "";
    const last = words(parts[parts.length - 1].replace(/\([^)]*\)?/g, " ")).pop() || "";
    return last.length >= 3 && !/^\d/.test(last) ? stem(last) : "";
}

// A type only counts when a person chose it (not the matcher's own reading)
const chosenTypeOf = it => (it.deliverable_type_corrected ? (it.deliverable_type || "") : "");

// Of several people's answers to the same question, the one that clearly wins:
// strictly more votes than any other answer and at least MIN_AGREEMENT of all
// votes. A tie or a real split returns null (no rule). One person picking
// differently from ten others does not cancel what the ten agreed on.
function clearWinner(list, answerOf) {
    const tally = new Map();
    for (const it of list) {
        const a = answerOf(it);
        const t = tally.get(a) || { answer: a, votes: 0, latest: null };
        t.votes += 1;
        t.latest = it;
        tally.set(a, t);
    }
    const ranked = [...tally.values()].sort((x, y) => y.votes - x.votes);
    if (!ranked.length) return null;
    if (ranked[1] && ranked[1].votes === ranked[0].votes) return null;
    return ranked[0].votes / list.length >= MIN_AGREEMENT ? ranked[0] : null;
}

function buildRules(items) {
    const byLine = new Map();
    const byLead = new Map();
    const byCloser = new Map();

    for (const it of items || []) {
        if (!it || !it.raw_line || !it.project_id || !it.client_id) continue;
        const key = lineKey(it.raw_line);
        if (!key) continue;

        const l = byLine.get(key) || { items: [], latest: null };
        l.items.push(it);
        l.latest = it;
        byLine.set(key, l);

        // a type a person chose, filed under the line's closing word
        const chosen = chosenTypeOf(it);
        const closer = chosen ? closerKey(it.raw_line) : "";
        if (closer) {
            const c = byCloser.get(closer) || new Map();
            const lines = c.get(chosen) || new Set();
            lines.add(key);
            c.set(chosen, lines);
            byCloser.set(closer, c);
        }

        const lead = leadWord(it.raw_line);
        if (lead) {
            const a = byLead.get(lead) || { clients: new Set(), lines: new Set() };
            a.clients.add(it.client_id);
            a.lines.add(key);
            byLead.set(lead, a);
        }
    }

    const rules = [];
    for (const [key, l] of byLine) {
        // The project first: if the people who resolved this line did not clearly
        // agree on it (a tie, or a real split), it is not a rule.
        const project = clearWinner(l.items, it => it.project_id);
        if (!project) continue;
        const agreeing = l.items.filter(it => it.project_id === project.answer);

        // Then the deliverable and type within that project. If those are split
        // (people filed the same line under different deliverables) the rule
        // still sends the line to the project and leaves the deliverable open.
        const decision = clearWinner(agreeing, it => `${it.deliverable_id || ""}|${chosenTypeOf(it)}`);
        const basis = decision ? decision.latest : project.latest;
        rules.push({
            id: `exact:${key}`, kind: "exact", key,
            project_id: project.answer,
            client_id: project.latest.client_id,
            deliverable_id: decision ? (basis.deliverable_id || null) : null,
            deliverable_type: decision ? (chosenTypeOf(basis) || null) : null,
            example: l.latest.raw_line,
            count: project.votes
        });
    }
    for (const [closer, types] of byCloser) {
        if (types.size !== 1) continue; // typed two different ways: not a rule
        const [[type, lines]] = types;
        if (lines.size < MIN_CLOSER_LINES) continue;
        rules.push({
            id: `closer:${closer}`, kind: "closer", key: closer,
            deliverable_type: type,
            example: closer,
            count: lines.size
        });
    }
    for (const [lead, a] of byLead) {
        if (a.clients.size !== 1 || a.lines.size < MIN_ALIAS_LINES) continue;
        rules.push({
            id: `alias:${lead}`, kind: "alias", key: lead,
            client_id: [...a.clients][0],
            example: lead,
            count: a.lines.size
        });
    }
    return rules;
}

// rules (minus disabled ones) -> the lookups the matcher uses
function toLookups(rules, disabledIds = new Set()) {
    const exact = new Map();
    const leadClient = new Map();
    const closerType = new Map();
    for (const r of rules) {
        if (disabledIds.has(r.id)) continue;
        if (r.kind === "exact") exact.set(r.key, r);
        else if (r.kind === "alias") leadClient.set(r.key, r.client_id);
        else if (r.kind === "closer") closerType.set(r.key, r.deliverable_type);
    }
    return { exact, leadClient, closerType };
}

// Accepted tasks whose Work Sheet row was changed after PMT made it: what the row
// says now is the person's correction. Returns items shaped like resolved ones.
function sheetCorrections(accepted, rows) {
    const byId = new Map((rows || []).map(r => [r.id, r]));
    const out = [];
    for (const it of accepted || []) {
        const row = byId.get(it.work_item_id);
        const snap = it.row_snapshot;
        if (!row || !snap || !row.project_id) continue; // tasks accepted before snapshots: cannot tell
        const sameProject = (row.project_id || "") === (snap.project_id || "");
        const sameDeliverable = (row.deliverable_id || "") === (snap.deliverable_id || "");
        const sameType = (row.deliverable_type || "") === (snap.deliverable_type || "");
        if (sameProject && sameDeliverable && sameType) continue;
        out.push({
            id: it.id,
            raw_line: it.raw_line,
            project_id: row.project_id,
            client_id: row.client_id || it.client_id,
            deliverable_id: row.deliverable_id || null,
            deliverable_type: row.deliverable_type || null,
            deliverable_type_corrected: !sameType
        });
    }
    return out;
}

// Reads the manager's resolved lines, refreshes nlp_learned_rules (keeping any
// "disabled" switch) and returns the lookups. Never throws: learning is a bonus.
async function loadFromDb(db, log = () => {}) {
    try {
        const resolved = await db.collection("tasklist_items").find(
            { resolved_by: { $exists: true }, project_id: { $ne: null } },
            { projection: { _id: 0, id: 1, raw_line: 1, project_id: 1, client_id: 1, deliverable_id: 1, deliverable_type: 1, deliverable_type_corrected: 1 } }
        ).limit(20000).toArray();

        // ...and later edits made on the Work Sheet row of an accepted WhatsApp task
        const accepted = await db.collection("tasklist_items").find(
            { status: "accepted", work_item_id: { $ne: null }, row_snapshot: { $exists: true } },
            { projection: { _id: 0, id: 1, raw_line: 1, client_id: 1, work_item_id: 1, row_snapshot: 1 } }
        ).limit(20000).toArray();
        const rows = accepted.length
            ? await db.collection("work_items").find(
                { id: { $in: accepted.map(a => a.work_item_id) } },
                { projection: { _id: 0, id: 1, project_id: 1, client_id: 1, deliverable_id: 1, deliverable_type: 1 } }
            ).toArray()
            : [];
        // a row edit is newer than the card decision it follows, so it replaces it
        const merged = new Map(resolved.map(r => [r.id || r.raw_line, r]));
        for (const c of sheetCorrections(accepted, rows)) merged.set(c.id || c.raw_line, c);

        const rules = buildRules([...merged.values()]);
        const col = db.collection(RULES);
        const known = await col.find({}, { projection: { _id: 0, id: 1, disabled: 1 } }).toArray();
        const disabled = new Set(known.filter(k => k.disabled).map(k => k.id));

        if (rules.length) {
            await col.bulkWrite(rules.map(r => ({
                updateOne: {
                    filter: { id: r.id },
                    update: { $set: { ...r, updated_at: new Date().toISOString() }, $setOnInsert: { disabled: false } },
                    upsert: true
                }
            })));
        }
        const live = new Set(rules.map(r => r.id));
        const stale = known.filter(k => !live.has(k.id)).map(k => k.id);
        if (stale.length) await col.deleteMany({ id: { $in: stale } });

        return toLookups(rules, disabled);
    }
    catch (error) {
        log("Learned rules not refreshed:", error.message);
        return null;
    }
}

module.exports = { MIN_ALIAS_LINES, MIN_CLOSER_LINES, closerKey, lineKey, leadWord, buildRules, sheetCorrections, toLookups, loadFromDb };
