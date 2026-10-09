// Run with: node --test test/router.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordRoute, needsClassifier, parseClassification } from "../src/router.js";

test("clear requests route by keyword", () => {
  assert.equal(keywordRoute("lập bảng tính theo dõi cân nặng"), "excel");
  assert.equal(keywordRoute("soạn công văn mời họp"), "word");
  assert.equal(keywordRoute("vẽ con mèo đội mũ"), "image");
});

test("questions about pictures or documents are not tasks", () => {
  assert.equal(keywordRoute("vẽ là gì vậy"), null);
  assert.equal(keywordRoute("công văn 123 nói về cái gì"), null);
  assert.equal(needsClassifier("bức tranh này nói về cái gì"), false);
});

test("unclear task wording goes to the classifier", () => {
  assert.equal(needsClassifier("làm giúp tôi cái gì đó cho đám trẻ"), true);
  assert.equal(needsClassifier("hôm nay trời đẹp quá"), false);
});

test("classifier answer is parsed defensively", () => {
  assert.equal(parseClassification('Đây là kết quả: {"tool":"image"}'), "image");
  assert.equal(parseClassification('{"tool": "excel"}'), "excel");
  assert.equal(parseClassification('{"tool":"music"}'), null);
  assert.equal(parseClassification("không biết"), null);
});
