const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { createQrPage } = require("../qrPage");

const TOKEN = "t".repeat(32);
const basic = (pw, user = "qr") => "Basic " + Buffer.from(`${user}:${pw}`).toString("base64");

async function serve(opts) {
    const qr = createQrPage(opts);
    const app = express();
    app.get("/qr", (req, res, next) => qr.handler(req, res).catch(next));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const get = (headers = {}) => new Promise((resolve, reject) => {
        http.get({ port: server.address().port, path: "/qr", headers }, (res) => {
            let body = ""; res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on("error", reject);
    });
    return { qr, get, close: () => server.close() };
}

test("disabled without a long enough token: 404, even with a QR set", async () => {
    for (const token of [undefined, "", "short"]) {
        const s = await serve({ token });
        s.qr.setQr("2@secret-qr-string");
        assert.strictEqual(s.qr.enabled, false);
        assert.strictEqual((await s.get({ authorization: basic(token || "x") })).status, 404);
        s.close();
    }
});

test("requires the password: 401 without or with a wrong one, never reveals the QR", async () => {
    const s = await serve({ token: TOKEN });
    s.qr.setQr("2@secret-qr-string");
    const none = await s.get();
    assert.strictEqual(none.status, 401);
    assert.match(none.headers["www-authenticate"], /Basic/);
    assert.strictEqual((await s.get({ authorization: basic("wrong") })).status, 401);
    assert.strictEqual((await s.get({ authorization: "Bearer " + TOKEN })).status, 401);
    s.close();
});

test("correct password shows a PNG image, not the QR string, and is not cacheable", async () => {
    const s = await serve({ token: TOKEN });
    s.qr.setQr("2@secret-qr-string");
    const r = await s.get({ authorization: basic(TOKEN, "anyone") });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /<img [^>]*src="data:image\/png;base64,/);
    assert.ok(!r.body.includes("2@secret-qr-string"));
    assert.strictEqual(r.headers["cache-control"], "no-store");
    assert.match(r.headers["x-robots-tag"], /noindex/);
    s.close();
});

test("waiting, expiry and linked states", async () => {
    let t = 1000;
    const s = await serve({ token: TOKEN, now: () => t });
    const auth = { authorization: basic(TOKEN) };
    assert.match((await s.get(auth)).body, /Waiting for a QR/);
    s.qr.setQr("2@abc");
    assert.match((await s.get(auth)).body, /<img/);
    t += 61 * 1000; // Baileys stopped sending codes
    assert.match((await s.get(auth)).body, /Waiting for a QR/);
    s.qr.setQr("2@def");
    s.qr.markLinked();
    const done = await s.get(auth);
    assert.match(done.body, /WhatsApp is linked/);
    assert.ok(!/<img/.test(done.body));
    s.close();
});

test("brute force is throttled, and a correct password is also refused while throttled", async () => {
    const s = await serve({ token: TOKEN });
    for (let i = 0; i < 5; i++) assert.strictEqual((await s.get({ authorization: basic("bad" + i) })).status, 401);
    assert.strictEqual((await s.get({ authorization: basic("bad-again") })).status, 429);
    assert.strictEqual((await s.get({ authorization: basic(TOKEN) })).status, 429);
    s.close();
});

test("nothing is written to the console", async () => {
    const seen = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a) => seen.push(a.join(" "));
    try {
        const s = await serve({ token: TOKEN });
        s.qr.setQr("2@secret-qr-string");
        await s.get({ authorization: basic(TOKEN) });
        await s.get({ authorization: basic("nope") });
        s.close();
    } finally {
        [console.log, console.error, console.warn] = orig;
    }
    assert.deepStrictEqual(seen, []);
});
