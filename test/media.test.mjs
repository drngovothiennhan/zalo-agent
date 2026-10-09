// Run with: node --test test/media.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMedia, geminiImageBody, lyriaBody, openaiImageBody, GEMINI_IMAGE_DEFAULT, OPENAI_IMAGE_DEFAULT } from "../src/media.js";

test("request bodies have the documented shape", () => {
  assert.deepEqual(geminiImageBody("con mèo"), { model: GEMINI_IMAGE_DEFAULT, input: { type: "text", text: "con mèo" } });
  assert.deepEqual(lyriaBody("ru con"), { contents: [{ role: "user", parts: [{ text: "ru con" }] }] });
  assert.equal(openaiImageBody("x").model, OPENAI_IMAGE_DEFAULT);
  assert.equal(openaiImageBody("x", "other").model, "other");
});

test("finds an image in an Interactions-style response", () => {
  const r = findMedia({ steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }, { type: "image", data: "QUJD", mime_type: "image/png" }] }] }, "image");
  assert.deepEqual(r, { mime: "image/png", b64: "QUJD" });
});

test("finds an image in a generateContent-style response (inlineData)", () => {
  const r = findMedia({ candidates: [{ content: { parts: [{ text: "x" }, { inlineData: { mimeType: "image/jpeg", data: "WFla" } }] } }] }, "image");
  assert.deepEqual(r, { mime: "image/jpeg", b64: "WFla" });
});

test("finds audio, not image, in a song response", () => {
  const data = { candidates: [{ content: { parts: [{ text: "lời" }, { inlineData: { mimeType: "audio/mp3", data: "TVVT" } }] } }] };
  assert.deepEqual(findMedia(data, "audio"), { mime: "audio/mp3", b64: "TVVT" });
  assert.equal(findMedia(data, "image"), null);
});

test("finds an OpenAI b64_json image", () => {
  assert.deepEqual(findMedia({ data: [{ b64_json: "T1BFTkFJ" }] }, "image"), { mime: "image/png", b64: "T1BFTkFJ" });
});

test("nothing usable returns null", () => {
  assert.equal(findMedia({ error: "x" }, "image"), null);
  assert.equal(findMedia(null, "audio"), null);
});
