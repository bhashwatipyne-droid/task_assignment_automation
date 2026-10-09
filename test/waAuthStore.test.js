"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeDb } = require("./fakeDb");
const { useMongoAuthState } = require("../waAuthStore");

test("login state survives a restart (new auth object, same database)", async () => {
    const db = new FakeDb();

    const first = await useMongoAuthState(db, "s1");
    assert.equal(first.hasSession, false);

    await first.saveCreds();
    await first.state.keys.set({
        "pre-key": { 1: { private: Buffer.from("abc"), public: Buffer.from("def") } }
    });

    const second = await useMongoAuthState(db, "s1");
    assert.equal(second.hasSession, true);
    assert.deepEqual(second.state.creds.noiseKey.public, first.state.creds.noiseKey.public);

    const got = await second.state.keys.get("pre-key", ["1"]);
    assert.equal(Buffer.from(got["1"].private).toString(), "abc");
});

test("a null key value deletes it, and sessions are isolated", async () => {
    const db = new FakeDb();
    const a = await useMongoAuthState(db, "a");
    const b = await useMongoAuthState(db, "b");

    await a.saveCreds();
    await b.saveCreds();
    await a.state.keys.set({ "pre-key": { 7: { k: 1 } } });
    await a.state.keys.set({ "pre-key": { 7: null } });
    assert.equal((await a.state.keys.get("pre-key", ["7"]))["7"], null);

    await a.clear();
    assert.equal((await useMongoAuthState(db, "a")).hasSession, false);
    assert.equal((await useMongoAuthState(db, "b")).hasSession, true);
});
