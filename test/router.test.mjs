// Run with: node --test test/router.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordRoute, needsClassifier, providerHint, parseClassification, planTool } from "../src/router.js";

const ALL = { gemini: true, openai: true, claude: true };
const NONE = { gemini: false, openai: false, claude: false };

test("clear requests route by keyword", () => {
  assert.equal(keywordRoute("tạo bài hát về mẹ cho bé"), "music");
  assert.equal(keywordRoute("làm nhạc ru con ngủ"), "music");
  assert.equal(keywordRoute("lập bảng tính theo dõi cân nặng"), "excel");
  assert.equal(keywordRoute("soạn công văn mời họp"), "word");
  assert.equal(keywordRoute("vẽ con mèo đội mũ"), "image");
});

test("a plain question about music or pictures is not a task", () => {
  assert.equal(keywordRoute("nghe nhạc gì hay vậy"), null);
  assert.equal(keywordRoute("bức tranh này nói về cái gì"), null);
  assert.equal(needsClassifier("nhạc này có hay không"), false);
});

test("unclear task wording goes to the classifier", () => {
  assert.equal(needsClassifier("làm giúp tôi cái gì đó cho đám trẻ"), true);
  assert.equal(needsClassifier("hôm nay trời đẹp quá"), false);
});

test("provider hints", () => {
  assert.equal(providerHint("vẽ bằng ChatGPT đi"), "openai");
  assert.equal(providerHint("vẽ bằng gemini"), "gemini");
  assert.equal(providerHint("vẽ đẹp hơn chút"), "premium");
  assert.equal(providerHint("vẽ con mèo"), null);
});

test("classifier answer is parsed defensively", () => {
  assert.equal(parseClassification('Đây là kết quả: {"tool":"image"}'), "image");
  assert.equal(parseClassification('{"tool":"video"}'), null);
  assert.equal(parseClassification("không biết"), null);
  assert.equal(parseClassification('{"tool": "excel"}'), "excel");
});

test("images: free by default, paid only when asked and available", () => {
  assert.equal(planTool({ tool: "image", hint: null, available: ALL }).provider, "free");
  assert.equal(planTool({ tool: "image", hint: "premium", available: ALL }).provider, "gemini");
  assert.equal(planTool({ tool: "image", hint: "openai", available: ALL }).provider, "openai");
});

test("asked-for provider without a key falls back to free with a note", () => {
  const p = planTool({ tool: "image", hint: "gemini", available: NONE });
  assert.equal(p.provider, "free");
  assert.match(p.note, /miễn phí/);
});

test("music needs Gemini and refuses ChatGPT or Claude", () => {
  assert.equal(planTool({ tool: "music", hint: null, available: ALL }).provider, "lyria");
  assert.equal(planTool({ tool: "music", hint: null, available: NONE }).unavailable, true);
  assert.equal(planTool({ tool: "music", hint: "openai", available: ALL }).unavailable, true);
});

test("Word and Excel use the smart text chain; chat stays plain", () => {
  assert.equal(planTool({ tool: "word", hint: null, available: NONE }).provider, "smart");
  assert.equal(planTool({ tool: "excel", hint: null, available: NONE }).provider, "smart");
  assert.equal(planTool({ tool: "chat", hint: null, available: ALL }).provider, null);
});
