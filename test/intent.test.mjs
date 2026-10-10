// Run with: node --test test/intent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripLeadIn, pointsToMissingMedia, LOCATION_BLOCKED } from "../src/intent.js";

test("lead-ins are removed so the command comes first", () => {
  assert.equal(stripLeadIn("hãy ghi nhớ - Nhân 27/11"), "ghi nhớ - Nhân 27/11");
  assert.equal(stripLeadIn("Làm ơn nhắc tôi lúc 5h"), "nhắc tôi lúc 5h");
  assert.equal(stripLeadIn("ghi nhớ: bé An"), "ghi nhớ: bé An");
});

test("pointing at a picture that is not attached is detected", () => {
  assert.equal(pointsToMissingMedia("hãy nhắc tôi lịch thi trong hình này"), true);
  assert.equal(pointsToMissingMedia("đọc giúp ảnh trên"), true);
  assert.equal(pointsToMissingMedia("nhắc tôi đóng tiền lúc 5h"), false);
});

test("Gemini location errors are recognised as provider-blocked", () => {
  assert.equal(LOCATION_BLOCKED.test("400 (gemini-flash-lite-latest): User location is not supported for the API use."), true);
  assert.equal(LOCATION_BLOCKED.test("429 quota exceeded"), false);
});
