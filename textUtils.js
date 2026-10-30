// ============================================================
// TEXT UTILITIES (shared by build-lexicon.js and tasklistMatcher.js)
// Normalising, stemming, stop words and typo-tolerant comparison.
// ============================================================

const { CLIENT_ALIASES } = require("./clientAliases");


const STOP = new Set(
    "and the of for to a an in on with from has have is are at by mf vs".split(" ")
);

// Known spelling / wording variants -> one canonical token
const SYN = {
    robecco: "robeco",
    scripting: "script",
    scripts: "script",
    updation: "update",
    updating: "update",
    updated: "update",
    updates: "update",
    pptx: "ppt",
    ppts: "ppt",
    sr: "senior"
};


// Fund-category compounds people write both as one word and as two
// (multicap / multi cap, flexicap / flexi cap, midcap / mid cap ...)
const COMPOUND_RE = /\b(multi|flexi|small|mid|large|micro)(cap|asset|factor)\b/g;


function norm(text) {

    return (text || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9%]+/g, " ")
        // "multicap" and "Multi Cap" are the same thing: always split the
        // fund-category compounds so both spellings tokenize identically
        .replace(COMPOUND_RE, "$1 $2")
        .trim();

}


function stem(token) {

    if (SYN[token]) {
        return SYN[token];
    }

    if (token.length > 5 && token.endsWith("ies")) {
        return token.slice(0, -3) + "y";
    }

    if (
        token.length > 4 &&
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !/^\d/.test(token)
    ) {
        return token.slice(0, -1);
    }

    return token;

}


function words(text) {
    return norm(text).split(" ").filter(Boolean);
}


// Alias phrases (as word arrays, longest first) for one client name
function aliasPhrasesFor(clientName) {

    const aliases =
        (CLIENT_ALIASES[clientName] || []).concat([clientName]);

    return aliases
        .map(words)
        .filter(w => w.length > 0)
        .sort((a, b) => b.length - a.length);

}


// Removes every occurrence of the given phrases from a word list
function stripPhrases(ws, phrases) {

    let out = ws.slice();

    for (const phrase of phrases) {

        let i = 0;

        while (i <= out.length - phrase.length) {

            const hit =
                phrase.every((w, k) => out[i + k] === w);

            if (hit) {
                out.splice(i, phrase.length);
            }

            else {
                i++;
            }

        }

    }

    return out;

}


// Tokens used for matching: stripped of client phrases, stop words
// removed, stemmed.
function toTokens(text, phrases = []) {

    return stripPhrases(words(text), phrases)
        .filter(w => !STOP.has(w))
        .map(stem)
        .filter(Boolean);

}


function lev(a, b) {

    if (a === b) return 0;

    const m = a.length;
    const n = b.length;

    if (Math.abs(m - n) > 2) return 3;

    let prev = Array.from({ length: n + 1 }, (_, j) => j);

    for (let i = 1; i <= m; i++) {

        const cur = [i];

        for (let j = 1; j <= n; j++) {

            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );

        }

        prev = cur;

    }

    return prev[n];

}


// Same word, allowing small typos (Robecco ~ Robeco) and
// word-stem differences (present ~ presentation)
function fuzzyEq(a, b) {

    if (a === b) return true;

    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;

    if (shorter.length < 4) return false;

    if (/\d/.test(a) || /\d/.test(b)) return false;

    if (shorter.length >= 5 && longer.startsWith(shorter)) return true;

    const d = lev(a, b);

    if (shorter.length >= 9) return d <= 2;
    if (shorter.length >= 5) return d <= 1;

    return false;

}


// A part that is only a date and/or a time ("30-10-2026", "30-10-2026 |",
// "30-10-2026 | 6:00 pm"): a timing stamp at the end of a line, not its task.
const STAMP_ONLY_RE = /^[\d\s\-\/.:|,]*(?:am|pm)?[\d\s\-\/.:|,]*$/i;

// The parts of a line split on its arrows, without trailing date/time stamps
// ("... > Reel > 30-10-2026" -> "... > Reel"), so the closing part is the last
// part that says something. Never drops the first part.
function dropTrailingStamps(parts) {

    const out = parts.slice();

    while (out.length > 1 && STAMP_ONLY_RE.test(String(out[out.length - 1]).trim())) {
        out.pop();
    }

    return out;

}


module.exports = {
    STOP,
    dropTrailingStamps,
    norm,
    stem,
    words,
    aliasPhrasesFor,
    stripPhrases,
    toTokens,
    fuzzyEq
};
