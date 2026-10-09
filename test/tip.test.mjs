// Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDailyTip } from "../src/tip.js";

test("empty or KHÔNG means nothing to add", () => {
  assert.equal(formatDailyTip(""), "");
  assert.equal(formatDailyTip(undefined), "");
  assert.equal(formatDailyTip("KHÔNG"), "");
  assert.equal(formatDailyTip("KHÔNG."), "");
});

test("bullets are normalised to '- ' and capped at three", () => {
  const out = formatDailyTip("• Mang áo mưa\n* Ngày giỗ ông nội ngày mai\n- Đã có lịch nhắc đóng tiền\n- Thêm dòng thứ tư");
  assert.equal(
    out,
    "💡 Gợi ý hôm nay:\n- Mang áo mưa\n- Ngày giỗ ông nội ngày mai\n- Đã có lịch nhắc đóng tiền"
  );
});

test("plain lines without markers still become bullets", () => {
  assert.equal(formatDailyTip("Nhớ mua trứng"), "💡 Gợi ý hôm nay:\n- Nhớ mua trứng");
});

test("blank-only output is treated as nothing to say", () => {
  assert.equal(formatDailyTip("   \n  \n"), "");
});
