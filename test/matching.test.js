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

test("a comma between deliverables makes separate entries", () => {
    const tasks = parse(["- Ipru Power ETF - Campaign ideation", "- TFP Premium - 1 IG, 1 Minimalist"]);
    assert.strictEqual(tasks.length, 3);
    assert.deepStrictEqual(tasks.slice(1).map(t => t.raw_line),
        ["- TFP Premium - 1 IG", "- TFP Premium - 1 Minimalist"]);
    assert.deepStrictEqual(tasks.slice(1).map(t => t.deliverable_name), ["1 IG", "1 Minimalist"]);
    assert.ok(tasks.slice(1).every(t => /premium/i.test(t.project_name)));
});

test("commas inside brackets, numbers or the project name are not split", () => {
    assert.strictEqual(parse(["- Bajaj Finserv Presentation - Moats (Large, Mid)"]).length, 1);
    assert.strictEqual(parse(["- Invesco Concept IEP PPT - Sizes 1,000 pcs"]).length, 1);
    assert.strictEqual(parse(["- ICICI Prudential, Bajaj Brochures"]).length, 1);
});

test("text after the comma part (priority) is kept on every entry", () => {
    const tasks = parse(["- TFP Premium - 1 IG, 1 Minimalist - High Priority"]);
    assert.strictEqual(tasks.length, 2);
    assert.ok(tasks.every(t => t.priority));
});
