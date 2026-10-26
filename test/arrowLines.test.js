"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseTaskList } = require("../tasklistParser");

const PEOPLE = ["Vanshika", "Krupali", "Ratnesh"];

const parse = (lines, tail = "") =>
    parseTaskList("Content Team\n\nVanshika\n" + lines.join("\n") + tail, PEOPLE);

const one = line => parse([line]).tasks[0];


// ---- the closing word of a line is the deliverable type -------------------

test("a closing type word becomes the PMT deliverable type", () => {
    const cases = [
        ["Carousel", "Carousel"],
        ["Reel", "Reel / Short Video"],
        ["Infographic", "One Pager / Infographic"],
        ["Web Based Data", "Data Research and Analysis (Web)"]
    ];
    for (const [word, type] of cases) {
        const t = one(`- TFP Premium > Diwali Campaign > Festive Spending Without January Regret > ${word}`);
        assert.strictEqual(t.deliverable_type, type, word);
        assert.strictEqual(t.type_source, "line", word);
    }
});

test("the type word stays in the name so two jobs on one article stay apart", () => {
    const a = one("- TFP Premium > Diwali Campaign > The Family Money Meeting > Carousel");
    const b = one("- TFP Premium > Diwali Campaign > The Family Money Meeting > Infographic");
    assert.notStrictEqual(a.deliverable_name, b.deliverable_name);
    assert.match(a.deliverable_name, /Carousel$/);
});

test("a title that only contains a type word is not read as a type", () => {
    const t = one("- TFP Premium > Diwali Campaign > Reel Rates Explained For Investors");
    assert.strictEqual(t.deliverable_type, null);
});

test("Campaign Ideation (2) gets the campaign ideation type and keeps the (2)", () => {
    const t = one("- TFP Premium >  2026 November > Campaign Ideation (2)");
    assert.strictEqual(t.deliverable_type, "Campaign Ideation Plan (Includes Keywords)");
    assert.strictEqual(t.notes, "2");
});

test("Data Research & Analysis is not guessed between Web and SMI", () => {
    for (const closing of ["Data Research & Analysis", "Data Analysis and Research"]) {
        const t = one(`- TFP Premium > Diwali Campaign > A Financial Clean-Up Before the New Samvat > ${closing}`);
        assert.strictEqual(t.deliverable_type, null, closing);
        assert.deepStrictEqual(t.type_candidates, [
            "Data Research and Analysis (Web)",
            "Data Research and Analysis (SMI)"
        ]);
    }
});

test("a line with no closing type leaves the type empty", () => {
    const t = one("- TFP Premium > Topic & Pipeline Planning");
    assert.strictEqual(t.deliverable_type, null);
    assert.deepStrictEqual(t.type_candidates, []);
});


// ---- "Review" inside an article title is part of the title ----------------

test("Review inside a long title is kept and is not the action", () => {
    const t = one("- TFP Premium > Diwali Campaign > The Diwali Money Reset: 5 Numbers to Review Before the New Year > Carousel");
    assert.match(t.deliverable_name, /5 Numbers to Review Before the New Year/);
    assert.strictEqual(t.action, null);
});

test("a closing Review is still the action", () => {
    const t = one("- Invesco > Conceptual PPT > Large Cap PPT > Review & Changes");
    assert.strictEqual(t.action, "Review + Changes");
    assert.doesNotMatch(t.deliverable_name || "", /review|changes/i);
});

test("a title with Review and a closing Review keeps one and takes the other", () => {
    const t = one("- TFP Premium > Diwali Campaign > Five Numbers to Review Before the New Year > Review");
    assert.strictEqual(t.action, "Review");
    assert.match(t.deliverable_name, /Numbers to Review Before/);
});

test("a line without arrows reads its action words as before", () => {
    const t = one("- Invesco Concept IEP PPT - Review & Changes");
    assert.strictEqual(t.action, "Review + Changes");
});


// ---- a title ending in a plural word and a number is not a quantity --------

test("an article title ending in a number is not expanded into copies", () => {
    const tasks = parse(["- TFP Premium > Diwali Campaign > Top Mutual Funds 5"]).tasks;
    assert.strictEqual(tasks.length, 1);
    assert.match(tasks[0].deliverable_name, /Top Mutual Funds 5/);
});

test("a comma inside an article title does not split the line", () => {
    const tasks = parse([
        "- TFP Premium > Diwali Campaign > Bonus, Gift or Windfall: Where Should the Money Go First? > Carousel"
    ]).tasks;
    assert.strictEqual(tasks.length, 1);
    assert.match(tasks[0].deliverable_name, /Bonus, Gift or Windfall/);
});


// ---- meetings and interviews ----------------------------------------------

const CALLS = [
    "",
    "",
    "Meetings:",
    "- ABSL > Children's Financial Literacy > Internal Campaign Discussion > Team",
    "- ICICI > Multi Asset Campaign > Client Campaign Discussion > Ratnesh | Vanshika",
    "- Invesco > Small Cap Sales Enabler > Internal Campaign Ideas Discussion > Vanshika | Krupali",
    "",
    "Interview:",
    "- Assignment Review > Chayan > Vanshika"
].join("\n");

test("meeting owners are read from the closing part after an arrow", () => {
    const { calls } = parse(["- TFP Premium > Carousel"], CALLS);
    const byTopic = topic => calls.find(c => c.topic.startsWith(topic));

    assert.deepStrictEqual(byTopic("ABSL").owners, ["Team"]);
    assert.deepStrictEqual(byTopic("ICICI").owners, ["Ratnesh", "Vanshika"]);
    assert.deepStrictEqual(byTopic("Invesco").owners, ["Vanshika", "Krupali"]);
    assert.strictEqual(byTopic("ICICI").owner, "Ratnesh | Vanshika");
    assert.doesNotMatch(byTopic("ICICI").topic, /Vanshika/);
});

test("Interview: is a section heading, not a call of its own", () => {
    const { calls } = parse(["- TFP Premium > Carousel"], CALLS);
    assert.strictEqual(calls.length, 4);
    assert.ok(!calls.some(c => /^Interview:?$/i.test(c.topic)));

    const interview = calls.find(c => c.topic.startsWith("Assignment Review"));
    assert.strictEqual(interview.kind, "interview");
    assert.deepStrictEqual(interview.owners, ["Vanshika"]);
    assert.strictEqual(calls[0].kind, "meeting");
});

test("a call whose closing part is not a known person keeps its whole text", () => {
    const { calls } = parse(["- TFP Premium > Carousel"], "\n\nMeetings:\n- ICICI > Client Discussion > Chayan");
    assert.strictEqual(calls[0].owner, null);
    assert.deepStrictEqual(calls[0].owners, []);
    assert.strictEqual(calls[0].topic, "ICICI > Client Discussion > Chayan");
});

test("dash calls still read their owner", () => {
    const { calls } = parse(["- TFP Premium > Carousel"], "\n\nCalls for today:\n- ICICI TVC - Vanshika");
    assert.strictEqual(calls[0].topic, "ICICI TVC");
    assert.strictEqual(calls[0].owner, "Vanshika");
    assert.strictEqual(calls[0].kind, "call");
});
