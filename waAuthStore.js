// WhatsApp (Baileys) login state kept in MongoDB instead of ./auth_info.
//
// Render's filesystem is wiped on every deploy and restart, so a file-based
// session meant a new QR scan each time. Same layout as Baileys'
// useMultiFileAuthState: one document per file, `_id` = "<session>:<file>".
"use strict";

const COLLECTION = "wa_auth";

let baileys = null;
const lib = () => (baileys = baileys || require("@whiskeysockets/baileys"));

const fix = (file) => file.replace(/\//g, "__").replace(/:/g, "-");

async function useMongoAuthState(db, sessionId = "default") {

    const { BufferJSON, initAuthCreds, proto } = lib();
    const col = db.collection(COLLECTION);
    const id = (file) => `${sessionId}:${fix(file)}`;

    const writeData = (data, file) =>
        col.updateOne(
            { _id: id(file) },
            { $set: { session: sessionId, data: JSON.stringify(data, BufferJSON.replacer), updated_at: new Date().toISOString() } },
            { upsert: true }
        );

    const readData = async (file) => {
        const row = await col.findOne({ _id: id(file) });
        return row ? JSON.parse(row.data, BufferJSON.reviver) : null;
    };

    const removeData = (file) => col.deleteOne({ _id: id(file) });

    const creds = (await readData("creds.json")) || initAuthCreds();

    return {

        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const out = {};
                    await Promise.all(ids.map(async (key) => {
                        let value = await readData(`${type}-${key}.json`);
                        if (type === "app-state-sync-key" && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        out[key] = value;
                    }));
                    return out;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const key in data[category]) {
                            const value = data[category][key];
                            const file = `${category}-${key}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },

        saveCreds: () => writeData(creds, "creds.json"),

        // after a WhatsApp logout: forget the dead session so a fresh QR appears
        clear: () => col.deleteMany({ session: sessionId }),

        hasSession: !!(await col.findOne({ _id: id("creds.json") }))

    };

}

module.exports = { useMongoAuthState, COLLECTION };
