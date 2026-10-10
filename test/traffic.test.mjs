// Run with: node --test test/traffic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, slotLabel, congestion, trafficMessage } from "../src/traffic.js";

test("check slots are caught within the window", () => {
  assert.equal(dueSlot(390), 390); // 06:30
  assert.equal(dueSlot(393), 390);
  assert.equal(dueSlot(396), null); // window closed
  assert.equal(dueSlot(960), 960); // 16:00
  assert.equal(dueSlot(1140), 1140); // 19:00
  assert.equal(dueSlot(12 * 60), null); // noon: no check
});

test("slot labels", () => {
  assert.equal(slotLabel(390), "06h30");
  assert.equal(slotLabel(1140), "19h00");
});

test("congestion levels from speed ratio", () => {
  assert.equal(congestion(20, 60).level, "kẹt nặng");
  assert.equal(congestion(40, 60).level, "đông");
  assert.equal(congestion(55, 60).level, "thông thoáng");
  assert.equal(congestion(10, 0), null); // no free-flow speed: unknown
});

test("message lists only congested roads, slowest first", () => {
  const msg = trafficMessage(960, [
    { name: "Võ Văn Ngân", level: "đông", speed: 30 },
    { name: "Tam Hà", level: "thông thoáng", speed: 50 },
    { name: "Phạm Văn Đồng", level: "kẹt nặng", speed: 8 },
  ]);
  assert.match(msg, /lúc 16h00/);
  assert.ok(msg.indexOf("Phạm Văn Đồng") < msg.indexOf("Võ Văn Ngân"));
  assert.equal(msg.includes("Tam Hà"), false);
});

test("no congestion means no message", () => {
  assert.equal(trafficMessage(960, [{ name: "Tam Hà", level: "thông thoáng", speed: 50 }]), null);
});
