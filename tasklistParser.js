// ============================================================
// TASKLIST PARSER
// ============================================================
//
// Turns a manager's WhatsApp tasklist into structured rows:
//
//   assignee, client_name, project_name, deliverable_name, priority
//
// Expected message shape:
//
//   Content Team
//   Harshal
//   - ICICI Prudential Pharma - From Lab to Life (Review & Changes) - High Priority
//   - Bandhan One idiot Campaign
//
//   Vanshika
//   - ...
//
//   Calls for today:
//   - ICICI TVC - Vanshika
//
// Line structure it understands:
//
//   <Client> <Project> - <Deliverable> [- High Priority]
//
// Client names are matched against CLIENT_ALIASES below and
// returned using the exact name stored in the PMT `clients`
// collection, so n8n can look the client up directly.
// ============================================================


// ------------------------------------------------------------
// CLIENT ALIASES
// Canonical name (as in PMT clients collection) -> short forms
// people type in WhatsApp. Add new ones here as needed.
// ------------------------------------------------------------

const { CLIENT_ALIASES } = require("./clientAliases");



// Flattened list, longest alias first so "icici prudential"
// wins over "icici", "absl apex" wins over "absl", etc.
const ALIAS_LIST = Object.entries(CLIENT_ALIASES)
    .flatMap(([client, aliases]) =>
        aliases.map(alias => ({ client, alias }))
    )
    .sort((a, b) => b.alias.length - a.alias.length);


// ------------------------------------------------------------
// DATABASE-TRAINED MATCHER (optional)
// Needs lexicon.json (node build-lexicon.js). Without it the parser
// falls back to the plain separator rules below.
// ------------------------------------------------------------

const matcher = require("./tasklistMatcher");

let MATCHER_READY = false;

try {
    MATCHER_READY = matcher.loadLexicon();
}
catch (error) {
    console.error("Could not load lexicon.json:", error.message);
}

function matcherReady() {
    return MATCHER_READY || matcher.isReady();
}


// ------------------------------------------------------------
// SMALL HELPERS
// ------------------------------------------------------------

const BULLET_RE = /^\s*(?:[-•·▪●–—]|\*(?=\s)|\d+[.)])\s+/;

const PRIORITY_RE =
    /[\s\-–—(\[]*\b(high|medium|low|urgent)\s*priority\b[\s)\]]*/gi;

const HEADER_RE =
    /^(content|design|animation)\s+(team(\s+task\s*list)?|task\s*list)\s*:?$/i;

// "@all Design team tasklist" -> "Design team tasklist"
function stripMentions(text) {
    return (text || "").replace(/(^|\s)@\S+/g, " ").replace(/\s+/g, " ").trim();
}

const CALLS_RE = /^calls?\s*(for\s+(today|tomorrow))?\s*:?$/i;


function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// Removes WhatsApp formatting (*bold*, _italic_, ~strike~, `mono`)
// from the start and end of a line only.
// Text pasted from some editors arrives with HTML entities ("&#x20;" for a space).
function decodeEntities(text) {
    return (text || "")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&");
}


function cleanFormatting(text) {
    return (text || "")
        .trim()
        .replace(/^[*_~`]+|[*_~`]+$/g, "")
        .trim();
}


function isBulleted(line) {
    return BULLET_RE.test(line);
}


function stripBullet(line) {
    return line.replace(BULLET_RE, "").trim();
}


// "Content Team", "CONTENT TEAM TASKLIST", "Design Tasklist"
function headerText(line) {
    return cleanFormatting(line)
        .replace(/^[^a-z0-9]+/i, "")
        .replace(/\s+/g, " ")
        .trim();
}


// ------------------------------------------------------------
// TEAM / TASKLIST DETECTION
// Only the FIRST non-empty line is checked, so a casual message
// that merely mentions "content" is not treated as a tasklist.
// ------------------------------------------------------------

function headerMatch(line) {
    return headerText(stripMentions(cleanFormatting(line))).match(HEADER_RE);
}


function detectTeam(text) {

    // the header is one of the first few lines
    const firstLines =
        decodeEntities(text)
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 3);

    for (const line of firstLines) {

        const match = headerMatch(line);

        if (match) return match[1].toLowerCase();

    }

    return null;

}


function isTaskListMessage(text) {
    return detectTeam(text) !== null;
}


// ------------------------------------------------------------
// SPLIT ON TOP-LEVEL SEPARATORS
// " - ", " – ", " — " and unspaced – / —.
// Anything inside (...) is left alone, so
// "Emerging Markets (Major Changes - 80%)" stays in one piece.
// A plain hyphen inside a word ("Post-Tax") is not a separator.
// ------------------------------------------------------------

function splitTopLevel(text) {

    let depth = 0;
    let masked = "";

    for (const ch of text) {

        if (ch === "(") {
            depth++;
            masked += ch;
        }

        else if (ch === ")") {
            depth = Math.max(0, depth - 1);
            masked += ch;
        }

        else {
            masked += depth > 0 ? "\u0000" : ch;
        }

    }

    const separator = /\s+-\s+|\s*[–—]\s*/g;

    const parts = [];
    let last = 0;
    let match;

    while ((match = separator.exec(masked)) !== null) {

        parts.push(text.slice(last, match.index));
        last = match.index + match[0].length;

    }

    parts.push(text.slice(last));

    return parts
        .map(part => part.trim())
        .filter(Boolean);

}


// ------------------------------------------------------------
// CLIENT MATCH (start of line only)
// ------------------------------------------------------------

function matchClient(text) {

    for (const { client, alias } of ALIAS_LIST) {

        const re = new RegExp(
            `^${escapeRegex(alias)}(?![A-Za-z0-9])`,
            "i"
        );

        if (re.test(text)) {

            return {
                client,
                rest: text
                    .replace(re, "")
                    .replace(/^[\s\-–—:,]+/, "")
                    .trim()
            };

        }

    }

    return { client: null, rest: text };

}


// ------------------------------------------------------------
// PARSE ONE TASK LINE
// ------------------------------------------------------------

function parseTaskLine(rawLine) {

    if (matcherReady()) {

        const m = matcher.resolveLine(rawLine);

        if (m) {

            return {

                client_name: m.client_name,
                client_id: m.client_id,
                project_name: m.project_name,
                project_id: m.project_id,
                project_text: m.project_text,
                deliverable_name: m.deliverable_name,
                action: m.action,
                notes: m.notes,
                slot: m.slot,
                priority: m.priority,

                confidence: m.confidence,
                client_source: m.client_source,
                db_deliverable: m.db_match.deliverable_in_db,
                db_deliverable_id: m.db_match.deliverable_id || null,
                deliverable_alternatives: m.db_match.deliverable_alternatives || [],
                alternatives: m.db_match.alternatives,
                scores: m.scores || null,

                needs_review: m.needs_review,
                review_reasons: m.review_reasons,

                match_method: "database",

                raw_line: rawLine

            };

        }

    }

    let line = cleanFormatting(stripBullet(rawLine));


    // Priority (removed from the text)
    let priority = null;

    const priorityMatch = /priority/i.test(line) && line.match(PRIORITY_RE);

    // priority words are dropped, the worksheet has no priority
    if (priorityMatch) {

        line = line.replace(PRIORITY_RE, " ").trim();

    }


    // Client
    const { client, rest } = matchClient(line);


    // Project / Deliverable
    const parts = splitTopLevel(rest);

    let project = null;
    let deliverable = null;

    if (parts.length >= 2) {

        project = parts[0];
        deliverable = parts.slice(1).join(" - ");

    }

    else if (parts.length === 1) {

        deliverable = parts[0];

    }

    else {

        deliverable = line;

    }


    return {

        client_name: client,
        project_name: project,
        deliverable_name: deliverable,
        priority: priority,

        // True when the client or project could not be worked out
        // from the text alone and should be confirmed / fuzzy-matched
        needs_review: !client || !project,

        match_method: "rules",

        raw_line: rawLine

    };

}


// ------------------------------------------------------------
// PARSE WHOLE TASKLIST
// ------------------------------------------------------------


// ------------------------------------------------------------
// COMMA = SEPARATE DELIVERABLES
// "TFP Premium - 1 IG, 1 Minimalist" is two worksheet entries:
//   "TFP Premium - 1 IG" and "TFP Premium - 1 Minimalist".
// Everything before and after the comma-separated part is repeated on
// each entry. The first part (client / project) is never split, commas
// inside brackets or between digits ("1,000") are left alone.
// ------------------------------------------------------------
// A comma inside a deliverable that exists in PMT under that name
// ("Your US Exposure, From GIFT City") is part of its name. Hide those commas
// from the splitter (\u0001) and put them back afterwards.
const HIDDEN_COMMA = "\u0001";

let commaRegexCache = { list: null, regexes: [] };

function protectKnownCommas(text) {

    if (!matcherReady()) return text;

    const list = matcher.commaPhrases();

    if (commaRegexCache.list !== list) {

        commaRegexCache = {
            list,
            regexes: list.map(p =>
                new RegExp(p.split(" ").map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]+"), "gi")
            )
        };

    }

    let out = text;

    for (const re of commaRegexCache.regexes) {

        re.lastIndex = 0;

        out = out.replace(re, (m) => m.replace(/[,،]/g, HIDDEN_COMMA));

    }

    return out;

}


function splitCommaDeliverables(line) {

    const bulletMatch = line.match(BULLET_RE);
    const bullet = bulletMatch ? bulletMatch[0] : "";
    const body = line.slice(bullet.length);

    const segments = body.split(/\s+[-–—]\s+/);

    if (segments.length < 2) return [line];

    for (let i = 1; i < segments.length; i++) {

        const parts = [];
        let depth = 0;
        let cur = "";
        const seg = protectKnownCommas(segments[i]);

        for (let k = 0; k < seg.length; k++) {

            const ch = seg[k];

            if ("([{".includes(ch)) depth++;
            else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);

            const isComma = ch === "," || ch === "،";
            const digitComma = ch === "," && /\d/.test(seg[k - 1] || "") && /\d/.test(seg[k + 1] || "");

            if (isComma && depth === 0 && !digitComma) {
                parts.push(cur);
                cur = "";
            } else {
                cur += ch;
            }

        }

        parts.push(cur);

        const pieces = parts.map(x => x.trim()).filter(Boolean);

        if (pieces.length < 2) continue;

        // every piece must look like a deliverable, not a stray fragment
        if (!pieces.every(x => /[\p{L}\d]/u.test(x))) return [line];

        return pieces.map(piece => {
            const copy = segments.slice();
            copy[i] = piece.split(HIDDEN_COMMA).join(",");
            return bullet + copy.join(" - ");
        });

    }

    return [line];

}


// ------------------------------------------------------------
// QUANTITY = ONE ENTRY PER UNIT
// "TFP Premium - 2 Minimalist" is two sticky notes, each "1 Minimalist",
// not one note that says "2 Minimalist". Only a count (2 to 10) that
// opens a segment after the client / project is expanded; the first
// segment, a lone number ("TFP reviews - 10") and a count of 1 are left
// alone. The units carry copy_index / copy_total so the store can tell
// them apart (their text is identical).
// ------------------------------------------------------------
const MAX_QUANTITY_SPLIT = 10;

// "<words ending in a letter> <count>" at the end of a line or segment. A
// dash or colon before the number ("TFP reviews- 10") is not read as a quantity.
const TRAILING_QUANTITY_RE = /^(.*\p{L})\s+(\d{1,2})$/u;

const QUANTITY_SEGMENT_RE = /^(\d{1,2})\s+(\p{L}[\p{L}\s/&]*)$/u;

function singularLastWord(text) {

    return text.replace(/(\p{L}+)(\s*)$/u, (all, word, tail) => {

        const plural = word.length > 4 && /[^s]s$/i.test(word) && !/(is|us)$/i.test(word);

        return (plural ? word.slice(0, -1) : word) + tail;

    });

}

function expandQuantity(line) {

    const bulletMatch = line.match(BULLET_RE);
    const bullet = bulletMatch ? bulletMatch[0] : "";
    const segments = line.slice(bullet.length).split(/\s+[-–—]\s+/);

    const hits = [];

    for (let i = 1; i < segments.length; i++) {

        const m = segments[i].trim().match(QUANTITY_SEGMENT_RE);

        if (m && Number(m[1]) >= 2 && Number(m[1]) <= MAX_QUANTITY_SPLIT) {
            hits.push({ i, count: Number(m[1]), what: m[2].trim() });
        }

    }

    // no leading count: a count AFTER a plural word ("Bajaj One pagers 7",
    // "TFP reviews- 10") also means that many entries. A singular word with a
    // number ("Creative 2", "Phase 2") is a label, not a quantity.
    if (hits.length === 0) {

        const last = segments.length - 1;

        const m = segments[last].trim().match(TRAILING_QUANTITY_RE);

        if (m) {

            const count = Number(m[2]);

            const lastWord = (m[1].match(/(\p{L}+)$/u) || [])[1] || "";

            const plural = lastWord.length > 3 && /[^s]s$/i.test(lastWord) && !/(is|us)$/i.test(lastWord);

            if (plural && count >= 2 && count <= MAX_QUANTITY_SPLIT) {

                const copy = segments.slice();
                copy[last] = singularLastWord(m[1].trim());

                const text = bullet + copy.join(" - ");

                return Array.from({ length: count }, (_, k) => ({ text, index: k + 1, total: count }));

            }

        }

        return [{ text: line, index: 1, total: 1 }];

    }

    // two counts in one line ("2 reels - 3 carousels") is not a shape to guess at
    if (hits.length !== 1) return [{ text: line, index: 1, total: 1 }];

    const { i, count, what } = hits[0];

    const copy = segments.slice();
    copy[i] = `1 ${singularLastWord(what)}`;

    const text = bullet + copy.join(" - ");

    return Array.from({ length: count }, (_, k) => ({ text, index: k + 1, total: count }));

}


// ------------------------------------------------------------
// ASSIGNEE HEADER, ONE OR SEVERAL PEOPLE
//   "Shubham"   "Aniket, Vaishnavi"   "Aniket / Shubham"   "Nutan & Sanjana"
//   "Shraddha Manali" (two known first names)   "*Bold wrapped*"
// Returns { names, unknown } or null when the line is not a header.
// ------------------------------------------------------------
function headerNames(line, nextLine, knownAssignee) {

    const bare = cleanFormatting(line.replace(/[:：]\s*$/, ""));

    if (!bare) return null;

    const wrapped = /^[*_~]+[^*_~]+[*_~]+$/.test(line.trim());

    const whole = knownAssignee(bare);

    if (whole) return { names: [whole], unknown: [] };

    const parts = bare
        .split(/\s*(?:,|\/|&|\+|\band\b)\s*/i)
        .map(x => cleanFormatting(x))
        .filter(Boolean);

    if (parts.length === 0) return null;

    const known = parts.map(knownAssignee);

    if (known.every(Boolean)) return { names: known, unknown: [] };

    // "Shraddha Manali": every word is a known name
    if (parts.length === 1) {

        const words = bare.split(/\s+/);

        if (words.length > 1 && words.every(w => knownAssignee(w))) {
            return { names: words.map(w => knownAssignee(w)), unknown: [] };
        }

    }

    // a short name-only line that is bold, or directly followed by bullets
    const looksLikeNames =
        parts.every(x => x.split(/\s+/).length <= 4 && !/[-–—\d]/.test(x));

    if (looksLikeNames && (wrapped || (nextLine && isBulleted(nextLine)))) {

        const names = parts.map((x, k) => known[k] || x);

        return { names, unknown: parts.filter((x, k) => !known[k]) };

    }

    return null;

}


function parseTaskList(text, assignees = []) {

    text = decodeEntities(text);

    const lines =
        (text || "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

    const team = detectTeam(text);

    const tasks = [];
    const splitSeen = new Map();
    const calls = [];
    const warnings = [];

    let currentAssignees = [];
    let inCalls = false;


    const knownAssignee = (name) =>
        assignees.find(a =>
            a.toLowerCase() === name.toLowerCase()
        ) || null;


    for (let i = 0; i < lines.length; i++) {

        const line = lines[i];


        // Header line ("Content Team")
        if (headerMatch(line)) {
            continue;
        }


        // "Calls for today:" starts the calls section
        if (CALLS_RE.test(cleanFormatting(line))) {

            inCalls = true;
            currentAssignees = [];
            continue;

        }


        // ----------------------------------------------------
        // CALLS SECTION:  "- ICICI TVC - Vanshika"
        // ----------------------------------------------------

        if (inCalls) {

            const entry = stripBullet(line);
            const parts = splitTopLevel(entry);

            let topic = entry;
            let owner = null;

            if (parts.length >= 2) {

                const last = parts[parts.length - 1];

                owner =
                    knownAssignee(last) ||
                    (/^team$/i.test(last) ? "Team" : null);

                topic = owner
                    ? parts.slice(0, -1).join(" - ")
                    : entry;

            }

            calls.push({
                topic: topic,
                owner: owner,
                raw_line: line
            });

            continue;

        }


        // ----------------------------------------------------
        // ASSIGNEE LINE
        // ----------------------------------------------------

        if (!isBulleted(line)) {

            const header = headerNames(line, lines[i + 1] || "", knownAssignee);

            if (header) {

                currentAssignees = header.names;

                header.unknown.forEach(name =>
                    warnings.push(`Assignee "${name}" is not in ASSIGNEES`)
                );

                continue;

            }

        }


        // ----------------------------------------------------
        // TASK LINE
        // ----------------------------------------------------

        if (currentAssignees.length === 0) {

            warnings.push(
                `Ignored line before first assignee: ${line}`
            );

            continue;

        }


        // a header with several names gives every one of them the task
        const pieces = splitCommaDeliverables(line);

        for (const piece of pieces) {

            // "2 Minimalist" becomes two entries
            for (const unit of expandQuantity(piece)) {

                for (const assignee of currentAssignees) {

                    // Two different lines can split into the same text
                    // ("1 Carousel, data analysis SMI" and "1 minimalist, data
                    // analysis SMI" both give "... - data analysis SMI"). The
                    // first keeps its plain key; a later one from ANOTHER
                    // line gets dup_index 2, 3... so it is not dropped as a
                    // repeat. The same line typed twice is still a repeat.
                    let dup = null;

                    if (pieces.length > 1 && unit.total === 1) {

                        const sig = assignee.toLowerCase() + "|" +
                            unit.text.replace(BULLET_RE, "").replace(/\s+/g, " ").trim().toLowerCase();

                        const seen = splitSeen.get(sig);

                        if (!seen) {
                            splitSeen.set(sig, { line: i, count: 1 });
                        } else if (seen.line !== i) {
                            seen.count += 1;
                            dup = seen.count;
                        }

                    }

                    tasks.push({
                        assignee: assignee,
                        ...parseTaskLine(unit.text),
                        ...(unit.total > 1
                            ? { copy_index: unit.index, copy_total: unit.total }
                            : {}),
                        ...(dup ? { dup_index: dup } : {})
                    });

                }

            }

        }

    }


    // Backwards-compatible alias: older n8n flows read `deliverable`
    tasks.forEach(task => {
        task.deliverable = task.deliverable_name;
    });


    return {

        team: team,

        task_count: tasks.length,

        tasks: tasks,

        calls: calls,

        warnings: warnings

    };

}


module.exports = {
    CLIENT_ALIASES,
    matcherReady,
    detectTeam,
    isTaskListMessage,
    parseTaskList,
    parseTaskLine
};
