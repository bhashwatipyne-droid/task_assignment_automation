// Tie-breakers: the type of deliverable a line asks for, and how recent a project is.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const matcher = require("../tasklistMatcher");
const { buildLexicon } = require("../lexiconBuilder");

const CLIENTS = [{ id: "C1", name: "Bandhan" }];

function resolveWith(projects, deliverables, line) {
    matcher.useLexicon(buildLexicon(projects, deliverables, CLIENTS));
    return matcher.resolveLine(line);
}

const P = (id, extra = {}) => ({ id, name: "Balanced Advantage Campaign", client_id: "C1", status: "Active", hidden: false, ...extra });
const D = (id, project_id, name, type, extra = {}) => ({ id, project_id, name, type, ...extra });

test("a 2019 project loses to this year's project with the same name", () => {
    const old = P("OLD", { start_date: "2019-03-01", end_date: "2019-06-30" });
    const now = P("NEW", { start_date: "2026-09-01", end_date: "2026-10-30" });
    const r = resolveWith([old, now], [
        D("d1", "OLD", "Launch Teaser", "Teaser", { end_dt: "2019-06-01" }),
        D("d2", "NEW", "Launch Teaser", "Teaser", { end_dt: "2026-10-01" })
    ], "Bandhan Balanced Advantage Campaign");
    assert.equal(r.project_id, "NEW");
});

test("AV picks the close project that has a video, not the one with only a carousel", () => {
    const a = P("A", { start_date: "2026-10-01", end_date: "2026-10-30" });
    const b = P("B", { start_date: "2026-10-01", end_date: "2026-10-30" });
    const r = resolveWith([a, b], [
        D("d1", "A", "Social Post", "Carousel", { end_dt: "2026-10-10" }),
        D("d2", "B", "Launch Film", "Long Video", { end_dt: "2026-10-10" })
    ], "Bandhan Balanced Advantage Campaign - AV");
    assert.equal(r.project_id, "B");
});

test("the type decides between two deliverables of the project that score alike", () => {
    const r = resolveWith([P("A", { end_date: "2026-10-30" })], [
        D("d1", "A", "Festival Creative Hindi", "Carousel", { end_dt: "2026-10-10" }),
        D("d2", "A", "Festival Creative Marathi", "Long Video", { end_dt: "2026-10-10" })
    ], "Bandhan Balanced Advantage Campaign - Festival Creative AV");
    assert.equal(r.db_match.deliverable_alternatives[0].id, "d2");
});

test("a line that names no type is not pushed around by types", () => {
    const r = resolveWith([P("A", { end_date: "2026-10-30" })], [
        D("d1", "A", "Festival Creative Hindi", "Carousel", { end_dt: "2026-10-10" }),
        D("d2", "A", "Festival Creative Marathi", "Long Video", { end_dt: "2026-10-10" })
    ], "Bandhan Balanced Advantage Campaign - Festival Creative");
    assert.equal(r.project_id, "A");
    assert.equal(r.db_match.deliverable_alternatives[0].id, "d1");
});

test("projects without any date are treated as neutral", () => {
    const r = resolveWith([P("A")], [D("d1", "A", "Launch Teaser", "Teaser")], "Bandhan Balanced Advantage Campaign - Launch Teaser");
    assert.equal(r.project_id, "A");
});
