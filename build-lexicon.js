// ============================================================
// BUILD LEXICON  ("training" step)
// ============================================================
//
// Reads your PMT exports and writes lexicon.json, which the matcher
// uses to tell client / project / deliverable apart.
//
//   node build-lexicon.js
//   node build-lexicon.js ./data/projects.json ./data/deliverables.json ./data/clients.json
//
// Inputs are Compass "Export Collection" JSON files.
//
// The running listener now rebuilds this itself from the live database
// (see mongoStore.refreshLexicon), so this is only needed to refresh the
// fallback file lexicon.json that the listener starts from.
//
// What it learns:
//   - which words are rare (strong evidence) and which are common
//     (campaign, creative, video ... weak evidence)  -> idf weights
//   - every project name and which client owns it
//   - every deliverable name and which project / client owns it
//   - old duplicate project names, mapped to the project they were
//     merged into, so old wording still resolves correctly
// ============================================================

const fs = require("fs");
const path = require("path");

const { buildLexicon } = require("./lexiconBuilder");


const projectsFile = process.argv[2] || "projects.json";
const deliverablesFile = process.argv[3] || "deliverables.json";
const clientsFile = process.argv[4] || "clients.json";
const outFile = process.argv[5] || "lexicon.json";


const readJson = (file) =>
    JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));


const lexicon = buildLexicon(
    readJson(projectsFile),
    readJson(deliverablesFile),
    readJson(clientsFile),
    { includeAltNames: process.env.INCLUDE_ALT_NAMES === "1" }
);

const idf = lexicon.idf;

fs.writeFileSync(outFile, JSON.stringify(lexicon));

console.log("Lexicon written to", outFile);
console.log(lexicon.stats);

const common = Object.entries(idf)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 15)
    .map(([t, v]) => `${t} (${v})`);

console.log("Weakest evidence words:", common.join(", "));
