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

const {
    aliasPhrasesFor,
    toTokens,
    words,
    stem,
    fuzzyEq
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

    LEX = JSON.parse(fs.readFileSync(lexFile, "utf8"));

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

    state = {
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


function recencyPrior(upd) {

    if (!upd) return 0;

    return (
        (upd - state.minUpd) /
        Math.max(1, state.maxUpd - state.minUpd)
    ) * 0.04;

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

        out.push({
            entity: e,
            score: score + (kind === "project" ? recencyPrior(e.upd) : 0),
            raw: score,
            mass: eHit,
            recall,
            precision
        });

    }

    out.sort((a, b) => b.score - a.score);

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
    r && r.raw >= PROJECT_MIN_SCORE && r.mass >= MIN_MASS;

const strongDeliverable = (r) =>
    r && r.raw >= DELIVERABLE_MIN_SCORE && r.mass >= MIN_MASS;


// ------------------------------------------------------------
// LINE CLEANING
// ------------------------------------------------------------

const BULLET_RE = /^\s*(?:[-•·▪●–—]|\*(?=\s)|\d+[.)])\s+/;

const PRIORITY_RE =
    /[\s\-–—(\[]*\b(high|medium|low|urgent)\s*priority\b[\s)\]]*$/i;

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


// ------------------------------------------------------------
// MAIN: RESOLVE ONE LINE
// ------------------------------------------------------------

function resolveLine(rawLine) {

    if (!isReady()) {
        return null;
    }

    let text = stripWrapping(rawLine.replace(BULLET_RE, ""));

    const result = {
        client_name: null,
        client_id: null,
        project_name: null,
        project_id: null,
        project_text: null,
        deliverable_name: null,
        action: null,
        notes: null,
        slot: null,
        priority: null,
        confidence: { client: 0, project: 0, deliverable: 0 },
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
    const pm = text.match(PRIORITY_RE);

    if (pm) {
        const w = pm[1].toLowerCase();
        result.priority = w.charAt(0).toUpperCase() + w.slice(1);
        text = text.replace(PRIORITY_RE, "");
    }

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

    if (notes.length) result.notes = notes.join("; ");

    // ---- first half / second half --------------------------
    const sm = text.match(SLOT_RE);

    if (sm) {
        result.slot = sm[1].charAt(0).toUpperCase() + sm[1].slice(1).toLowerCase() + " half";
        text = text.replace(SLOT_RE, " ");
    }

    // ---- action words (changes, review, ideation ...) -------
    const actions = [];

    text = text.replace(ACTION_RE, (m) => {
        actions.push(m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
        return " ";
    });

    if (actions.length) result.action = actions.join(" + ");

    text = tidy(text);


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
    const segments =
        rest
            .split(/\s+[-–—]\s+|\s*[–—]\s*/)
            .map(tidy)
            .filter(Boolean);

    result.task_text = tidy([rest, result.action].filter(Boolean).join(" "));


    // nothing left after the client name
    if (segments.length === 0) {
        return finish(result, "Only a client name was given");
    }


    // ---- evaluate every segment -----------------------------
    const evals = segments.map(seg => {

        const q = toTokens(seg, phrases);

        let projects = rank(q, "project", clientSet);
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

        for (const ev of evals) {

            const pool = [];

            ev.dels.slice(0, 12).forEach(r => {
                if (strongDeliverable(r)) pool.push(r);
            });

            ev.projects.slice(0, 12).forEach(r => {
                if (strongProject(r)) pool.push(r);
            });

            for (const r of pool) {

                const cid = r.entity.client_id;

                if (!cid) continue;

                votes.set(cid, Math.max(votes.get(cid) || 0, r.raw));

            }

        }

        const ranked = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);

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
            result.confidence.client = Number(Math.min(0.9, ranked[0][1]).toFixed(2));
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

            // the deliverable already lives under that project
            if (d.entity.project_id === p.entity.id) {
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
    let projectText = null;
    let deliverableParts = [];
    let dbDeliverable = null;


    // a deliverable that exists in the DB tells us its project
    const firstDel = roles.indexOf("deliverable");

    if (projectIdx === -1 && firstDel !== -1) {

        const d = evals[firstDel].dels[0];

        const owner = LEX.projects.find(p => p.id === d.entity.project_id && !p.alt);

        // a short generic deliverable ("Fund Guide") says little about its
        // project: only trust the owner if the match is near exact or the
        // owner project itself fits the text
        const ownerRow = evals[firstDel].projects.find(r => r.entity.id === d.entity.project_id);

        const trustOwner = d.raw >= 0.85 || strongProject(ownerRow);

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

        if (strongDeliverable(cands[0])) {

            dbDeliverable = cands[0];

            result.confidence.deliverable = Number(cands[0].raw.toFixed(2));
            result.db_match.deliverable_found = true;
            result.db_match.deliverable_in_db = cands[0].entity.name;

        }

    }


    // ---- project fields -------------------------------------
    if (chosenProject) {

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

    if (
        result.project_id &&
        alts.length > 1 &&
        alts[0].project === result.project_name &&
        alts[0].score - alts[1].score < 0.15
    ) {

        result.review_reasons.push(
            "Ambiguous project: " + alts[0].project + " / " + alts[1].project
        );

    }

    return finish(result);

}


function finish(result, reason) {

    delete result._family;

    if (reason) result.review_reasons.push(reason);

    if (!result.client_id) {
        result.review_reasons.push("Client unresolved");
    }

    if (result.client_id && !result.project_id && !result.review_reasons.some(r => r.startsWith("Project"))) {
        result.review_reasons.push("No matching project in the database");
    }

    if (
        result.client_source &&
        result.client_source !== "name in text" &&
        result.confidence.client < 0.7
    ) {
        result.review_reasons.push("Client was guessed, please confirm");
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
    isReady,
    resolveLine
};
