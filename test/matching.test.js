"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseTaskList } = require("../tasklistParser");

const parse = lines => parseTaskList(
    "Design tasklist\n\nBhashwati Testing\n" + lines.join("\n"), ["Bhashwati Testing"]
).tasks;

test("a bare deliverable name never goes straight to an assignee", () => {
    const [t] = parse(["Teaser"]);
    // may be guessed as some client, but a manager must confirm it
    assert.strictEqual(t.needs_review, true);
});

test("Invesco lines are never silently turned into another client", () => {
    for (const t of parse(["Invesco Concept IEP PPT", "Invesco"])) {
        if (t.client_name) assert.match(t.client_name, /invesco/i);
    }
});

test("client + project named in full is not blocked by the bare-deliverable rule", () => {
    const [t] = parse(["ICICI Prudential Pharma - From Lab to Life"]);
    assert.ok(!t.review_reasons.some(r => /deliverable name only/.test(r)));
    assert.match(t.client_name || "", /icici/i);
});
