// Next time a repeating reminder should fire. Pure: no imports, testable with node.
// Times are Vietnam time (UTC+7, no daylight saving), so weekdays are counted on the shifted clock.

const DAY = 24 * 60 * 60 * 1000;
const VN_OFFSET = 7 * 60 * 60 * 1000;

export const REPEAT_KINDS = ["none", "daily", "weekly", "weekdays"];

// Monday to Friday in Vietnam time
export function isWeekday(ms) {
  const dow = new Date(ms + VN_OFFSET).getUTCDay(); // 0 = Sunday
  return dow >= 1 && dow <= 5;
}

// Returns the next due time after `now`, or null for a one-off reminder.
export function nextOccurrence(dueAt, now, repeat) {
  if (repeat === "daily") return stepUntil(dueAt, now, DAY);
  if (repeat === "weekly") return stepUntil(dueAt, now, 7 * DAY);
  if (repeat === "weekdays") {
    let next = dueAt;
    // Skip the reminder time past now, and skip Saturday and Sunday
    for (let guard = 0; guard < 14 && (next <= now || !isWeekday(next)); guard++) next += DAY;
    return next;
  }
  return null;
}

function stepUntil(dueAt, now, step) {
  let next = dueAt;
  while (next <= now) next += step;
  return next;
}
