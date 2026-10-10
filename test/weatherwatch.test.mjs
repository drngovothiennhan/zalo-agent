// Run with: node --test test/weatherwatch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { vnClock, rainAdvice, afternoonMessages, morningMessage } from "../src/weatherwatch.js";

test("Vietnam clock gives minutes and day key", () => {
  // 16:00 Vietnam time = 09:00 UTC
  const c = vnClock(Date.parse("2026-10-10T09:00:00Z"));
  assert.equal(c.minutes, 16 * 60);
  assert.equal(c.day, "2026-10-10");
});

test("rain now and evening risk are detected", () => {
  const hourly = [
    { hour: 15, prob: 30, precip: 0 },
    { hour: 18, prob: 70, precip: 1.2 },
  ];
  assert.deepEqual(rainAdvice({ nowPrecip: 0.5, hourly }), { rainNow: true, eveningRain: true });
  assert.deepEqual(rainAdvice({ nowPrecip: 0, hourly: [{ hour: 18, prob: 10, precip: 0 }] }), { rainNow: false, eveningRain: false });
});

test("16:00 messages: rain now, evening caution, or nothing", () => {
  assert.equal(afternoonMessages({ rainNow: true, eveningRain: true }).length, 2);
  assert.equal(afternoonMessages({ rainNow: false, eveningRain: true })[0].includes("trời tối"), true);
  assert.deepEqual(afternoonMessages({ rainNow: false, eveningRain: false }), []);
});

test("morning message mentions rain chance only when it matters", () => {
  assert.match(morningMessage({ tempMin: 26, tempMax: 33, rainChance: 80, rainNow: false }), /80%/);
  assert.match(morningMessage({ tempMin: 26, tempMax: 33, rainChance: 10, rainNow: false }), /ít khả năng mưa/);
});
