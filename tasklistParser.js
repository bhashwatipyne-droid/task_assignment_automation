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
    return MATCHER_READY;
}


// ------------------------------------------------------------
// SMALL HELPERS
// ------------------------------------------------------------

const BULLET_RE = /^\s*(?:[-•·▪●–—]|\*(?=\s)|\d+[.)])\s+/;

const PRIORITY_RE =
    /[\s\-–—(\[]*\b(high|medium|low|urgent)\s*priority\b[\s)\]]*$/i;

const HEADER_RE =
    /^(content|design)\s+(team(\s+task\s*list)?|task\s*list)\s*:?$/i;

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
        (text || "")
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

    if (MATCHER_READY) {

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
                alternatives: m.db_match.alternatives,

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

    const priorityMatch = line.match(PRIORITY_RE);

    if (priorityMatch) {

        const word = priorityMatch[1].toLowerCase();

        priority =
            word.charAt(0).toUpperCase() +
            word.slice(1);

        line = line.replace(PRIORITY_RE, "").trim();

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

function parseTaskList(text, assignees = []) {

    const lines =
        (text || "")
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

    const team = detectTeam(text);

    const tasks = [];
    const calls = [];
    const warnings = [];

    let currentAssignee = null;
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
            currentAssignee = null;
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

            const bare =
                cleanFormatting(line.replace(/[:：]\s*$/, ""));

            const known = knownAssignee(bare);

            if (known) {

                currentAssignee = known;
                continue;

            }

            // Unknown name: a short line with no separators,
            // directly followed by bulleted lines.
            const nextLine = lines[i + 1] || "";

            if (
                nextLine &&
                isBulleted(nextLine) &&
                bare.split(/\s+/).length <= 4 &&
                !/[-–—]/.test(bare)
            ) {

                currentAssignee = bare;

                warnings.push(
                    `Assignee "${bare}" is not in ASSIGNEES`
                );

                continue;

            }

        }


        // ----------------------------------------------------
        // TASK LINE
        // ----------------------------------------------------

        if (!currentAssignee) {

            warnings.push(
                `Ignored line before first assignee: ${line}`
            );

            continue;

        }


        tasks.push({
            assignee: currentAssignee,
            ...parseTaskLine(line)
        });

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
