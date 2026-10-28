"use strict";
// "TFP > <deliverable>": TFP is a family of monthly projects (TFP Oct-26, TFP May-26 ...).
// The deliverable decides which month. See familyPick() in tasklistMatcher.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const matcher = require("../tasklistMatcher");
const { parseTaskList } = require("../tasklistParser");
const { toTokens, words } = require("../textUtils");
const { CLIENT_ALIASES } = require("../clientAliases");

const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lexicon.json"), "utf8"));

const parse = line => parseTaskList("Animation tasklist\n\nTejas\n" + line, ["Tejas"]).tasks[0];

// the lexicon plus extra deliverables under one project
function withDeliverables(projectName, names) {
    const lex = JSON.parse(JSON.stringify(base));
    const proj = lex.projects.find(p => p.name === projectName);
    const client = lex.clients.find(c => c.id === proj.client_id);
    const phrases = (CLIENT_ALIASES[client.name] || [])
        .concat([client.name])
        .map(words)
        .sort((a, b) => b.length - a.length);
    names.forEach((n, i) => lex.deliverables.push({
        id: "test-" + i, name: n, project_id: proj.id, client_id: proj.client_id,
        toks: toTokens(n, phrases), upd: lex.deliverables[0].upd
    }));
    return lex;
}

test.afterEach(() => { matcher.useLexicon(base); });

test("TFP + a deliverable that lives in one month: that month's project is used, no review", () => {
    matcher.useLexicon(base);
    const t = parse("TFP > Healthy Habits, Wealthy Life - What's inside matters Reel changes");
    assert.strictEqual(t.project_name, "TFP May-26");
    assert.strictEqual(t.needs_review, false);
});

test("a short generic deliverable in another TFP project does not beat the better explained one", () => {
    // "Diwali" (TFP Premium) scores as high as the real one, but explains far less
    matcher.useLexicon(withDeliverables("TFP Oct-26", [
        "Brighter Diwali. A Smarter Portfolio",
        "The Diwali Sectoral Look: 5 Crackers You Should Look At",
        "Gold at Diwali: Jewellery, Coins, ETFs or Sovereign Gold Bonds?"
    ]));
    const t = parse("TFP > Brighter Diwali Reel");
    assert.strictEqual(t.project_name, "TFP Oct-26");
    assert.strictEqual(t.needs_review, false);
});

test("a lone weak match is held, not guessed", () => {
    // only the generic "Diwali" (TFP Premium) exists: nothing confirms it
    matcher.useLexicon(base);
    const t = parse("TFP > Brighter Diwali Reel");
    assert.strictEqual(t.needs_review, true);
    assert.ok(!/TFP Premium/.test(t.project_name || ""));
});

test("an abbreviation with a deliverable that does not exist is still held", () => {
    matcher.useLexicon(base);
    const t = parse("BBNPP > Balanced Hybrid Fund Animation");
    assert.strictEqual(t.needs_review, true);
});

test("a line opening with a word only one client uses is not called ambiguous between clients", () => {
    matcher.useLexicon(base);
    const t = parse("BBNPP > Balanced Hybrid Fund Animation");
    assert.strictEqual(t.client_name, "Baroda BNP Paribas");
    assert.ok(!t.review_reasons.some(r => /more than one client/i.test(r)), t.review_reasons.join("; "));
});
