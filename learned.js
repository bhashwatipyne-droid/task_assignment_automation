"use strict";
// Learning from the manager's decisions on held lines (PMT > Planning > Held items).
//
//   exact rule   a line the manager has resolved before, worded the same, goes
//                straight to the project, deliverable and deliverable type they chose.
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
const { words } = require("./textUtils");

const MIN_ALIAS_LINES = 3;
const RULES = "nlp_learned_rules";

// "Absl Apex > IE campaign > Tool kit 3 (first cut today)" -> the words, without
// the trailing timing note, so the same task worded the same matches next week.
const lineKey = raw => words(String(raw || "").replace(/\([^)]*\)\s*$/, "")).join(" ");

const leadWord = raw => words(String(raw || ""))[0] || "";

function buildRules(items) {
    const byLine = new Map();
    const byLead = new Map();

    for (const it of items || []) {
        if (!it || !it.raw_line || !it.project_id || !it.client_id) continue;
        const key = lineKey(it.raw_line);
        if (!key) continue;

        const l = byLine.get(key) || { decisions: new Set(), latest: null };
        // a type only counts when a person chose it (not the matcher's own reading)
        const chosenType = it.deliverable_type_corrected ? (it.deliverable_type || "") : "";
        l.decisions.add(`${it.project_id}|${it.deliverable_id || ""}|${chosenType}`);
        l.latest = it;
        byLine.set(key, l);

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
        if (l.decisions.size !== 1) continue; // decided two different ways: not a rule
        rules.push({
            id: `exact:${key}`, kind: "exact", key,
            project_id: l.latest.project_id,
            client_id: l.latest.client_id,
            deliverable_id: l.latest.deliverable_id || null,
            deliverable_type: l.latest.deliverable_type_corrected ? (l.latest.deliverable_type || null) : null,
            example: l.latest.raw_line,
            count: 1
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
    for (const r of rules) {
        if (disabledIds.has(r.id)) continue;
        if (r.kind === "exact") exact.set(r.key, r);
        else if (r.kind === "alias") leadClient.set(r.key, r.client_id);
    }
    return { exact, leadClient };
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

module.exports = { MIN_ALIAS_LINES, lineKey, leadWord, buildRules, sheetCorrections, toLookups, loadFromDb };
