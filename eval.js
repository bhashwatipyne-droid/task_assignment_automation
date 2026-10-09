// ============================================================
// EVAL - how often does the matcher recover the right client / project
// from text built out of your own database?
//
//   node eval.js
//
// Two synthetic tests (real tasklists would be better, so keep adding
// to tests as you collect them):
//
//   A. "<client short name> <project name>"          -> must find that client + project
//   B. "<client short name> <project> - <deliverable>" -> must find that client + project
//
// Projects/deliverables are sampled from live (non-hidden) data only.
// ============================================================

const fs = require("fs");
const matcher = require("./tasklistMatcher");
const { CLIENT_ALIASES } = require("./clientAliases");

matcher.loadLexicon();

const L = JSON.parse(fs.readFileSync("lexicon.json", "utf8"));
const clientById = new Map(L.clients.map(c => [c.id, c]));

// deterministic pseudo-random sampling
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const sample = (arr, n) => {
    const a = arr.slice();
    const out = [];
    while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]);
    return out;
};

const shortName = (clientId) => {
    const c = clientById.get(clientId);
    if (!c) return null;
    const aliases = CLIENT_ALIASES[c.name] || [];
    return aliases.length ? aliases[aliases.length - 1 > 0 ? 0 : 0] : c.name;
};

// strip the client name out of a DB name so the test text does not repeat it
const projectsOnly = L.projects.filter(p => !p.alt && p.client_id);

let nA = 0, clientOkA = 0, projOkA = 0;
const missesA = [];

for (const p of sample(projectsOnly, 250)) {

    const alias = shortName(p.client_id);
    if (!alias) continue;

    const text = `${alias} ${p.name}`;
    const r = matcher.resolveLine(text);

    nA++;
    if (r.client_id === p.client_id) clientOkA++;
    if (r.project_id === p.id) projOkA++;
    else if (missesA.length < 12) missesA.push([text, r.project_name]);

}

let nB = 0, clientOkB = 0, projOkB = 0, delFoundB = 0;
const missesB = [];

const projById = new Map(L.projects.filter(p => !p.alt).map(p => [p.id, p]));

for (const d of sample(L.deliverables.filter(x => projById.has(x.project_id)), 300)) {

    const proj = projById.get(d.project_id);
    const alias = shortName(proj.client_id);
    if (!alias || !proj.client_id) continue;

    const text = `${alias} ${proj.name} - ${d.name}`;
    const r = matcher.resolveLine(text);

    nB++;
    if (r.client_id === proj.client_id) clientOkB++;
    if (r.project_id === proj.id) projOkB++;
    else if (missesB.length < 12) missesB.push([text.slice(0, 90), r.project_name]);
    if (r.deliverable_name) delFoundB++;

}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0) + "%";

console.log(`A. client + project name only   (n=${nA})`);
console.log(`   client correct  ${pct(clientOkA, nA)}`);
console.log(`   project correct ${pct(projOkA, nA)}`);
console.log(`B. client + project - deliverable (n=${nB})`);
console.log(`   client correct  ${pct(clientOkB, nB)}`);
console.log(`   project correct ${pct(projOkB, nB)}`);
console.log(`   deliverable text kept ${pct(delFoundB, nB)}`);

console.log("\nSample misses (A):");
missesA.slice(0, 6).forEach(m => console.log("  ", m[0], " -> ", m[1]));
console.log("Sample misses (B):");
missesB.slice(0, 6).forEach(m => console.log("  ", m[0], " -> ", m[1]));
