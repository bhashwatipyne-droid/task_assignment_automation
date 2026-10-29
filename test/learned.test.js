"use strict";
// What the managers' decisions teach the matcher (learned.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const matcher = require("../tasklistMatcher");
const { parseTaskList } = require("../tasklistParser");
const learned = require("../learned");

const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lexicon.json"), "utf8"));
const parse = line => parseTaskList("Animation tasklist\n\nTejas\n" + line, ["Tejas"]).tasks[0];

const BNP = base.projects.find(p => p.name === "BNP Balanced Hybrid NFO Shoot Video");
const item = (raw, extra = {}) => ({ raw_line: raw, project_id: BNP.id, client_id: BNP.client_id, deliverable_id: null, ...extra });

test.afterEach(() => { matcher.useLexicon(base); matcher.useLearned(null); });

test("a line is keyed by its words, not its timing note or case", () => {
    assert.strictEqual(
        learned.lineKey("TFP > Brighter Diwali Reel (first cut today)"),
        learned.lineKey("tfp > brighter diwali reel")
    );
});

test("an exact rule needs one consistent decision; two different ones cancel it", () => {
    const ok = learned.buildRules([item("Foo > Bar baz")]);
    assert.strictEqual(ok.filter(r => r.kind === "exact").length, 1);
    const clash = learned.buildRules([item("Foo > Bar baz"), item("Foo > Bar baz", { project_id: "other" })]);
    assert.strictEqual(clash.filter(r => r.kind === "exact").length, 0);
});

test("an alias rule needs 3 different lines, all to one client", () => {
    const lines = ["Zork > a one", "Zork > b two", "Zork > c three"].map(l => item(l));
    assert.strictEqual(learned.buildRules(lines.slice(0, 2)).filter(r => r.kind === "alias").length, 0);
    assert.strictEqual(learned.buildRules(lines).filter(r => r.kind === "alias").length, 1);
    const mixed = lines.concat(item("Zork > d four", { client_id: "CLIENT - 999" }));
    assert.strictEqual(learned.buildRules(mixed).filter(r => r.kind === "alias").length, 0);
});

test("a disabled rule is left out of the lookups", () => {
    const rules = learned.buildRules([item("Foo > Bar baz")]);
    const off = learned.toLookups(rules, new Set([rules[0].id]));
    assert.strictEqual(off.exact.size, 0);
});

test("a line the manager already resolved goes straight to their project", () => {
    matcher.useLexicon(base);
    const line = "Zzq > Something odd about the fund";
    assert.strictEqual(parse(line).needs_review, true);
    matcher.useLearned(learned.toLookups(learned.buildRules([item(line)])));
    const t = parse(line);
    assert.strictEqual(t.needs_review, false);
    assert.strictEqual(t.project_id, BNP.id);
    assert.strictEqual(t.match_method, "learned");
});

test("a rule for a project that no longer exists is ignored", () => {
    matcher.useLexicon(base);
    const line = "Zzq > Something odd about the fund";
    matcher.useLearned(learned.toLookups(learned.buildRules([item(line, { project_id: "gone" })])));
    assert.strictEqual(parse(line).needs_review, true);
});

test("a taught first word settles a client tie", () => {
    matcher.useLexicon(base);
    const line = "Xyzzy > Balanced Hybrid Fund Animation";
    const before = parse(line);
    assert.ok(before.review_reasons.some(r => /more than one client/i.test(r)), before.review_reasons.join("; "));
    const lines = ["Xyzzy > one", "Xyzzy > two", "Xyzzy > three"].map(l => item(l));
    matcher.useLearned(learned.toLookups(learned.buildRules(lines)));
    const after = parse(line);
    assert.strictEqual(after.client_name, "Baroda BNP Paribas");
    assert.ok(!after.review_reasons.some(r => /more than one client/i.test(r)), after.review_reasons.join("; "));
});

test("a type the manager chose is learned and applied to the same wording", () => {
    matcher.useLexicon(base);
    const line = "Zzq > Something odd about the fund";
    const rules = learned.buildRules([item(line, { deliverable_type: "Reel / Short Video", deliverable_type_corrected: true })]);
    assert.strictEqual(rules.find(r => r.kind === "exact").deliverable_type, "Reel / Short Video");
    matcher.useLearned(learned.toLookups(rules));
    const t = parse(line);
    assert.strictEqual(t.deliverable_type, "Reel / Short Video");
    assert.strictEqual(t.learned_type, true);
});

test("the matcher's own reading of a type is not a decision", () => {
    const rules = learned.buildRules([item("Foo > Bar baz", { deliverable_type: "Carousel" })]);
    assert.strictEqual(rules.find(r => r.kind === "exact").deliverable_type, null);
});

test("a Work Sheet row changed after PMT made it is a correction; an untouched one is not", () => {
    const task = { id: "t1", raw_line: "Zzq > Something odd about the fund", client_id: "c1", work_item_id: "w1", row_snapshot: { project_id: "p0", deliverable_id: null, deliverable_type: "Other Initiatives" } };
    const same = { id: "w1", project_id: "p0", client_id: "c1", deliverable_id: null, deliverable_type: "Other Initiatives" };
    assert.deepStrictEqual(learned.sheetCorrections([task], [same]), []);

    const typeOnly = learned.sheetCorrections([task], [{ ...same, deliverable_type: "Reel / Short Video" }]);
    assert.strictEqual(typeOnly.length, 1);
    assert.strictEqual(typeOnly[0].deliverable_type_corrected, true);

    const projectOnly = learned.sheetCorrections([task], [{ ...same, project_id: "p9" }])[0];
    assert.strictEqual(projectOnly.project_id, "p9");
    assert.strictEqual(projectOnly.deliverable_type_corrected, false);   // type was not what changed

    // accepted before snapshots existed, or the row is gone: nothing to learn
    assert.deepStrictEqual(learned.sheetCorrections([{ ...task, row_snapshot: undefined }], [same]), []);
    assert.deepStrictEqual(learned.sheetCorrections([task], []), []);
});
