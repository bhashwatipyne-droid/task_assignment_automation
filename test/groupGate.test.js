"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const gate = require("../groupGate");

test.afterEach(() => {
    delete process.env.ALLOWED_GROUP_JIDS;
    delete process.env.ALLOWED_GROUP_NAMES;
});

test("names only: matches ignoring case, spacing and width", () => {
    process.env.ALLOWED_GROUP_NAMES = "Content Team, Design Team";
    assert.equal(gate.isGroupAllowed("1@g.us", "  content   TEAM "), true);
    assert.equal(gate.isGroupAllowed("1@g.us", "Sales"), false);
    assert.equal(gate.isGroupAllowed("1@g.us", undefined), false);
});

test("names only: delete / edit notices are accepted as before", () => {
    process.env.ALLOWED_GROUP_NAMES = "Content Team";
    assert.equal(gate.isUpdateAllowed("anything@g.us"), true);
});

test("ids set: the id is the only check", () => {
    process.env.ALLOWED_GROUP_NAMES = "Content Team";
    process.env.ALLOWED_GROUP_JIDS = "120363000000000001@g.us, 120363000000000002@G.US";
    assert.equal(gate.isGroupAllowed("120363000000000001@g.us", "Renamed group"), true);
    assert.equal(gate.isGroupAllowed("120363000000000002@g.us", "x"), true);
    assert.equal(gate.isGroupAllowed("120363999999999999@g.us", "Content Team"), false);   // same name, other group
});

test("ids set: delete / edit notices from other groups are ignored", () => {
    process.env.ALLOWED_GROUP_JIDS = "120363000000000001@g.us";
    assert.equal(gate.isUpdateAllowed("120363000000000001@g.us"), true);
    assert.equal(gate.isUpdateAllowed("120363999999999999@g.us"), false);
});

test("nothing configured: nothing is allowed", () => {
    assert.equal(gate.isGroupAllowed("1@g.us", "Content Team"), false);
});
