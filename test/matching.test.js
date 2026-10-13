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

test("a priority word after the comma part is dropped from every entry", () => {
    const tasks = parse(["- TFP Premium - 1 IG, 1 Minimalist - High Priority"]);
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks.map(t => t.deliverable_name), ["1 IG", "1 Minimalist"]);
    assert.ok(tasks.every(t => !t.priority));
});

test("Ipru Power ETF - Campaign ideation: project, with 'Campaign ideation' as the deliverable", () => {
    const [t] = parse(["- Ipru Power ETF - Campaign ideation"]);
    assert.match(t.client_name, /ICICI Prudential Mutual Fund/);
    assert.strictEqual(t.project_name, "IPru Power ETF Campaign");
    assert.match(t.deliverable_name, /^Campaign ideation$/i);
    assert.strictEqual(t.needs_review, false);
});

test("priority words are dropped everywhere and never stored", () => {
    for (const line of [
        "- TFP Premium - 1 IG - High Priority",
        "- TFP Premium - High Priority - 1 IG",
        "- TFP Premium - 1 IG (urgent priority)"
    ]) {
        const [t] = parse([line]);
        assert.ok(!t.priority, line);
        assert.ok(!/priority/i.test(t.deliverable_name || ""), line);
        assert.strictEqual(t.deliverable_name, "1 IG", line);
    }
});

// ---- headers naming several people --------------------------------
const { isTaskListMessage } = require("../tasklistParser");

const MULTI = [
    "*&#x20;Design Tasklist*", "",
    "*Shraddha Manali*", "ABSL PPT first for design approval", "",
    "*Shubham*", "Canara Robeco Navratri Post", "",
    "*Aniket, Vaishnavi*", "ABSL Emerging Market storyboard once content is approved", "",
    "*Nutan, Sanjana*", "IPRU Pharma pending creatives", "",
    "*Aniket / Shubham*", "Design discussion for pen stand calculator for SIP + SWP", "",
    "*Nutan*", "Your US Exposure, From GIFT City"
].join("\n");

const PEOPLE = ["Shraddha", "Manali", "Shubham", "Aniket", "Vaishnavi", "Nutan", "Sanjana", "Anjali"];

test("an entity-garbled bold header is still recognised as a tasklist", () => {
    assert.strictEqual(isTaskListMessage(MULTI), true);
});

test("a header with several names gives every person the task", () => {
    const r = parseTaskList(MULTI, PEOPLE);
    const who = line => r.tasks.filter(t => t.raw_line.startsWith(line)).map(t => t.assignee).sort();
    assert.deepStrictEqual(who("ABSL PPT first"), ["Manali", "Shraddha"]);
    assert.deepStrictEqual(who("ABSL Emerging"), ["Aniket", "Vaishnavi"]);
    assert.deepStrictEqual(who("IPRU Pharma"), ["Nutan", "Sanjana"]);
    assert.deepStrictEqual(who("Design discussion"), ["Aniket", "Shubham"]);
    assert.deepStrictEqual(who("Canara"), ["Shubham"]);
    assert.strictEqual(r.tasks.length, 10);
    assert.deepStrictEqual(r.warnings, []);
});

test("a comma inside an unbulleted task line is not a second deliverable or a header", () => {
    const r = parseTaskList(MULTI, PEOPLE);
    const t = r.tasks.find(x => x.raw_line.startsWith("Your US Exposure"));
    assert.strictEqual(t.assignee, "Nutan");
    assert.match(t.deliverable_name, /Your US Exposure, From GIFT City/);
});

test("an unknown name in a bold multi-name header still gets its tasks, with a warning", () => {
    const r = parseTaskList("Design Tasklist\n\n*Aniket, Newperson*\nABSL PPT", ["Aniket"]);
    assert.deepStrictEqual(r.tasks.map(t => t.assignee).sort(), ["Aniket", "Newperson"]);
    assert.ok(r.warnings.some(w => /Newperson/.test(w)));
});

test("a count of 2 or more makes one entry per unit, each '1 <thing>'", () => {
    const tasks = parse(["- TFP Premium - 2 Minimalist"]);
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks.map(t => t.deliverable_name), ["1 Minimalist", "1 Minimalist"]);
    assert.deepStrictEqual(tasks.map(t => [t.copy_index, t.copy_total]), [[1, 2], [2, 2]]);
});

test("a count works together with the comma split, and plurals become singular", () => {
    const tasks = parse(["TFP premium scripting - 1 Reel, 1 infographic, 2 Minimalist", "TFP premium scripting - 3 Carousels"]);
    assert.deepStrictEqual(tasks.map(t => t.deliverable_name),
        ["1 Reel", "1 infographic", "1 Minimalist", "1 Minimalist", "1 Carousel", "1 Carousel", "1 Carousel"]);
    assert.ok(tasks.slice(0, 2).every(t => t.copy_total === undefined));
});

test("a count of 1, a lone number, or two counts in one line are not split", () => {
    assert.strictEqual(parse(["- TFP Premium - 1 Minimalist"]).length, 1);
    assert.strictEqual(parse(["TFP reviews- 10"]).length, 1);
    assert.strictEqual(parse(["- TFP Premium - 2 Reels - 3 Carousels"]).length, 1);
    assert.strictEqual(parse(["- Invesco Concept IEP PPT - Sizes 1,000 pcs"]).length, 1);
});
