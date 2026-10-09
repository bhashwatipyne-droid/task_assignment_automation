// Password-protected page that shows the WhatsApp link QR as a real PNG.
//
// Why: Render's log viewer garbles the terminal (Unicode) QR so it cannot be
// scanned. This renders the QR string from Baileys as an image instead.
//
// Security model
//  - Off unless QR_PAGE_TOKEN is set (>= 24 chars). When off, /qr is a 404 and
//    the old terminal QR is used (handy for running locally).
//  - HTTP Basic auth: any username, the password is QR_PAGE_TOKEN. The secret
//    never appears in a URL, so it is not stored in logs or browser history.
//  - Only exists while a QR is waiting to be scanned: cleared as soon as
//    WhatsApp links ("open") and expires on its own if Baileys stops sending
//    new codes.
//  - Repeated wrong passwords from one address are throttled.
//  - Nothing here logs the QR string, the token or any session data.
const crypto = require("crypto");
const QRCode = require("qrcode");

const MIN_TOKEN_LENGTH = 24;
const QR_TTL_MS = 60 * 1000; // Baileys rotates the code about every 20s
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();

function createQrPage({ token = process.env.QR_PAGE_TOKEN, now = Date.now } = {}) {
    const enabled = typeof token === "string" && token.length >= MIN_TOKEN_LENGTH;
    const tokenHash = enabled ? sha256(token) : null;

    let current = null; // { qr, at }
    let linked = false;
    const failures = new Map(); // ip -> { count, since }

    const tokenMatches = (candidate) =>
        crypto.timingSafeEqual(sha256(candidate), tokenHash);

    const passwordFrom = (header) => {
        const match = /^Basic\s+(.+)$/i.exec(header || "");
        if (!match) return null;
        const decoded = Buffer.from(match[1], "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        return idx === -1 ? null : decoded.slice(idx + 1);
    };

    const throttled = (ip) => {
        const entry = failures.get(ip);
        if (!entry) return false;
        if (now() - entry.since > FAILURE_WINDOW_MS) {
            failures.delete(ip);
            return false;
        }
        return entry.count >= MAX_FAILURES;
    };

    const recordFailure = (ip) => {
        const entry = failures.get(ip);
        if (!entry || now() - entry.since > FAILURE_WINDOW_MS) {
            failures.set(ip, { count: 1, since: now() });
        } else {
            entry.count += 1;
        }
    };

    const page = (body, refresh) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
${refresh ? '<meta http-equiv="refresh" content="4">' : ""}
<title>Link WhatsApp</title>
<style>body{font:16px system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f6f7f9;color:#111}
main{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 14px rgba(0,0,0,.1);text-align:center;max-width:380px}
img{width:300px;height:300px;image-rendering:pixelated}small{color:#666}</style></head>
<body><main>${body}</main></body></html>`;

    function setQr(qr) {
        if (!enabled) return;
        linked = false;
        current = { qr, at: now() };
    }

    function markLinked() {
        current = null;
        linked = true;
    }

    // Express handler for GET /qr
    async function handler(req, res) {
        res.set({
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });

        if (!enabled) return res.status(404).send("Not found");

        const ip = req.ip || "unknown";
        if (throttled(ip)) return res.status(429).send("Too many attempts. Try again later.");

        const password = passwordFrom(req.get("authorization"));
        if (password === null || !tokenMatches(password)) {
            if (password !== null) recordFailure(ip);
            res.set("WWW-Authenticate", 'Basic realm="WhatsApp link", charset="UTF-8"');
            return res.status(401).send("Authentication required");
        }
        failures.delete(ip);

        if (linked) {
            return res.type("html").send(page("<h2>WhatsApp is linked</h2><small>Nothing to scan. You can close this page.</small>", false));
        }
        if (!current || now() - current.at > QR_TTL_MS) {
            current = null;
            return res.type("html").send(page("<h2>Waiting for a QR code…</h2><small>This page refreshes by itself.</small>", true));
        }

        const dataUrl = await QRCode.toDataURL(current.qr, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 300,
        });
        return res.type("html").send(page(
            `<h2>Scan with WhatsApp</h2><img alt="WhatsApp QR code" src="${dataUrl}">` +
            "<p><small>Settings → Linked Devices → Link a Device.<br>The code refreshes by itself.</small></p>",
            true
        ));
    }

    return { enabled, setQr, markLinked, handler };
}

module.exports = { createQrPage, MIN_TOKEN_LENGTH };
