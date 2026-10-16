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

test("identical text from two different lines is kept, the same line typed twice is not", () => {
    const tasks = parse([
        "TFP premium scripting - 1 Carousel, data analysis SMI",
        "TFP premium scripting - 1 minimalist, data analysis SMI"
    ]);
    const smi = tasks.filter(t => /data analysis smi/i.test(t.raw_line));
    assert.strictEqual(smi.length, 2);
    assert.deepStrictEqual(smi.map(t => t.dup_index), [undefined, 2]);

    const twice = parse(["- TFP Premium - 1 IG, 1 Minimalist", "- TFP Premium - 1 IG, 1 Minimalist"]);
    // a literal repeat of a line is still the same entries (the store drops it)
    assert.ok(twice.filter(t => t.dup_index).every(t => t.dup_index >= 2));
});

// ---------------------------------------------------------------
// edge cases from the 13 Oct Design tasklist
// ---------------------------------------------------------------

test("a comma inside a deliverable that exists in PMT is not a split", () => {
    const tasks = parse(["FT US Equity - Your US Exposure, From GIFT City - Minimalist"]);
    assert.strictEqual(tasks.length, 1);
    assert.match(tasks[0].deliverable_name, /Your US Exposure, From GIFT City/);
    // a real comma-separated list is still split
    assert.strictEqual(parse(["- TFP Premium - 1 Reel, 1 Carousel"]).length, 2);
});

test("an underscore is a space: 'ABSL_Emerging market storyboard' finds its client", () => {
    const [t] = parse(["ABSL_Emerging market storyboard"]);
    assert.match(t.client_name, /Aditya Birla/);
    assert.ok(!t.review_reasons.some(r => /guessed/.test(r)), t.review_reasons.join("; "));
});

test("'sr citizen' is 'senior citizen'", () => {
    const [t] = parse(["FT sr citizen - Creative 1 (MInimalist)"]);
    assert.match(t.project_name, /Senior Citizen/);
    assert.ok(!t.review_reasons.some(r => /Weak project/.test(r)), t.review_reasons.join("; "));
});

test("'once scripts are approved' is a note, and the project is not a coin flip", () => {
    const [t] = parse(["ICICI Pharma-creatives once scripts are approved"]);
    assert.match(t.notes, /once scripts are approved/);
    assert.match(t.project_name, /Pharma ETF/);
    assert.ok(!t.review_reasons.some(r => /^Ambiguous project/.test(r)), t.review_reasons.join("; "));
});

test("a runner-up that only shares a generic word does not make the project ambiguous", () => {
    const [t] = parse(["Icici Fund Guides (Review)"]);
    assert.ok(!t.review_reasons.some(r => /^Ambiguous project/.test(r)), t.review_reasons.join("; "));
});

test("two booklet projects with only 'booklet' to go on are still ambiguous; a language picks the translation one", () => {
    const [t] = parse(["Amfi booklet"]);
    assert.ok(t.review_reasons.some(r => /^Ambiguous project/.test(r)));

    const [k] = parse(["Amfi booklet - kannada"]);
    assert.match(k.project_name, /Translation/);
    assert.ok(!k.review_reasons.some(r => /^Ambiguous project/.test(r)), k.review_reasons.join("; "));
});

test("a full deliverable name that exists once in PMT needs no confirmation; a generic one still does", () => {
    const [t] = parse(["Stay Focused Without Losing the Bigger Picture"]);
    assert.match(t.client_name, /Franklin/);
    assert.ok(t.project_name);
    assert.deepStrictEqual(t.review_reasons, []);

    // shared, generic names are still held for a manager
    const [g] = parse(["Teaser"]);
    assert.strictEqual(g.needs_review, true);
    assert.ok(g.review_reasons.some(r => /deliverable name only/.test(r)));
});

test("'BBNP' is Baroda BNP Paribas, named in the text (not guessed)", () => {
    const [t] = parse(["BBNP Balanced Hybrid fund AV - Changes"]);
    assert.strictEqual(t.client_name, "Baroda BNP Paribas");
    assert.strictEqual(t.client_source, "name in text");
    assert.ok(!t.review_reasons.some(r => /guessed/.test(r)), t.review_reasons.join("; "));
});

test("a plural deliverable followed by a count makes that many entries", () => {
    const tasks = parse(["Bajaj One pagers 7"]);
    assert.strictEqual(tasks.length, 7);
    assert.ok(tasks.every(t => /One pager$/.test(t.raw_line)));
    assert.deepStrictEqual(tasks.map(t => t.copy_index), [1, 2, 3, 4, 5, 6, 7]);
    // a singular label with a number is not a quantity
    assert.strictEqual(parse(["- Senior Citizen - Creative 2 (Infographic)"]).length, 1);
    assert.strictEqual(parse(["Phase 2"]).length, 1);
});

test("a line that is exactly a one-word project name picks that project, not a longer one repeating the word", () => {
    const [t] = parse(["Bajaj mappings"]);
    assert.strictEqual(t.project_name, "Bajaj Mappings");
    assert.ok(!t.review_reasons.some(r => /^Ambiguous project|^Weak project/.test(r)), t.review_reasons.join("; "));
});

test("two live projects that both fit the line stay held for review", () => {
    const [t] = parse(["Absl calendar changes"]);
    assert.ok(t.review_reasons.some(r => /^Ambiguous project/.test(r)), t.review_reasons.join("; "));
});

test("a PPT line settles a tie on the PPT project, not on the video one", () => {
    const [t] = parse(["ABSL India Growth fund PPT review"]);
    assert.strictEqual(t.project_name, "ABSL India Growth Fund - story & design for ppt");
    assert.ok(!t.review_reasons.some(r => /^Ambiguous project/.test(r)), t.review_reasons.join("; "));
});

test("a storyboard / shoot AV line is not given to a ppt project that scores a little higher", () => {
    const [t] = parse(["ABSL India Growth Shoot AV storyboard - Delivery today"]);
    assert.strictEqual(t.project_name, "ABSL India Growth Fund Explainer Video");
});

test("a line that names no kind of work still goes to review on a real tie", () => {
    const [t] = parse(["Absl calendar changes"]);
    assert.ok(t.review_reasons.some(r => /^Ambiguous project/.test(r)), t.review_reasons.join("; "));
});

test("'multicap' and 'Multi Cap' are the same word for matching", () => {
    const [a] = parse(["ITI multicap - Campaign"]);
    const [b] = parse(["ITI multi cap - Campaign"]);
    assert.match(a.project_name || "", /multi cap/i);
    assert.strictEqual(a.project_name, b.project_name);
    assert.strictEqual(a.needs_review, b.needs_review);
});

test("a distinctive project word that only one client has needs no client confirmation", () => {
    const [t] = parse(["BBNPP - AV changes"]);
    assert.match(t.client_name || "", /baroda/i);
    assert.match(t.project_name || "", /BBNPP ESG/i);
    assert.ok(!t.review_reasons.some(r => /guessed/i.test(r)), t.review_reasons.join("; "));
});
