// Tiny in-memory stand-in for the parts of the MongoDB driver that
// mongoStore.js uses. No network, no mongod binary.
"use strict";

function get(doc, key) {
    return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

function matches(doc, filter) {
    return Object.entries(filter || {}).every(([key, cond]) => {
        const v = get(doc, key);
        if (cond && typeof cond === "object" && !Array.isArray(cond)) {
            return Object.entries(cond).every(([op, arg]) => {
                if (op === "$in") return arg.includes(v);
                if (op === "$ne") return v !== arg;
                if (op === "$exists") return (v !== undefined) === arg;
                throw new Error("fakeDb: unsupported operator " + op);
            });
        }
        return v === cond;
    });
}

class Collection {
    constructor(name, db) { this.name = name; this.db = db; this.docs = []; this.indexes = []; }

    _guard() { if (this.db.failWrites) throw new Error("simulated Mongo outage"); }

    find(filter) {
        const rows = this.docs.filter(d => matches(d, filter)).map(d => structuredClone(d));
        return { toArray: async () => rows };
    }

    async findOne(filter) { return this.docs.find(d => matches(d, filter)) || null; }

    async insertMany(rows) { rows.forEach(r => this.docs.push(structuredClone(r))); }

    async createIndex(keys, opts) { this.indexes.push({ keys, ...opts }); }

    async updateOne(filter, update, opts = {}) {
        this._guard();
        let doc = this.docs.find(d => matches(d, filter));
        let upserted = 0;
        if (!doc) {
            if (!opts.upsert) return { upsertedCount: 0, modifiedCount: 0 };
            doc = {};
            Object.entries(filter).forEach(([k, v]) => { if (typeof v !== "object") doc[k] = v; });
            Object.assign(doc, structuredClone(update.$setOnInsert || {}));
            this.docs.push(doc);
            upserted = 1;
        }
        Object.assign(doc, structuredClone(update.$set || {}));
        Object.entries(update.$inc || {}).forEach(([k, n]) => { doc[k] = (doc[k] || 0) + n; });
        return { upsertedCount: upserted, modifiedCount: upserted ? 0 : 1 };
    }

    async bulkWrite(ops) {
        this._guard();
        let upsertedCount = 0;
        for (const op of ops) {
            const r = await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: !!op.updateOne.upsert });
            upsertedCount += r.upsertedCount;
        }
        return { upsertedCount };
    }
}

class FakeDb {
    constructor() { this.cols = new Map(); this.failWrites = false; }
    collection(name) {
        if (!this.cols.has(name)) this.cols.set(name, new Collection(name, this));
        return this.cols.get(name);
    }
    async command() { return { ok: 1 }; }
    all(name) { return this.collection(name).docs; }
}

module.exports = { FakeDb };
