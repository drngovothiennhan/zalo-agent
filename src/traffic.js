// Traffic watch: when to check, how to read the speed, and what to say. Pure: no imports, testable with node.
//
// Check times (Vietnam time): 06:30, 07:00, 07:30 and 16:00, 17:00, 18:00, 19:00.
// Reading: TomTom gives the current and free-flow speed on a road; the ratio says how jammed it is.

export const SLOTS = [390, 420, 450, 960, 1020, 1080, 1140];
const WINDOW_MIN = 4; // the cron runs every minute; a slot is caught within this many minutes

// The slot due at this clock time (minutes since midnight), or null
export function dueSlot(minutes) {
  return SLOTS.find((s) => minutes >= s && minutes < s + WINDOW_MIN) ?? null;
}

export function slotLabel(slot) {
  const h = Math.floor(slot / 60);
  const m = slot % 60;
  return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;
}

// ratio = currentSpeed / freeFlowSpeed
export function congestion(current, free) {
  const c = Number(current);
  const f = Number(free);
  if (!(f > 0) || !(c >= 0)) return null;
  const ratio = c / f;
  if (ratio < 0.5) return { level: "kẹt nặng", ratio };
  if (ratio < 0.75) return { level: "đông", ratio };
  return { level: "thông thoáng", ratio };
}

// rows: [{name, level, speed}] from the latest check. Returns null when nothing is congested (no message).
export function trafficMessage(slot, rows) {
  const bad = rows.filter((r) => r.level === "kẹt nặng" || r.level === "đông");
  if (!bad.length) return null;
  const lines = bad
    .sort((a, b) => a.speed - b.speed)
    .map((r) => `- ${r.name}: ${r.level} (khoảng ${Math.round(r.speed)} km/h)`);
  return `🚗 Kẹt xe lúc ${slotLabel(slot)}:\n${lines.join("\n")}\nCả nhà cân nhắc đi đường khác hoặc đi sớm.`;
}
