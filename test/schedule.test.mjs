// Run with: node --test test/schedule.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrence, isWeekday } from "../src/schedule.js";

// Vietnam time helper: ms for a local date-time (UTC+7)
const vn = (iso) => Date.parse(iso + "+07:00");

test("weekday check uses Vietnam time", () => {
  assert.equal(isWeekday(vn("2026-10-12T09:00")), true); // Monday
  assert.equal(isWeekday(vn("2026-10-16T09:00")), true); // Friday
  assert.equal(isWeekday(vn("2026-10-17T09:00")), false); // Saturday
  assert.equal(isWeekday(vn("2026-10-18T09:00")), false); // Sunday
});

test("weekdays: Friday 9:00 reminder moves to Monday 9:00", () => {
  const due = vn("2026-10-16T09:00");
  assert.equal(nextOccurrence(due, due + 1, "weekdays"), vn("2026-10-19T09:00"));
});

test("weekdays: Monday 9:00 reminder moves to Tuesday 9:00", () => {
  const due = vn("2026-10-12T09:00");
  assert.equal(nextOccurrence(due, due + 1, "weekdays"), vn("2026-10-13T09:00"));
});

test("weekdays: a Saturday start lands on Monday", () => {
  const due = vn("2026-10-17T09:00");
  assert.equal(nextOccurrence(due, due - 1, "weekdays"), vn("2026-10-19T09:00"));
});

test("daily and weekly keep their old behaviour", () => {
  const due = vn("2026-10-12T09:00");
  assert.equal(nextOccurrence(due, due + 1, "daily"), vn("2026-10-13T09:00"));
  assert.equal(nextOccurrence(due, due + 1, "weekly"), vn("2026-10-19T09:00"));
});

test("one-off reminders have no next time", () => {
  assert.equal(nextOccurrence(vn("2026-10-12T09:00"), 0, "none"), null);
});
