// Every PMT team member must be recognised by the parser and resolved to
// exactly one PMT user, test accounts included.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const roster = require("../teamRoster.json");
const store = require("../mongoStore");
const { parseTaskList } = require("../tasklistParser");

const users = roster.map((r, i) => ({ id: "u" + i, ...r }));
const names = store.assigneeNames(users);

test("every roster member is a known assignee by full name", () => {
    for (const r of roster) {
        assert.ok(names.includes(r.name), `${r.name} missing from assignee names`);
    }
});

test("every roster member resolves to themselves in their own team", () => {
    for (const u of users) {
        const team = u.department.toLowerCase();
        const { user, reason } = store.resolveAssignee(u.name, team, users);
        assert.equal(user && user.id, u.id, `${u.name}: ${reason}`);
    }
});

test("a bare first name prefers the real account over a test account", () => {
    assert.equal(store.resolveAssignee("Ratnesh", "content", users).user.name, "Ratnesh Bor");
    assert.equal(store.resolveAssignee("Vanshika", "content", users).user.name, "Vanshika Shah");
});

test("a first name that only a test account has still resolves", () => {
    assert.equal(store.resolveAssignee("Bhashwati", "design", users).user.name, "Bhashwati Testing");
    assert.equal(store.resolveAssignee("disha", "design", users).user.name, "disha test");
});

test("a name in the wrong team is still sent to review", () => {
    assert.equal(store.resolveAssignee("Tejas", "design", users).user, null);
});

test("animation tasklists parse and reach the animation team", () => {
    const parsed = parseTaskList("Animation Team\nKaushal Shah\n- ICICI TVC - Edit", names);
    assert.equal(parsed.team, "animation");
    assert.equal(parsed.tasks[0].assignee, "Kaushal Shah");
    assert.equal(store.resolveAssignee("Kaushal Shah", "animation", users).user.name, "Kaushal Shah");
});

test("a full-name assignee line with a test account is parsed", () => {
    const parsed = parseTaskList("Design Team\nBhashwati Testing\n- ICICI TVC - Edit", names);
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.tasks[0].assignee, "Bhashwati Testing");
    assert.deepEqual(parsed.warnings, []);
});


test("'Meetings for today' is a calls section, not an assignee", () => {
    const text = `*Content Team*

Sakshi
BBNPP - AV changes

Meetings for today
- ⁠interviews - sakshi`;

    const parsed = parseTaskList(text, ["Sakshi", "Vanshika"]);

    assert.ok(
        !parsed.tasks.some(t => /meetings/i.test(t.assignee || "")),
        "Meetings for today must not become an assignee"
    );
    assert.ok(
        !(parsed.warnings || []).some(w => /Meetings for today/i.test(w)),
        "no 'not in ASSIGNEES' warning for the meetings heading"
    );
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].topic, "interviews");
    assert.equal(parsed.calls[0].owner, "Sakshi");
});
