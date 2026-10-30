// ============================================================
// TASKLIST MATCHER
// ============================================================
//
// Decides, for one task line, which words are the CLIENT, which are
// the PROJECT and which are the DELIVERABLE, by scoring the words
// against everything already in the PMT database (lexicon.json).
//
//   "ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority"
//
//   client       ICICI Prudential Mutual Fund   <- alias "ICICI Prudential"
//   project      IPru Pharma ETF Campaign       <- "Pharma" scores highest
//   deliverable  From Lab to Life               <- matches DB deliverable
//   action       Review & Changes (note)
//   priority     High
//
// How scoring works
//   - every word has a weight: rare words (lab, diwali, swp) are strong
//     evidence, common words (campaign, creative, video) are weak
//   - an entity (project / deliverable name) scores by how much of its
//     weight appears in the text (recall) and how much of the text it
//     explains (precision), tolerant of typos (Robecco ~ Robeco)
//   - a line with no client name can still be placed: a deliverable
//     like "Look How Far Pharma Has Come" only exists under ICICI
//   - if two clients tie, no guess is made: needs_review = true
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");

const { CLIENT_ALIASES, CLIENT_FAMILIES } = require("./clientAliases");
const learned = require("./learned");

const {
    aliasPhrasesFor,
    toTokens,
    words,
    stem,
    fuzzyEq,
    dropTrailingStamps
} = require("./textUtils");


// ------------------------------------------------------------
// TUNING
// ------------------------------------------------------------

const MIN_MASS = 5.0;          // minimum evidence weight to trust a match
const PROJECT_MIN_SCORE = 0.30;
const DELIVERABLE_MIN_SCORE = 0.60;
const CLIENT_TIE_MARGIN = 0.05;
const RESIDUAL_MIN_IDF = 4.0;  // words this common are never stripped from the deliverable

// Words that name a kind of deliverable. Common in the database (so low
// weight) but still meaningful as the deliverable of a line.
const TYPE_WORDS = new Set([
    "creative", "video", "reel", "carousel", "ppt", "poster", "brochure",
    "banner", "script", "storyboard", "teaser", "explainer", "dashboard",
    "booklet", "standee", "backdrop", "design", "calculator", "wrapper",
    "deck", "post", "infographic", "emailer", "certificate", "trophy",
    "onepager", "twopager", "factsheet", "animation", "gif", "static",
    "presentation", "newsletter", "mailer", "invite", "flyer", "leaflet"
]);


const TYPE_STEMS = new Set([...TYPE_WORDS].map(stem));

// The kind of work a line asks for. Used only to settle a near-tie between two
// projects of the same client: "storyboard / shoot AV" belongs to the video
// project, not to the "story & design for ppt" one.
const KIND_GROUPS = {
    deck: ["ppt", "pptx", "deck", "presentation", "slide"],
    video: ["video", "av", "storyboard", "shoot", "tvc", "animation", "explainer"],
    social: ["reel", "carousel", "post", "ig", "instagram", "static"]
};

const KIND_OF = new Map();

for (const [kind, ws] of Object.entries(KIND_GROUPS)) {
    ws.forEach(w => KIND_OF.set(stem(w), kind));
}

const KIND_TIE_MARGIN = 0.15;
const KIND_CONTRADICTION_MARGIN = 0.25;
const KIND_MIN_SCORE = 0.3;

// ---- deliverable TYPE (the PMT "type" of a deliverable) -------------------
// "AV" is a video, "ppt" is a presentation. Whether the project / deliverable
// being considered actually HAS that type is used only to settle close calls.
const TYPE_RULES = [
    // AV (animated video) is ALWAYS "Reel / Short Video" in PMT.
    ["Reel / Short Video", /\b(av|avs|a\.v|reel|reels|short|shorts|animated|animation)\b/],
    ["Long Video", /\b(video|videos|film|films|tvc|explainer|shoot)\b/],
    ["Teaser Short Video", /\b(teaser|teasers)\b/],
    ["Video Storyboard", /\b(storyboard|storyboards|script)\b/],
    ["Teaser", /\bteasers?\b/],
    ["Carousel", /\bcarousels?\b/],
    ["Presentation (PPT) - Per Slide", /\b(ppts?|pptx|decks?|presentations?|slides?)\b/],
    ["One Pager / Infographic", /\b(one ?pagers?|onepagers?|infographics?)\b/],
    ["Two Pager", /\b(two ?pagers?|2 ?pagers?|leaflets?)\b/],
    ["Emailers", /\b(emailers?|mailers?)\b/],
    ["Brochure", /\bbrochures?\b/],
    ["Booklet", /\bbooklets?\b/],
    ["Newsletters", /\bnewsletters?\b/],
    ["GIF", /\bgifs?\b/],
    ["Poster", /\bposters?\b/],
    ["Minimalist", /\bminimali(st|stic)\b/],
    ["Data Updation", /\b(updation|data update|data updation)\b/]
];

const TYPE_TIE_MARGIN = 0.12;

// ---- the TYPE written as the last part of a line --------------------------
// "TFP Premium > Diwali Campaign > <article title> > Carousel": when no
// deliverable of that name exists in PMT yet, the closing word still says what
// kind of work it is. Only an exact phrase counts, so a title that merely
// contains the word "reel" is never read as a type.
//
// "Data Research & Analysis" exists in PMT twice, "(Web)" and "(SMI)", and the
// line does not say which. It is SMI almost every time (Web is only ever written
// out as "Web Based Data"), so SMI is the default. Set this to null to leave the
// type empty and list both in type_candidates instead.
const DEFAULT_DATA_RESEARCH_TYPE = "Data Research and Analysis (SMI)";

const DATA_RESEARCH_TYPES = [
    "Data Research and Analysis (Web)",
    "Data Research and Analysis (SMI)"
];

const SEGMENT_TYPES = [
    [/^carousels?$/, "Carousel"],
    [/^(reels?|short videos?|shorts?|avs?|animated videos?)$/, "Reel / Short Video"],
    [/^(infographics?|one ?pagers?|one ?pager ?(\/|and)? ?infographics?|infographics? ?(\/|and)? ?one ?pagers?)$/, "One Pager / Infographic"],
    [/^(two ?pagers?|2 ?pagers?)$/, "Two Pager"],
    [/^minimali(st|stic)s?$/, "Minimalist"],
    [/^gifs?$/, "GIF"],
    [/^teasers?$/, "Teaser"],
    [/^posters?$/, "Poster"],
    [/^brochures?$/, "Brochure"],
    [/^booklets?$/, "Booklet"],
    [/^newsletters?$/, "Newsletters"],
    [/^(emailers?|mailers?)$/, "Emailers"],
    [/^long videos?$/, "Long Video"],
    [/^(ppts?|pptx|presentations?|decks?)$/, "Presentation (PPT) - Per Slide"],
    [/^(web ?based (data|research)|web (data|research)|data research and analysis \(?web\)?)$/, "Data Research and Analysis (Web)"],
    [/^(smi data|smi research|data research and analysis \(?smi\)?)$/, "Data Research and Analysis (SMI)"],
    // "Campaign ideation" is a deliverable type; the plain form is the one with keywords
    [/^campaign ideation( plan)?$/, "Campaign Ideation Plan (Includes Keywords)"]
];

const AMBIGUOUS_SEGMENT_TYPES = /^(data research and analysis|data analysis and research|data research|research and analysis)$/;

// { type, candidates } for a closing part such as "Carousel", "Web Based Data"
// or "Data Research & Analysis"; null when it is not a type
function typeOfPart(part) {

    const plain = String(part || "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/^\d+\s+/, "")
        .replace(/\s+/g, " ")
        .replace(/[.:]+$/, "")
        .trim();

    if (!plain) return null;

    for (const [re, type] of SEGMENT_TYPES) {
        if (re.test(plain)) return { type, candidates: [] };
    }

    if (AMBIGUOUS_SEGMENT_TYPES.test(plain)) {

        return DEFAULT_DATA_RESEARCH_TYPE
            ? { type: DEFAULT_DATA_RESEARCH_TYPE, candidates: [] }
            : { type: null, candidates: DATA_RESEARCH_TYPES.slice() };

    }

    return null;

}

// ">" (also the typographic arrows) separates the parts of a line the way a dash does
const ARROW_SPLIT_RE = /\s*(?:-+>|[>›»→])+\s*/;

// the PMT deliverable types a line asks for (empty = it says nothing about it)
function typesAskedFor(rawLine) {

    const text = String(rawLine || "").toLowerCase().replace(/_/g, " ");

    const found = new Set();

    for (const [type, re] of TYPE_RULES) {
        if (re.test(text)) found.add(type);
    }

    // AV / animated video is a short video, never a long one
    if (/\b(av|avs|a\.v|animated|animation)\b/.test(text)) {
        found.delete("Long Video");
        found.delete("Teaser Short Video");
    }

    return found;

}

const LANGUAGE_TOKENS = new Set([
    "hindi", "marathi", "gujarati", "kannada", "tamil", "telugu", "bengali",
    "malayalam", "punjabi", "odia", "urdu", "assamese"
]);


// ------------------------------------------------------------
// LOAD LEXICON
// ------------------------------------------------------------

let LEX = null;
let state = null;


function loadLexicon(file) {

    const lexFile =
        file ||
        process.env.LEXICON_FILE ||
        path.join(__dirname, "lexicon.json");

    if (!fs.existsSync(lexFile)) {
        return false;
    }

    return useLexicon(JSON.parse(fs.readFileSync(lexFile, "utf8")));

}


// Make a lexicon (an object, as lexicon.json holds it) the live one. Used at
// start-up from lexicon.json and again whenever it is rebuilt from the live
// PMT data, so the matcher never works from a stale snapshot for long.
// What the manager's earlier decisions taught (see learned.js)
let LEARNED = { exact: new Map(), leadClient: new Map(), closerType: new Map() };

function useLearned(lookups) {
    LEARNED = lookups && lookups.exact && lookups.leadClient
        ? { closerType: new Map(), ...lookups }
        : { exact: new Map(), leadClient: new Map(), closerType: new Map() };
}

// A line whose closing word people have turned into the same type on several
// different lines ("... > Review" -> Team Reviews and Feedback). Only fills a
// type nothing else found: the matched deliverable's own type, the closing
// word ("... > Carousel") and an exact learned line all come first.
function applyLearnedCloser(result, rawLine) {
    if (!result || result.deliverable_type) return result;
    const type = LEARNED.closerType.get(learned.closerKey(rawLine));
    if (!type) return result;

    result.deliverable_type = type;
    result.type_source = "learned";
    result.learned_type = true;
    result.type_candidates = [];
    return result;
}

// A line the manager already resolved, worded the same: use their answer.
function applyLearnedExact(result, rawLine) {
    const rule = LEARNED.exact.get(learned.lineKey(rawLine));
    if (!rule) return result;

    const project = LEX.projects.find(p => p.id === rule.project_id && !p.alt);
    if (!project) return result; // the project no longer exists: ignore the rule
    const client = (LEX.clients || []).find(c => c.id === project.client_id);

    result.project_id = project.id;
    result.project_name = project.name;
    result.client_id = project.client_id;
    result.client_name = client ? client.name : result.client_name;

    const del = rule.deliverable_id && (LEX.deliverables || []).find(
        d => d.id === rule.deliverable_id && d.project_id === project.id
    );
    if (del) {
        result.deliverable_name = del.name;
        result.db_match.deliverable_found = true;
        result.db_match.deliverable_in_db = del.name;
        result.db_match.deliverable_id = del.id;
    }

    // a type the manager chose for this line beats the matcher's reading of it
    if (rule.deliverable_type) {
        result.deliverable_type = rule.deliverable_type;
        result.type_source = "learned";
        result.learned_type = true;
    }

    result.db_match.project_found = true;
    result.confidence = {
        client: 0.95,
        project: 0.95,
        deliverable: del ? 0.95 : result.confidence.deliverable
    };
    result.client_source = "learned from an earlier decision";
    result.match_method = "learned";
    result.needs_review = false;
    result.review_reasons = [];
    return result;
}

function resolveLine(rawLine) {
    const result = resolveBase(rawLine);
    return result ? applyLearnedCloser(applyLearnedExact(result, rawLine), rawLine) : result;
}

function useLexicon(lex) {

    LEX = lex;

    const clientById = new Map(LEX.clients.map(c => [c.id, c]));

    const clientByName = new Map(LEX.clients.map(c => [c.name, c]));

    const phrasesByClient = new Map(
        LEX.clients.map(c => [c.id, aliasPhrasesFor(c.name)])
    );

    // inverted indexes: token -> entity positions
    const projIndex = new Map();
    const delIndex = new Map();

    LEX.projects.forEach((e, i) => {
        for (const t of new Set(e.toks)) {
            if (!projIndex.has(t)) projIndex.set(t, []);
            projIndex.get(t).push(i);
        }
    });

    LEX.deliverables.forEach((e, i) => {
        for (const t of new Set(e.toks)) {
            if (!delIndex.has(t)) delIndex.set(t, []);
            delIndex.get(t).push(i);
        }
    });

    const maxUpd = Math.max(
        ...LEX.projects.map(p => p.upd || 0),
        1
    );

    const minUpd = Math.min(
        ...LEX.projects.filter(p => p.upd).map(p => p.upd),
        maxUpd - 1
    );

    // alias list, longest first, so "icici prudential" beats "icici"
    const aliasList = [];

    for (const [clientName, aliases] of Object.entries(CLIENT_ALIASES)) {

        const client = clientByName.get(clientName);

        if (!client) continue;

        for (const alias of aliases) {
            aliasList.push({ client, words: words(alias) });
        }

    }

    aliasList.sort((a, b) => b.words.length - a.words.length);

    // how many deliverables share each exact wording (a bare deliverable name
    // can only be trusted when it is the only one of its kind)
    const delSigCount = new Map();

    for (const d of LEX.deliverables) {
        const sig = d.toks.join(" ");
        delSigCount.set(sig, (delSigCount.get(sig) || 0) + 1);
    }

    // which deliverable types each project already has
    const typesByProject = new Map();

    for (const d of LEX.deliverables) {

        if (!d.type) continue;

        if (!typesByProject.has(d.project_id)) typesByProject.set(d.project_id, new Set());

        typesByProject.get(d.project_id).add(d.type);

    }

    state = {
        typesByProject,
        delSigCount,
        clientById,
        phrasesByClient,
        projIndex,
        delIndex,
        vocab: Object.keys(LEX.idf),
        maxIdf: Math.max(...Object.values(LEX.idf)),
        maxUpd,
        minUpd,
        aliasList,
        eqCache: new Map(),
        families: CLIENT_FAMILIES
    };

    return true;

}


function isReady() {
    return state !== null;
}


// Deliverable names that contain a comma ("Your US Exposure, From GIFT City").
// The parser must not read that comma as "two deliverables".
let commaPhraseCache = null;

function commaPhrases() {

    if (!LEX) return [];

    if (commaPhraseCache && commaPhraseCache.lex === LEX) {
        return commaPhraseCache.list;
    }

    const list = [...new Set(
        LEX.deliverables
            .map(d => d.name || "")
            .filter(n => /[,،]/.test(n))
            .map(n => words(n))
            .filter(w => w.length >= 2)
            .map(w => w.join(" "))
    )];

    commaPhraseCache = { lex: LEX, list };

    return list;

}


// When the lexicon was built and what is in it (logged with every match so a
// stale lexicon can be told apart from a bad match).
function lexiconInfo() {

    if (!LEX) return { built_at: null, stats: null };

    return { built_at: LEX.built_at || null, stats: LEX.stats || null };

}


// The numbers behind one ranked candidate, rounded for storage.
function scoreOf(row) {

    if (!row) return null;

    const r = (n) => (typeof n === "number" ? Number(n.toFixed(3)) : null);

    return {
        raw: r(row.raw),
        mass: r(row.mass),
        recall: r(row.recall),
        precision: r(row.precision)
    };

}


// ------------------------------------------------------------
// SCORING
// ------------------------------------------------------------

function idfOf(token) {
    return LEX.idf[token] !== undefined
        ? LEX.idf[token]
        : state.maxIdf;
}


// every vocabulary word that "means the same" as q (typos, stems)
function equivalents(q) {

    if (state.eqCache.has(q)) {
        return state.eqCache.get(q);
    }

    const set = new Set();

    for (const v of state.vocab) {
        if (fuzzyEq(q, v)) set.add(v);
    }

    state.eqCache.set(q, set);

    return set;

}


// Recent projects first. A project is as recent as the last date PMT has for it
// or its deliverables (e.act); half a year ago counts for about half as much as
// today, and a project nothing has happened in for 18 months is pushed down so a
// 2019 project cannot win a close call against this year's. Projects without any
// date are left neutral.
const RECENCY_MAX = 0.10;
const RECENCY_HALF_LIFE_DAYS = 180;
const RECENCY_STALE_DAYS = 548;
const RECENCY_STALE_PENALTY = 0.08;

function recencyPrior(e) {

    if (!e || !e.act) return 0;

    const ageDays = Math.max(0, (Date.now() - e.act) / 86400000);

    const fresh = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) * RECENCY_MAX;

    return ageDays > RECENCY_STALE_DAYS ? fresh - RECENCY_STALE_PENALTY : fresh;

}


// Score one query against a set of entities
//   kind "project"     -> favours recall (the text usually mentions
//                         only part of a long project name)
//   kind "deliverable" -> balances recall and precision
function rank(qToks, kind, allowedClients) {

    const index = kind === "project" ? state.projIndex : state.delIndex;
    const entities = kind === "project" ? LEX.projects : LEX.deliverables;

    const q = Array.from(new Set(qToks));

    if (q.length === 0) return [];

    const eq = q.map(equivalents);

    const union = new Set();
    eq.forEach(s => s.forEach(v => union.add(v)));

    const candidates = new Set();

    for (const v of union) {
        for (const i of (index.get(v) || [])) candidates.add(i);
    }

    const qWeight = q.reduce((sum, t) => sum + idfOf(t), 0);

    const out = [];

    for (const i of candidates) {

        const e = entities[i];

        if (allowedClients && !allowedClients.has(e.client_id)) continue;

        const entSet = new Set(e.toks);

        let eTotal = 0;
        let eHit = 0;

        for (const t of e.toks) {

            const w = idfOf(t);

            eTotal += w;

            if (union.has(t)) eHit += w;

        }

        let qHit = 0;

        q.forEach((t, k) => {

            for (const v of eq[k]) {
                if (entSet.has(v)) {
                    qHit += idfOf(t);
                    break;
                }
            }

        });

        const recall = eTotal ? eHit / eTotal : 0;
        const precision = qWeight ? qHit / qWeight : 0;

        const score =
            kind === "project"
                ? 0.70 * recall + 0.30 * precision
                : 0.50 * recall + 0.50 * precision;

        // The line is exactly this project's name ("Bajaj mappings" for the
        // project "Bajaj Mappings"). A one-word name can never reach MIN_MASS,
        // so without this it ranks below a longer project that merely repeats
        // the word ("... Mapping ... and mapping_A4") and gets held as weak.
        const exact =
            kind === "project" &&
            recall >= 0.999 &&
            precision >= 0.999;

        out.push({
            entity: e,
            score: score + (kind === "project" ? recencyPrior(e) : 0),
            raw: score,
            mass: eHit,
            recall,
            precision,
            exact
        });

    }

    // a candidate with too little evidence behind it ("ICICI ETF" for a text that only
    // says "ETF") must not outrank one that is actually supported
    const supported = r => (r.mass >= MIN_MASS || r.exact ? 1 : 0);

    out.sort((a, b) => supported(b) - supported(a) || b.score - a.score);

    // one row per project / deliverable id
    const seen = new Set();
    const unique = [];

    for (const r of out) {

        const key = r.entity.id;

        if (seen.has(key)) continue;

        seen.add(key);
        unique.push(r);

    }

    return unique;

}


// share of the text's evidence weight explained by the given entities
function coverage(qToks, tokLists) {

    const have = new Set();

    tokLists.forEach(list => list.forEach(t => have.add(t)));

    let total = 0;
    let hit = 0;

    for (const t of new Set(qToks)) {

        const w = idfOf(t);

        total += w;

        for (const v of equivalents(t)) {
            if (have.has(v)) {
                hit += w;
                break;
            }
        }

    }

    return total ? hit / total : 0;

}


const strongProject = (r) =>
    r && r.raw >= PROJECT_MIN_SCORE && (r.mass >= MIN_MASS || r.exact === true);

const strongDeliverable = (r) =>
    r && r.raw >= DELIVERABLE_MIN_SCORE && r.mass >= MIN_MASS;


// "TFP > Brighter Diwali Reel": TFP is a family of monthly projects (TFP Oct-26,
// TFP May-26 ...) and the rest of the line is the deliverable, so the deliverable
// decides which month. This applies when the line starts with the family's word
// and the candidate deliverables belong to projects starting with that same word.
// A weaker score than the near-exact bar is enough, but the pick must be clear:
//  - the candidates that score close to the best are compared by evidence
//    (mass: how many distinctive words they explain). A generic one-word
//    deliverable ("Diwali") can score as high as the right one while explaining
//    far less of the line, so it loses to a clearly better explained one;
//  - candidates that all sit in one project are fine (the project is clear);
//  - candidates in different projects with comparable evidence are NOT guessed:
//    the task is held for a person to confirm.
const FAMILY_MIN_DELIVERABLE = 0.6;
const FAMILY_TIE_MARGIN = 0.05;
const FAMILY_MASS_RATIO = 1.5;
// with no other candidate to compare against, a lone weak match is not enough
const FAMILY_SOLO_MIN = 0.7;

function familyPick(ev, rawLine) {

    const best = ev && ev.dels && ev.dels[0];

    if (!best || best.raw < FAMILY_MIN_DELIVERABLE) return null;

    const lead = words(rawLine)[0];

    if (!lead) return null;

    const ownerOf = r => LEX.projects.find(p => p.id === r.entity.project_id && !p.alt);

    const pool = ev.dels
        .filter(r => r.raw >= FAMILY_MIN_DELIVERABLE && r.raw >= best.raw - FAMILY_TIE_MARGIN)
        .filter(r => { const o = ownerOf(r); return o && words(o.name)[0] === lead; })
        .sort((a, b) => (b.mass || 0) - (a.mass || 0));

    if (!pool.length) return null;

    const top = pool[0];

    const rival = pool.find(r => r.entity.project_id !== top.entity.project_id);

    if (rival && (top.mass || 0) < FAMILY_MASS_RATIO * (rival.mass || 0)) return null;

    if (!rival && top.raw < FAMILY_SOLO_MIN) return null;

    return top;

}


// ------------------------------------------------------------
// LINE CLEANING
// ------------------------------------------------------------

const BULLET_RE = /^\s*(?:[-•·▪●–—]|\*(?=\s)|\d+[.)])\s+/;

// Priority words ("High Priority", "urgent priority") do not exist in the
// worksheet, so they are removed from the line wherever they appear and never stored.
const PRIORITY_RE =
    /[\s\-–—(\[]*\b(high|medium|low|urgent)\s*priority\b[\s)\]]*/gi;

// Deliverable types that contain an action word ("Campaign ideation"): the whole
// phrase is the deliverable, so the action-word step must not cut it up.
const TYPE_PHRASES = [
    "campaign ideation", "campaign peer analysis", "campaign quantitative analysis",
    "fund guide updation", "factsheet updation", "data updation"
];
const TYPE_RE = new RegExp("\\b(" + TYPE_PHRASES.map(t => t.replace(/ /g, "\\s+")).join("|") + ")\\b", "gi");

const SLOT_RE = /[\s\-–—]*\b(first|second)\s+half\b/i;

const ACTION_RE =
    /\b(new\s+script|ideation|reviews?|changes?|scripting|updation|revamp|edits?|rework)\b/gi;


function stripWrapping(text) {
    return (text || "")
        .trim()
        .replace(/^[*_~`]+|[*_~`]+$/g, "")
        .trim();
}


function tidy(text) {

    return text
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s\-–—+&,:]+|[\s\-–—+&,:]+$/g, "")
        .trim();

}


// ------------------------------------------------------------
// CLIENT FROM THE START OF THE LINE
// ------------------------------------------------------------

function clientFromPrefix(text) {

    const ws = text.split(/\s+/).filter(Boolean);

    const lower = ws.map(w => words(w).join(" "));

    for (const { client, words: aw } of state.aliasList) {

        let k = 0;
        let i = 0;

        // walk original words, skipping words that normalise to nothing
        while (i < ws.length && k < aw.length) {

            const piece = lower[i];

            if (piece === "") { i++; continue; }

            // a word like "Pharma-" may carry attached punctuation
            if (piece === aw[k]) { k++; i++; continue; }

            break;

        }

        if (k === aw.length) {

            return {
                client,
                rest: tidy(ws.slice(i).join(" "))
            };

        }

    }

    return null;

}


// The kinds of work a text talks about ("deck", "video", "social").
function kindsIn(tokens) {

    const found = new Set();

    tokens.forEach(t => {
        const k = KIND_OF.get(t);
        if (k) found.add(k);
    });

    return found;

}


// Among the projects that are close to the best one, return the single project
// whose NAME is about a kind of work the line asks for, when no other close
// project is. Returns null (keep the best score) when it is not clear-cut.
function pickByWorkKind(projectRows, rawLine) {

    const top = projectRows[0];

    if (!top || top.raw < KIND_MIN_SCORE) return null;

    const lineKinds = kindsIn(toTokens(rawLine));

    if (lineKinds.size === 0) return null;

    const fitsLine = (r) =>
        Array.from(kindsIn(r.entity.toks)).some(k => lineKinds.has(k));

    // the best project is about a different kind of work than the line asks
    // for ("story & design for ppt" for a "storyboard / shoot AV" line)
    const topKinds = kindsIn(top.entity.toks);
    const topContradicts = topKinds.size > 0 && !fitsLine(top);

    const margin = topContradicts ? KIND_CONTRADICTION_MARGIN : KIND_TIE_MARGIN;

    const fits = projectRows
        .slice(0, 4)
        .filter(r =>
            top.raw - r.raw < margin &&
            r.raw >= KIND_MIN_SCORE &&
            fitsLine(r)
        );

    if (fits.length === 0) return null;

    // projects that do not fit are no rivals: the choice is among the fits
    // only, and two fits that score alike are still a real tie for a person
    if (fits.length > 1 && fits[0].raw - fits[1].raw < 0.05) return null;

    // the best project fits and so does a rival: nothing separates them
    if (fits.includes(top) && fits.length > 1) return null;

    return fits[0];

}


// Close call between projects: the line asks for a type of deliverable ("AV" is a
// video) and only one of the close projects actually has that type. Rows come
// sorted best first (recency already counted in the score), so the first fit wins.
function pickByDeliverableType(projectRows, rawLine) {

    const top = projectRows[0];

    if (!top || top.raw < KIND_MIN_SCORE) return null;

    const asked = typesAskedFor(rawLine);

    if (asked.size === 0 || state.typesByProject.size === 0) return null;

    const has = (r) => {
        const types = state.typesByProject.get(r.entity.id);
        return !!types && Array.from(asked).some(t => types.has(t));
    };

    const close = projectRows
        .slice(0, 5)
        .filter(r => top.raw - r.raw < TYPE_TIE_MARGIN && r.raw >= KIND_MIN_SCORE);

    const fits = close.filter(has);

    if (fits.length === 0 || fits[0] === top) return null;

    // the best project has no such deliverable but a close rival does
    return fits[0];

}


// Close call between deliverables of the chosen project: the one whose type is
// what the line asks for goes first.
function preferDeliverableType(cands, rawLine) {

    const asked = typesAskedFor(rawLine);

    if (asked.size === 0 || cands.length < 2) return cands;

    const top = cands[0];

    const ok = (r) => !!r.entity.type && asked.has(r.entity.type);

    if (ok(top)) return cands;

    const fit = cands.find(r => ok(r) && top.raw - r.raw < TYPE_TIE_MARGIN && r.raw >= KIND_MIN_SCORE);

    if (!fit) return cands;

    return [fit, ...cands.filter(r => r !== fit)];

}


// ------------------------------------------------------------
// MAIN: RESOLVE ONE LINE
// ------------------------------------------------------------

function resolveBase(rawLine) {

    if (!isReady()) {
        return null;
    }

    // "ABSL_Emerging market" / "Destination _IG": an underscore is a space
    let text = stripWrapping(rawLine.replace(BULLET_RE, "")).replace(/_/g, " ");

    const result = {
        client_name: null,
        client_id: null,
        project_name: null,
        project_id: null,
        project_text: null,
        deliverable_name: null,
        // PMT deliverable type: from the matched deliverable ("database") or from
        // the closing word of the line ("line"); null when neither says
        deliverable_type: null,
        type_source: null,
        type_candidates: [],
        action: null,
        notes: null,
        slot: null,
        priority: null,
        confidence: { client: 0, project: 0, deliverable: 0 },
        // raw scoring detail behind `confidence` (observability only)
        scores: { project: null, deliverable: null },
        db_match: {
            project_found: false,
            deliverable_found: false,
            deliverable_in_db: null,
            suggested_project: null,
            alternatives: []
        },
        client_source: null,
        needs_review: true,
        review_reasons: []
    };


    // ---- priority ------------------------------------------
    text = text.replace(PRIORITY_RE, " - ");

    // ---- notes in brackets ---------------------------------
    const notes = [];

    text = text.replace(/\(([^)]*)\)?/g, (all, inner) => {
        if (inner && inner.trim()) notes.push(inner.trim());
        return " ";
    });

    // un-bracketed "if any"
    text = text.replace(/\bif\s+any\b/gi, () => {
        notes.push("if any");
        return " ";
    });

    // un-bracketed conditions: "once scripts are approved", "after approval"
    text = text.replace(
        /\b(?:once|after|when)\s+[^-–—,;]*?\b(?:approved|approval|confirmed|finali[sz]ed|ready|received)\b/gi,
        (m) => {
            notes.push(m.trim());
            return " ";
        }
    );

    if (notes.length) result.notes = notes.join("; ");

    // ---- first half / second half --------------------------
    const sm = text.match(SLOT_RE);

    if (sm) {
        result.slot = sm[1].charAt(0).toUpperCase() + sm[1].slice(1).toLowerCase() + " half";
        text = text.replace(SLOT_RE, " ");
    }

    // ---- action words (changes, review, ideation ...) -------
    const actions = [];

    const stripActions = (chunk) => {

        const keep = [];

        chunk = chunk.replace(TYPE_RE, (m) => {
            keep.push(m);
            return "\uE000" + (keep.length - 1) + "\uE001";
        });

        chunk = chunk.replace(ACTION_RE, (m) => {
            actions.push(m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
            return " ";
        });

        return chunk.replace(/\uE000(\d+)\uE001/g, (_, i) => keep[Number(i)]);

    };

    // "TFP Premium > Diwali Campaign > <title> > Carousel": the action ("Review",
    // "Review & Changes") is the closing part. A long middle part is an article
    // title and keeps every word ("5 Numbers to Review Before the New Year");
    // short middle parts ("Pharma Review") are read as before.
    const arrowParts = text.split(ARROW_SPLIT_RE);

    const arrowed = arrowParts.length > 1;

    if (arrowed) {

        const last = arrowParts.length - 1;

        text = arrowParts
            .map((part, i) =>
                i === last || part.trim().split(/\s+/).length <= 3
                    ? tidy(stripActions(part))
                    : part.trim()
            )
            .filter(Boolean)
            .join(" > ");

    }

    else {

        text = stripActions(text);

    }

    if (actions.length) result.action = actions.join(" + ");

    text = tidy(text);

    // the closing part names the kind of work ("... > Carousel"); a matching
    // deliverable in PMT, when there is one, decides the type instead (below)
    const closingPart = arrowed
        ? dropTrailingStamps(text.split(ARROW_SPLIT_RE)).pop()
        : text.split(/\s+[-\u2013\u2014]\s+|\s*[\u2013\u2014]\s*/).filter(Boolean).slice(1).pop();

    // "<title>_Reel": an underscore before the closing word also marks the type
    // (read from the raw line: underscores are already spaces in `text`)
    const underscored = String(rawLine || "")
        .replace(/\([^)]*\)?/g, " ")
        .trim()
        .match(/_\s*([A-Za-z][A-Za-z ]*)$/);

    const lineType = typeOfPart(closingPart) || (underscored ? typeOfPart(underscored[1]) : null);


    // ---- client from the start of the line -----------------
    let clientSet = null;
    let phrases = [];
    let rest = text;

    const cm = clientFromPrefix(text);

    if (cm) {

        result.client_name = cm.client.name;
        result.client_id = cm.client.id;
        result.confidence.client = 0.95;
        result.client_source = "name in text";

        rest = cm.rest;

        phrases = state.phrasesByClient.get(cm.client.id) || [];

        clientSet = new Set([cm.client.id]);

        const family = state.families.find(f => f.includes(cm.client.id));

        // remembered separately: siblings are only used if the main
        // client has no good project
        result._family = family ? new Set(family) : null;

    }


    // ---- split what is left into segments -------------------
    let segments =
        rest
            .split(/\s+[-–—]\s+|\s*[–—]\s*/)
            .map(tidy)
            .filter(Boolean);

    result.task_text = tidy([rest, result.action].filter(Boolean).join(" "));


    // nothing left after the client name
    if (segments.length === 0) {
        return finish(result, "Only a client name was given");
    }


    // A project name can itself contain " - " ("Invesco Fund Performance
    // Storytelling - Large & Mid cap"). Cutting there leaves the shorter
    // sibling project matching perfectly and the rest read as a deliverable.
    // When the first segments written out together are (almost entirely) the
    // full name of one project, keep them together.
    for (let k = Math.min(segments.length, 4); k >= 2; k--) {

        const joined = segments.slice(0, k).join(" - ");

        const whole = rank(toTokens(joined, phrases), "project", clientSet)[0];
        const first = rank(toTokens(segments[0], phrases), "project", clientSet)[0];

        if (
            strongProject(whole) &&
            whole.recall >= 0.999 &&
            whole.precision >= 0.85 &&
            (!first || whole.entity.id !== first.entity.id) &&
            (!first || whole.entity.toks.length > first.entity.toks.length)
        ) {

            segments = [joined].concat(segments.slice(k));
            break;

        }

    }


    // ---- evaluate every segment -----------------------------
    const evals = segments.map(seg => {

        const q = toTokens(seg, phrases);

        // a language name ("kannada", "hindi") means a translation job:
        // let "translation" count as a word of the line when ranking projects
        const forProjects = q.some(t => LANGUAGE_TOKENS.has(t)) && !q.includes("translation")
            ? q.concat("translation")
            : q;

        let projects = rank(forProjects, "project", clientSet);
        let dels = rank(q, "deliverable", clientSet);

        // client given but nothing good under it: try sibling brands
        if (
            result._family &&
            !strongProject(projects[0]) &&
            !strongDeliverable(dels[0])
        ) {

            const sp = rank(q, "project", result._family);
            const sd = rank(q, "deliverable", result._family);

            if (strongProject(sp[0]) || strongDeliverable(sd[0])) {
                projects = sp;
                dels = sd;
            }

        }

        return { seg, q, projects, dels };

    });


    // ---- no client in the text: infer from the evidence -----
    if (!result.client_id) {

        const votes = new Map();

        // clients with a PROJECT that explains every word of its segment
        // through a distinctive word (e.g. "BBNPP" -> "BBNPP ESG Fund ...")
        const projectProof = new Set();

        for (const ev of evals) {

            const pool = [];

            ev.dels.slice(0, 12).forEach(r => {
                if (strongDeliverable(r)) pool.push(r);
            });

            ev.projects.slice(0, 12).forEach(r => {

                if (strongProject(r)) pool.push(r);

                if (
                    strongProject(r) &&
                    r.entity.client_id &&
                    r.precision >= 0.999 &&
                    r.mass >= MIN_MASS
                ) {
                    projectProof.add(r.entity.client_id);
                }

            });

            for (const r of pool) {

                const cid = r.entity.client_id;

                if (!cid) continue;

                votes.set(cid, Math.max(votes.get(cid) || 0, r.raw));

            }

        }

        let clientLearned = false;
        let ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);

        // a tie, but the line opens with a word that only ONE client's project
        // names carry ("BBNPP" -> Baroda BNP Paribas): that word decides; the
        // generic words after it ("Balanced Hybrid Fund") only produce ties
        if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < CLIENT_TIE_MARGIN) {
            const lead = words(rawLine)[0];
            const owners = new Set(
                lead ? LEX.projects
                    .filter(p => !p.alt && p.client_id && words(p.name).includes(lead))
                    .map(p => p.client_id) : []
            );
            const taught = lead && LEARNED.leadClient.get(lead);
            let hit = owners.size === 1 ? ranked.find(r => owners.has(r[0])) : null;
            if (!hit && taught) hit = ranked.find(r => r[0] === taught) || null;
            if (hit) {
                clientLearned = Boolean(taught) && hit[0] === taught;
                ranked = [[hit[0], ranked[0][1] + CLIENT_TIE_MARGIN]].concat(ranked.filter(r => r !== hit));
            }
        }

        if (ranked.length === 0) {

            result.review_reasons.push("No client in the text and nothing in the database matches it");

        }

        else if (
            ranked.length > 1 &&
            ranked[0][1] - ranked[1][1] < CLIENT_TIE_MARGIN
        ) {

            const names = ranked.slice(0, 3)
                .map(([cid]) => state.clientById.get(cid).name);

            result.review_reasons.push(
                "Could belong to more than one client: " + names.join(" / ")
            );

        }

        else {

            const client = state.clientById.get(ranked[0][0]);

            result.client_name = client.name;
            result.client_id = client.id;
            let clientConf = Math.min(0.9, ranked[0][1]);
            if (clientLearned) clientConf = Math.max(clientConf, 0.85);

            // only one client has any evidence, and a distinctive word of
            // its project is in the line: no need to ask for confirmation
            if (ranked.length === 1 && projectProof.has(client.id)) {
                clientConf = Math.max(clientConf, 0.75);
            }

            result.confidence.client = Number(clientConf.toFixed(2));
            result.client_source = "inferred from database match";

            clientSet = new Set([client.id]);
            phrases = state.phrasesByClient.get(client.id) || [];

        }

    }


    // re-rank inside the final client when it was only inferred
    if (result.client_source === "inferred from database match") {

        evals.forEach(ev => {
            ev.projects = rank(ev.q, "project", clientSet);
            ev.dels = rank(ev.q, "deliverable", clientSet);
        });

    }


    // ---- decide each segment's role -------------------------
    const roles = evals.map((ev, idx) => {

        const p = ev.projects[0];
        const d = ev.dels[0];

        const dOk = strongDeliverable(d);
        const pOk = strongProject(p);

        // "Client Project - Deliverable": the first segment is the
        // project whenever it can be one
        if (segments.length > 1 && idx === 0 && pOk) {
            return "project";
        }

        // One block of text holding project AND deliverable words
        // ("Pharma Fund Guide design"). Try both readings and keep the
        // one that explains more of the words.
        if (segments.length === 1 && pOk && dOk) {

            // the deliverable already lives under that project (and is a
            // specific match: one shared word such as "pharma" is the
            // project's own word, not a deliverable, and would tie with
            // every other "pharma" deliverable)
            if (d.entity.project_id === p.entity.id && d.raw >= 0.85) {
                return "deliverable";
            }

            // a short, generic deliverable ("Fund Guide") is a poor clue to
            // its project: unless it matches almost exactly, or its project
            // also fits the text, read the line project-first
            const ownerRow = ev.projects.find(r => r.entity.id === d.entity.project_id);

            if (d.raw < 0.85 && !strongProject(ownerRow)) {
                return "project";
            }

            const underP =
                rank(ev.q, "deliverable", new Set([p.entity.client_id]))
                    .find(r =>
                        r.entity.project_id === p.entity.id &&
                        r.raw >= 0.45
                    );

            const owner =
                LEX.projects.find(x => x.id === d.entity.project_id && !x.alt);

            const covProjectFirst = coverage(
                ev.q,
                [p.entity.toks].concat(underP ? [underP.entity.toks] : [])
            );

            const covDeliverableFirst = coverage(
                ev.q,
                [d.entity.toks].concat(owner ? [owner.toks] : [])
            );

            return covDeliverableFirst > covProjectFirst + 0.05
                ? "deliverable"
                : "project";

        }

        if (dOk && (!pOk || d.raw >= p.raw + 0.05)) {
            return "deliverable";
        }

        if (pOk) return "project";

        return "unknown";

    });


    let projectIdx = roles.indexOf("project");

    let chosenProject = null;
    let kindPicked = false;
    let projectText = null;
    let deliverableParts = [];
    let dbDeliverable = null;


    // a deliverable that exists in the DB tells us its project
    const firstDel = roles.indexOf("deliverable");

    if (projectIdx === -1 && firstDel !== -1) {

        let d = evals[firstDel].dels[0];

        let owner = LEX.projects.find(p => p.id === d.entity.project_id && !p.alt);

        // a short generic deliverable ("Fund Guide") says little about its
        // project: only trust the owner if the match is near exact or the
        // owner project itself fits the text
        const ownerRow = evals[firstDel].projects.find(r => r.entity.id === d.entity.project_id);

        let trustOwner = d.raw >= 0.85 || strongProject(ownerRow);

        // "TFP > <deliverable>": the deliverable decides which month (familyPick)
        if (!trustOwner) {

            const fam = familyPick(evals[firstDel], rawLine);

            if (fam) {
                d = fam;
                owner = LEX.projects.find(p => p.id === fam.entity.project_id && !p.alt);
                trustOwner = Boolean(owner);
            }

        }

        if (owner && !trustOwner) {

            result.db_match.suggested_project = {
                id: owner.id,
                name: owner.name
            };

            result.review_reasons.push(
                "A deliverable with this wording exists under \"" + owner.name +
                "\", but the text does not mention that project"
            );

        }

        if (owner && trustOwner) {

            chosenProject = { entity: owner, score: d.raw, raw: d.raw, mass: d.mass };
            result.confidence.project = Number((d.raw * 0.9).toFixed(2));

        }

    }


    if (projectIdx !== -1) {

        chosenProject = evals[projectIdx].projects[0];
        projectText = evals[projectIdx].seg;

        // two projects of one client within a hair of each other: if the line
        // asks for a kind of work that only one of them is about, that one wins
        const byKind = pickByWorkKind(evals[projectIdx].projects, rawLine);

        if (byKind) {
            kindPicked = true;
            chosenProject = byKind;
        }

        // still undecided: prefer the close project that really has the type of
        // deliverable the line asks for ("AV" -> a project with a video)
        else {

            const byType = pickByDeliverableType(evals[projectIdx].projects, rawLine);

            if (byType) chosenProject = byType;

        }

        result.confidence.project = Number(Math.min(1, chosenProject.raw).toFixed(2));

    }


    // ---- project text / deliverable text --------------------
    if (segments.length === 1) {

        const ev = evals[0];

        if (roles[0] === "project") {

            // strip the words that were explained by the project
            const matched = new Set(chosenProject.entity.toks);

            const keep = ev.seg.split(/\s+/).filter(w => {

                const tok = stem(words(w).join(""));

                if (!tok) return false;

                const hit =
                    Array.from(matched).some(m => fuzzyEq(tok, m)) &&
                    !TYPE_WORDS.has(tok);

                return !hit;

            });

            const residual = tidy(keep.join(" "));

            // generic leftovers ("campaign", "creative") carry no meaning
            const meaningful = toTokens(residual, phrases)
                .some(t => idfOf(t) >= RESIDUAL_MIN_IDF || TYPE_WORDS.has(t));

            if (residual && meaningful) deliverableParts.push(residual);

            projectText = ev.seg;

        }

        else if (roles[0] === "deliverable") {

            deliverableParts.push(ev.seg);

        }

        else {

            // nothing matched: it is the work item itself
            deliverableParts.push(ev.seg);

        }

    }

    else {

        segments.forEach((seg, i) => {

            if (i === projectIdx) return;

            deliverableParts.push(seg);

        });

        // nothing matched as a project: the first segment is
        // most likely a new project the database does not have yet
        if (projectIdx === -1 && !chosenProject) {

            projectText = segments[0];
            deliverableParts = segments.slice(1);

        }

    }


    // ---- deliverable confidence -----------------------------
    const delText = tidy(deliverableParts.join(" - "));

    if (delText) {

        result.deliverable_name = delText;

        const q = toTokens(delText, phrases);

        const scope =
            chosenProject
                ? new Set([chosenProject.entity.client_id])
                : clientSet;

        let cands = rank(q, "deliverable", scope);

        if (chosenProject) {
            cands = cands.filter(c => c.entity.project_id === chosenProject.entity.id);
        }

        cands = preferDeliverableType(cands, rawLine);

        if (strongDeliverable(cands[0])) {

            dbDeliverable = cands[0];

            result.confidence.deliverable = Number(cands[0].raw.toFixed(2));
            result.db_match.deliverable_found = true;
            result.db_match.deliverable_in_db = cands[0].entity.name;
            result.db_match.deliverable_id = cands[0].entity.id;

            // A full, specific deliverable name that exists exactly once in PMT
            // ("Stay Focused Without Losing the Bigger Picture") identifies its
            // project and client by itself; it does not need to be confirmed.
            // Generic names ("Teaser", "Reel") are shared, so they never qualify.
            result._exactDeliverable =
                cands[0].raw >= 0.95 &&
                cands[0].recall >= 0.999 &&
                cands[0].precision >= 0.9 &&
                cands[0].entity.toks.length >= 3 &&
                state.delSigCount.get(cands[0].entity.toks.join(" ")) === 1;

        }

        // Observability only (does not change any decision above): the
        // runners-up and the raw scores, so a close call can be spotted and
        // logged by the caller.
        result.db_match.deliverable_alternatives =
            cands
                .filter(r => r.raw > 0.3)
                .slice(0, 3)
                .map(r => ({
                    id: r.entity.id,
                    deliverable: r.entity.name,
                    score: Number(r.raw.toFixed(2))
                }));

        result.scores.deliverable = scoreOf(cands[0]);

    }


    // ---- deliverable type -----------------------------------
    if (dbDeliverable && dbDeliverable.entity.type) {

        result.deliverable_type = dbDeliverable.entity.type;
        result.type_source = "database";

    }

    else if (lineType && lineType.type) {

        result.deliverable_type = lineType.type;
        result.type_source = "line";

    }

    else if (lineType) {

        // "Data Research & Analysis": two PMT types fit, the line does not say which
        result.type_candidates = lineType.candidates;

    }


    // ---- project fields -------------------------------------
    if (chosenProject) {

        result.scores.project = scoreOf(chosenProject);

        result.project_name = chosenProject.entity.name;
        result.project_id = chosenProject.entity.id;
        result.project_text = projectText;
        result.db_match.project_found = true;

        // the project decides the client if nothing else did
        if (!result.client_id && chosenProject.entity.client_id) {

            const client = state.clientById.get(chosenProject.entity.client_id);

            result.client_name = client.name;
            result.client_id = client.id;
            result.confidence.client = 0.6;
            result.client_source = "inferred from project";

        }

        // sibling brand won over the one named in the text
        if (
            result.client_id &&
            chosenProject.entity.client_id &&
            chosenProject.entity.client_id !== result.client_id
        ) {

            const client = state.clientById.get(chosenProject.entity.client_id);

            result.client_name = client.name;
            result.client_id = client.id;
            result.client_source = "corrected by project match";

        }

    }

    else if (projectText) {

        result.project_name = projectText;
        result.project_text = projectText;
        result.review_reasons.push("Project not found in the database (new project?)");

    }


    // ---- alternatives for the reviewer ----------------------
    const altSource =
        evals[projectIdx !== -1 ? projectIdx : 0];

    result.db_match.alternatives =
        altSource.projects
            .filter(r => r.raw > 0.15)
            .slice(0, 3)
            .map(r => ({
                project: r.entity.name,
                client: (state.clientById.get(r.entity.client_id) || {}).name || null,
                score: Number(r.raw.toFixed(2))
            }));


    const alts = result.db_match.alternatives;

    // The best project is not a coin flip when it holds a distinctive word of
    // the line (not a deliverable-type word like "creatives" / "booklet") that
    // the runner-up lacks, and the runner-up holds none that the best lacks:
    // "ICICI Pharma - creatives" fits "IPru Pharma ETF Campaign" on "pharma",
    // while "Ipru Products Updation and Creatives" only shares "creatives".
    const rows = altSource.projects.filter(r => r.raw > 0.15).slice(0, 3);

    const distinctive = (row) =>
        altSource.q.filter(t => !TYPE_STEMS.has(t) && row.entity.toks.includes(t));

    // a language ("kannada", "hindi") or the word "translation" in the line
    // points at the project that is a translation one over a project that is not
    const wantsTranslation =
        toTokens(rawLine).some(t => t === "translation" || LANGUAGE_TOKENS.has(t));

    const dominant =
        rows.length > 1 &&
        (() => {
            if (
                wantsTranslation &&
                rows[0].entity.toks.includes("translation") &&
                !rows[1].entity.toks.includes("translation")
            ) {
                return true;
            }
            const a = distinctive(rows[0]);
            const b = distinctive(rows[1]);
            return a.some(t => !b.includes(t)) && !b.some(t => !a.includes(t));
        })();

    // The best project is a live one and the runner-up is finished, scrapped
    // or on hold: a person asking for "changes" means the live project.
    // Only the "Ambiguous project" hold is lifted; weak matches stay held.
    const liveBeatsClosed =
        rows.length > 1 &&
        rows[0].entity.id === result.project_id &&
        rows[0].entity.status === "Active" &&
        rows.slice(1).every(r => r.entity.status !== "Active");

    if (
        result.project_id &&
        alts.length > 1 &&
        !dominant &&
        !kindPicked &&
        !liveBeatsClosed &&
        alts[0].project === result.project_name &&
        alts[0].score - alts[1].score < 0.15 &&
        // two PMT projects with the very same name and client are one project
        // to a person (a duplicate record), not a real choice to review
        !(alts[0].project === alts[1].project && alts[0].client === alts[1].client)
    ) {

        result.review_reasons.push(
            "Ambiguous project: " + alts[0].project + " / " + alts[1].project
        );

    }

    return finish(result);

}


function finish(result, reason) {

    delete result._family;

    const exactDeliverable = result._exactDeliverable === true;

    delete result._exactDeliverable;

    if (reason) result.review_reasons.push(reason);

    if (!result.client_id) {
        result.review_reasons.push("Client unresolved");
    }

    if (result.client_id && !result.project_id && !result.review_reasons.some(r => r.startsWith("Project"))) {
        result.review_reasons.push("No matching project in the database");
    }

    if (
        !exactDeliverable &&
        result.client_source &&
        result.client_source !== "name in text" &&
        result.confidence.client < 0.7
    ) {
        result.review_reasons.push("Client was guessed, please confirm");
    }

    // Client was inferred and the line named no project: the match rests only on a
    // deliverable name that several clients can share (e.g. "Teaser"). Ask a manager.
    if (
        !(exactDeliverable && result.project_id) &&
        result.client_id &&
        result.client_source &&
        result.client_source !== "name in text" &&
        !result.project_text
    ) {
        result.review_reasons.push("Neither client nor project was named, matched on the deliverable name only, please confirm");
    }

    if (
        result.project_id &&
        result.confidence.project < 0.45
    ) {
        result.review_reasons.push("Weak project match");
    }

    result.review_reasons = Array.from(new Set(result.review_reasons));

    result.needs_review = result.review_reasons.length > 0;

    return result;

}


module.exports = {
    loadLexicon,
    useLexicon,
    useLearned,
    commaPhrases,
    isReady,
    lexiconInfo,
    resolveLine,
    typesAskedFor
};
