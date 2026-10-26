"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { REPLACED, STABLE_MS, reconnectDelay, nextReplacedStreak } = require("../reconnectPolicy");

const MIN = 60 * 1000;

test("an ordinary close backs off 3s, 6s ... up to 60s", () => {
    assert.strictEqual(reconnectDelay(515, 0, 0), 3000);
    assert.strictEqual(reconnectDelay(515, 1, 0), 6000);
    assert.strictEqual(reconnectDelay(undefined, 10, 0), 60000);
});

test("a copy that lost the login to another copy waits minutes, not seconds", () => {
    // the old 30s wait is what made two copies take the login back and forth
    assert.ok(reconnectDelay(REPLACED, 0, 1) >= 5 * MIN);
});

test("the wait doubles on every repeat and stops at 30 minutes", () => {
    assert.strictEqual(reconnectDelay(REPLACED, 0, 1), 5 * MIN);
    assert.strictEqual(reconnectDelay(REPLACED, 0, 2), 10 * MIN);
    assert.strictEqual(reconnectDelay(REPLACED, 0, 3), 20 * MIN);
    assert.strictEqual(reconnectDelay(REPLACED, 0, 9), 30 * MIN);
});

test("a long wait is never cut short by the 60s backoff cap", () => {
    assert.strictEqual(reconnectDelay(REPLACED, 8, 1), 5 * MIN);
});

test("the replaced streak counts repeats and resets after a stable connection", () => {
    // replaced right after connecting, again and again
    let streak = 0;
    streak = nextReplacedStreak(streak, REPLACED, 5000);
    streak = nextReplacedStreak(streak, REPLACED, 5000);
    assert.strictEqual(streak, 2);

    // a normal close does not add to it
    assert.strictEqual(nextReplacedStreak(2, 515, 5000), 2);

    // it was connected for a long time before this: a fresh case
    assert.strictEqual(nextReplacedStreak(2, REPLACED, STABLE_MS + 1), 1);
    assert.strictEqual(nextReplacedStreak(2, 515, STABLE_MS + 1), 0);
});
