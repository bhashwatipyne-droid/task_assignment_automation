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
    ppts: "ppt"
};


function norm(text) {

    return (text || "")
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9%]+/g, " ")
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


module.exports = {
    STOP,
    norm,
    stem,
    words,
    aliasPhrasesFor,
    stripPhrases,
    toTokens,
    fuzzyEq
};
