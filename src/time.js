// Vietnam time helpers (UTC+7, no daylight saving)
const OFFSET_MS = 7 * 60 * 60 * 1000;
const WEEKDAYS = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];

const pad = (n) => String(n).padStart(2, "0");

// Parts of a UTC epoch (ms) expressed in Vietnam local time
export function localParts(ms) {
  const d = new Date(ms + OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    wd: d.getUTCDay(),
  };
}

export function nowDescription(ms = Date.now()) {
  const p = localParts(ms);
  return `${WEEKDAYS[p.wd]}, ngày ${pad(p.d)}/${pad(p.mo)}/${p.y}, ${pad(p.h)}:${pad(p.mi)} (giờ Việt Nam)`;
}

// "YYYY-MM-DD HH:mm" in Vietnam time -> UTC epoch ms (or null)
export function parseLocal(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(str || "").trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi) - OFFSET_MS;
}

export function formatLocal(ms) {
  const p = localParts(ms);
  return `${pad(p.h)}:${pad(p.mi)} ${WEEKDAYS[p.wd].toLowerCase()} ${pad(p.d)}/${pad(p.mo)}/${p.y}`;
}
