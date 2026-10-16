"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractMessageText } = require("../messageText");

test("plain, extended and caption messages", () => {
    assert.equal(extractMessageText({ conversation: "hi" }), "hi");
    assert.equal(extractMessageText({ extendedTextMessage: { text: "ext" } }), "ext");
    assert.equal(extractMessageText({ imageMessage: { caption: "img" } }), "img");
    assert.equal(extractMessageText({ videoMessage: { caption: "vid" } }), "vid");
    assert.equal(extractMessageText({ documentMessage: { caption: "doc" } }), "doc");
});

test("disappearing, view-once and document-with-caption wrappers are opened", () => {
    assert.equal(extractMessageText({ ephemeralMessage: { message: { conversation: "eph" } } }), "eph");
    assert.equal(extractMessageText({ viewOnceMessage: { message: { imageMessage: { caption: "once" } } } }), "once");
    assert.equal(extractMessageText({ documentWithCaptionMessage: { message: { documentMessage: { caption: "wrapped" } } } }), "wrapped");
    assert.equal(extractMessageText({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { conversation: "deep" } } } } }), "deep");
});

test("something without text gives an empty string", () => {
    assert.equal(extractMessageText({ stickerMessage: {} }), "");
    assert.equal(extractMessageText(null), "");
});
