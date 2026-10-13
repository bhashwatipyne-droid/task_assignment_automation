// ============================================================
// LEXICON BUILDER
// ============================================================
//
// Turns the PMT projects, deliverables and clients into the lexicon the
// matcher scores against. Pure: arrays in, lexicon object out. Used by
//   - build-lexicon.js        (from Compass export files, writes lexicon.json)
//   - mongoStore.refreshLexicon (straight from the live database, so the
//                                matcher is never working from old data)
// ============================================================

const {
    aliasPhrasesFor,
    toTokens
} = require("./textUtils");


function buildLexicon(projects, deliverables, clients, options = {}) {

    const clientById = new Map(clients.map(c => [c.id, c]));

    const phrasesByClient = new Map(
        clients.map(c => [c.id, aliasPhrasesFor(c.name)])
    );


    // ------------------------------------------------------------
    // Which projects are live?  (not hidden, not a merged duplicate)
    // ------------------------------------------------------------

    const live = projects.filter(p => !p.hidden && !p.duplicate_of);
    const liveById = new Map(live.map(p => [p.id, p]));

    // merged duplicate -> canonical project id
    const canonicalOf = new Map();

    for (const p of projects) {

        if (p.duplicate_of && liveById.has(p.duplicate_of)) {
            canonicalOf.set(p.id, p.duplicate_of);
        }

    }


    function tokensFor(name, clientId) {
        return toTokens(name, phrasesByClient.get(clientId) || []);
    }


    const stamp = (p) =>
        Date.parse(p.updated_at || p.created_at || "") || 0;


    // ------------------------------------------------------------
    // Project entities
    // ------------------------------------------------------------

    const projectEntities = [];

    for (const p of live) {

        const toks = tokensFor(p.name, p.client_id);

        if (toks.length === 0) continue;

        projectEntities.push({
            id: p.id,
            name: p.name,
            client_id: p.client_id || null,
            toks: toks,
            upd: stamp(p),
            status: p.status || "",
            alt: false
        });

    }

    // Old merged-duplicate project names are NOT added as extra project names:
    // when small projects were collapsed into a big one, hundreds of unrelated
    // names piled onto it and drowned real matches. Their deliverables are
    // still attached to the surviving project (see below), so old wording
    // still resolves through the deliverable name.
    // Set INCLUDE_ALT_NAMES=1 to add them anyway.
    if (options.includeAltNames === true) {

        const seenProjectNames = new Set(
            projectEntities.map(e => e.id + "|" + e.toks.join(" "))
        );

        for (const p of projects) {

            const target = canonicalOf.get(p.id);

            if (!target) continue;

            const canon = liveById.get(target);

            const toks = tokensFor(p.name, canon.client_id);

            const key = target + "|" + toks.join(" ");

            if (toks.length === 0 || seenProjectNames.has(key)) continue;

            seenProjectNames.add(key);

            projectEntities.push({
                id: target,
                name: canon.name,
                client_id: canon.client_id || null,
                toks: toks,
                upd: stamp(canon),
                status: canon.status || "",
                alt: true
            });

        }

    }


    // ------------------------------------------------------------
    // Deliverable entities
    // ------------------------------------------------------------

    const deliverableEntities = [];
    const seenDeliverables = new Set();

    for (const d of deliverables) {

        const projectId =
            liveById.has(d.project_id)
                ? d.project_id
                : canonicalOf.get(d.project_id);

        if (!projectId) continue;

        const project = liveById.get(projectId);

        const name = (d.name || "").trim();

        if (!name) continue;

        const toks = tokensFor(name, project.client_id);

        if (toks.length === 0) continue;

        const key = projectId + "|" + toks.join(" ");

        if (seenDeliverables.has(key)) continue;

        seenDeliverables.add(key);

        deliverableEntities.push({
            id: d.id,
            name: name,
            project_id: projectId,
            client_id: project.client_id || null,
            toks: toks,
            upd: Date.parse(d.updated_at || d.created_at || "") || 0
        });

    }


    // ------------------------------------------------------------
    // IDF weights  (documents = every project + deliverable name)
    // ------------------------------------------------------------

    const df = new Map();

    const countDoc = (toks) => {

        for (const t of new Set(toks)) {
            df.set(t, (df.get(t) || 0) + 1);
        }

    };

    projectEntities.filter(e => !e.alt).forEach(e => countDoc(e.toks));
    deliverableEntities.forEach(e => countDoc(e.toks));

    const N =
        projectEntities.filter(e => !e.alt).length +
        deliverableEntities.length;

    const idf = {};

    for (const [token, count] of df) {
        idf[token] = Number(Math.log(1 + N / count).toFixed(3));
    }


    // ------------------------------------------------------------
    // Write
    // ------------------------------------------------------------

    const lexicon = {

        built_at: new Date().toISOString(),

        stats: {
            clients: clients.length,
            live_projects: projectEntities.filter(e => !e.alt).length,
            alternative_project_names: projectEntities.filter(e => e.alt).length,
            deliverables: deliverableEntities.length,
            vocabulary: Object.keys(idf).length
        },

        clients: clients,

        idf: idf,

        projects: projectEntities,

        deliverables: deliverableEntities

    };

    return lexicon;

}


module.exports = { buildLexicon };
