// Run with: node --test test/claude.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeRequestBody, claudeText, CLAUDE_DEFAULT_MODEL } from "../src/claude.js";

test("system messages go to the top-level system field", () => {
  const body = claudeRequestBody([
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(body.system, "A\n\nB");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("default model and max_tokens, no temperature sent", () => {
  const body = claudeRequestBody([{ role: "user", content: "x" }]);
  assert.equal(body.model, CLAUDE_DEFAULT_MODEL);
  assert.equal(body.max_tokens, 600);
  assert.equal("temperature" in body, false);
});

test("consecutive same-role turns are merged and the first turn is user", () => {
  const body = claudeRequestBody([
    { role: "assistant", content: "earlier" },
    { role: "user", content: "one" },
    { role: "user", content: "two" },
  ]);
  assert.deepEqual(body.messages, [
    { role: "user", content: "Hãy trả lời theo ngữ cảnh trên." },
    { role: "assistant", content: "earlier" },
    { role: "user", content: "one\n\ntwo" },
  ]);
});

test("empty content is skipped and a lone system prompt still yields a user turn", () => {
  const body = claudeRequestBody([{ role: "system", content: "S" }, { role: "user", content: "" }]);
  assert.equal(body.system, "S");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

test("claudeText keeps only text blocks", () => {
  const text = claudeText({
    content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Xin " },
      { type: "text", text: "chào " },
    ],
  });
  assert.equal(text, "Xin chào");
});

test("claudeText tolerates missing content", () => {
  assert.equal(claudeText({}), "");
  assert.equal(claudeText(undefined), "");
});
