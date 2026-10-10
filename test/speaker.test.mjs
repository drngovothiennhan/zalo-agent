// Run with: node --test test/speaker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagSpeaker, speakerName, speakerRule, UNKNOWN_SPEAKER } from "../src/speaker.js";

test("user lines are tagged with the speaker name", () => {
  assert.equal(tagSpeaker("Mẹ", "mai ăn gì?"), "Mẹ: mai ăn gì?");
  assert.equal(tagSpeaker("  Bố  ", "ok"), "Bố: ok");
});

test("no name leaves the text untouched", () => {
  assert.equal(tagSpeaker("", "chào"), "chào");
  assert.equal(tagSpeaker(undefined, "chào"), "chào");
});

test("missing name falls back to a neutral label in replies", () => {
  assert.equal(speakerName(""), UNKNOWN_SPEAKER);
  assert.equal(speakerName("Con An"), "Con An");
});

test("system rule names the current speaker", () => {
  const rule = speakerRule("Mẹ");
  assert.match(rule, /là Mẹ/);
  assert.match(rule, /nhiều thành viên/);
});
