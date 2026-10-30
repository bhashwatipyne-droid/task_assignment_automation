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

test("one person filing a line differently does not cancel what ten others agreed on", () => {
    const same = n => Array.from({ length: n }, () => item("FT > 30 Years > Brand Film > Campaign Ideation (Today first half)", { deliverable_id: "d1" }));
    // ten agree on project and deliverable, one chose another deliverable in the same project
    const rules = learned.buildRules([...same(10), item("- FT > 30 Years > Brand Film > Campaign Ideation", { deliverable_id: "d2" })]);
    const exact = rules.filter(r => r.kind === "exact");
    assert.strictEqual(exact.length, 1);
    assert.strictEqual(exact[0].project_id, BNP.id);
    assert.strictEqual(exact[0].deliverable_id, "d1");
    assert.strictEqual(exact[0].count, 11);

    // the same line resolved to a different PROJECT by one person: the ten still win
    const dissent = learned.buildRules([...same(10), item("FT > 30 Years > Brand Film > Campaign Ideation", { project_id: "other" })]);
    assert.strictEqual(dissent.find(r => r.kind === "exact").project_id, BNP.id);
});

test("a split line still sends to the project but leaves the deliverable open", () => {
    const rules = learned.buildRules([
        item("Foo > Bar baz", { deliverable_id: "d1" }), item("Foo > Bar baz", { deliverable_id: "d1" }),
        item("Foo > Bar baz", { deliverable_id: "d2" }), item("Foo > Bar baz", { deliverable_id: "d2" })
    ]);
    const exact = rules.find(r => r.kind === "exact");
    assert.strictEqual(exact.project_id, BNP.id);
    assert.strictEqual(exact.deliverable_id, null);
});

test("a real split or a thin majority on the project makes no rule", () => {
    const split = (a, b) => [
        ...Array.from({ length: a }, () => item("Foo > Bar baz")),
        ...Array.from({ length: b }, () => item("Foo > Bar baz", { project_id: "other" }))
    ];
    assert.strictEqual(learned.buildRules(split(2, 2)).filter(r => r.kind === "exact").length, 0);
    assert.strictEqual(learned.buildRules(split(2, 1)).filter(r => r.kind === "exact").length, 0);
    assert.strictEqual(learned.buildRules(split(3, 1)).filter(r => r.kind === "exact").length, 1);
});

const typed = (line, type) => item(line, { deliverable_type: type, deliverable_type_corrected: true });
const REVIEWS = "Team Reviews and Feedback";

test("a line's closing word is its last word, without timing notes or date stamps", () => {
    assert.strictEqual(learned.closerKey("- TFP Premium > Diwali Campaign > Scripting Reviews"), "review");
    assert.strictEqual(learned.closerKey("TFP > Diwali > Script Review (6)"), "review");
    assert.strictEqual(learned.closerKey("TFP > My Parents Portfolio vs Mine > Reel > 30-10-2026 | 6:00 pm"), "reel");
    assert.strictEqual(learned.closerKey("Invesco Large Cap PPT"), "");          // no arrow, no closing part
});

test("a closing word typed to one type on 3 different lines becomes a rule; fewer or mixed does not", () => {
    const lines = ["Foo > a > Data Review", "Foo > b > Script Review (6)", "Foo > c > Scripting Reviews"];
    const three = learned.buildRules(lines.map(l => typed(l, REVIEWS)));
    const rule = three.find(r => r.kind === "closer");
    assert.strictEqual(rule.key, "review");
    assert.strictEqual(rule.deliverable_type, REVIEWS);
    assert.strictEqual(rule.count, 3);

    assert.strictEqual(learned.buildRules(lines.slice(0, 2).map(l => typed(l, REVIEWS))).filter(r => r.kind === "closer").length, 0);
    const mixed = lines.map(l => typed(l, REVIEWS)).concat(typed("Foo > d > Data Reviews", "Changes"));
    assert.strictEqual(learned.buildRules(mixed).filter(r => r.kind === "closer").length, 0);
    // a type the matcher only read itself is not a decision
    assert.strictEqual(learned.buildRules(lines.map(l => item(l, { deliverable_type: REVIEWS }))).filter(r => r.kind === "closer").length, 0);
});

test("a learned closing word fills the type of a line nothing else could read", () => {
    matcher.useLexicon(base);
    const rules = learned.buildRules(
        ["Foo > a > Final Polish", "Foo > b > Quick Polish", "Foo > c > Polish"].map(l => typed(l, "Poster"))
    );
    const line = "Zzq > Something odd about the fund > Last Polish";
    assert.ok(!parse(line).deliverable_type);
    matcher.useLearned(learned.toLookups(rules));
    const t = parse(line);
    assert.strictEqual(t.deliverable_type, "Poster");
    assert.strictEqual(t.learned_type, true);

    // the closing word itself ("Carousel") still comes first
    const carousel = learned.buildRules(
        ["Foo > a > Carousel", "Foo > b > Carousel", "Foo > c > Carousel"].map(l => typed(l, "Poster"))
    );
    matcher.useLearned(learned.toLookups(carousel));
    assert.strictEqual(parse("Zzq > Something odd about the fund > Carousel").deliverable_type, "Carousel");
});

test("a closing 'changes' is Changes and a closing 'review' is Team Reviews and Feedback", () => {
    matcher.useLexicon(base);
    const type = line => parse("Zzq > Something odd about the fund > " + line).deliverable_type;
    assert.strictEqual(type("Reel changes"), "Changes");                          // not Reel
    assert.strictEqual(type("PPT internal changes (Today First half)"), "Changes"); // not PPT
    assert.strictEqual(type("Meet the crew IG changes (today first half) Delayed"), "Changes"); // not IG
    assert.strictEqual(type("Review & Changes"), "Changes");
    assert.strictEqual(type("Review"), REVIEWS);
    assert.strictEqual(type("Scripting Reviews"), REVIEWS);
    assert.strictEqual(type("Script Review (6)"), REVIEWS);
    // PMT keeps it over a matched deliverable's own type
    assert.strictEqual(parse("Zzq > Something odd about the fund > Reel changes").type_wins, true);
    assert.strictEqual(parse("Zzq > Something odd about the fund > Carousel").type_wins, false);
});

test("'finalisation' after a type word still reads the type; with 'changes' after it, it is Changes", () => {
    matcher.useLexicon(base);
    const type = line => parse("Zzq > Something odd about the fund > " + line).deliverable_type;
    assert.strictEqual(type("Minimalist finalisation"), "Minimalist");
    assert.strictEqual(type("Minimalist finalization (Today first half)"), "Minimalist");
    assert.strictEqual(type("2 Minimalist finalisation with internal changes"), "Changes");
    assert.ok(!type("Script TBD upon script finalisation"));
});

test("a type is read past a trailing date, after an underscore, and from 'web based research'", () => {
    matcher.useLexicon(base);
    assert.strictEqual(parse("Zzq > Something odd about the fund > Reel > 30-10-2026").deliverable_type, "Reel / Short Video");
    assert.strictEqual(parse("Zzq > Something odd about the fund > Reel > 30-10-2026 | 6:00 pm").deliverable_type, "Reel / Short Video");
    assert.strictEqual(parse("Zzq > Something odd about the fund 2024_Reel").deliverable_type, "Reel / Short Video");
    assert.strictEqual(parse("Zzq > Something odd about the fund > Web Based Research").deliverable_type, "Data Research and Analysis (Web)");
    // a date on its own is still not a type
    assert.ok(!parse("Zzq > Something odd about the fund > 30-10-2026").deliverable_type);
});

test("IG always means One Pager / Infographic, wherever it sits in the closing part", () => {
    matcher.useLexicon(base);
    const IG = "One Pager / Infographic";
    assert.strictEqual(parse("Zzq > Something odd about the fund > IG").deliverable_type, IG);
    assert.strictEqual(parse("Zzq > Something odd about the fund > SIF tool Kit Seties IG 3 (first cut today end of the day)").deliverable_type, IG);
    assert.strictEqual(parse("Zzq > Something odd about the fund > Meet the crew IG finalisation (today first half)").deliverable_type, IG);
    // "changes" after it makes it Changes (see the changes / review test)
    assert.strictEqual(parse("Zzq > Something odd about the fund > Meet the crew IG changes").deliverable_type, "Changes");
    // only the word IG: other words that contain the letters are not it
    assert.ok(!parse("Zzq > Something odd about the fund > Digital Gold").deliverable_type);
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

test("plain video, data plug in and a title ending in reel get their types; 'discussed' stays untyped", () => {
    matcher.useLexicon(base);
    const type = line => parse("Zzq > Something odd about the fund > " + line).deliverable_type;
    assert.strictEqual(type("Shoot video"), "Long Video");
    assert.strictEqual(type("Video"), "Long Video");
    assert.strictEqual(type("Data plug in"), "Data Updation");
    assert.strictEqual(type("Same game different strategy reel"), "Reel / Short Video");
    assert.strictEqual(parse("Zzq > Something odd about the fund 2024_Behavior_Video").deliverable_type, "Long Video");
    // held for learning, not guessed
    assert.ok(!type("Script TBD upon script discussed"));
});
