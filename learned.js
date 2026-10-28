"use strict";
// Learning from the manager's decisions on held lines (PMT > Planning > Held items).
//
//   exact rule   a line the manager has resolved before, worded the same, goes
//                straight to the project (and deliverable) they chose.
//   alias rule   a first word ("TFP", "BBNPP") the manager has resolved to the
//                same client at least MIN_ALIAS_LINES times, never to another,
//                settles a client tie.
//
// Rules are rebuilt from tasklist_items that a person resolved (resolved_by set),
// and kept in nlp_learned_rules so a manager can switch one off (disabled: true).
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
        l.decisions.add(`${it.project_id}|${it.deliverable_id || ""}`);
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

// Reads the manager's resolved lines, refreshes nlp_learned_rules (keeping any
// "disabled" switch) and returns the lookups. Never throws: learning is a bonus.
async function loadFromDb(db, log = () => {}) {
    try {
        const items = await db.collection("tasklist_items").find(
            { resolved_by: { $exists: true }, project_id: { $ne: null } },
            { projection: { _id: 0, raw_line: 1, project_id: 1, client_id: 1, deliverable_id: 1 } }
        ).limit(20000).toArray();

        const rules = buildRules(items);
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

module.exports = { MIN_ALIAS_LINES, lineKey, leadWord, buildRules, toLookups, loadFromDb };
