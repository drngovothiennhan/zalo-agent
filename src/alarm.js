// "Put it on my phone": a reminder/alarm becomes a one-tap calendar event with an alert at the exact time.
// Zalo bots cannot control the phone's Clock app, so the bot sends a link to a small page with:
//   - .ics file (iPhone Calendar, Samsung/Google Calendar on Android) with an alert at the event time
//   - Google Calendar "add event" link
//   - Android Clock "set alarm" intent (works when opened in Chrome on Android; some phones block it)
// GET /alarm?t=<epoch ms>&r=<none|daily|weekly>&m=<text>      -> HTML page
// GET /alarm.ics?t=...&r=...&m=...                             -> calendar file
import { localParts, formatLocal } from "./time.js";

const pad = (n) => String(n).padStart(2, "0");
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261010T000000Z
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const RRULE = { daily: "RRULE:FREQ=DAILY", weekly: "RRULE:FREQ=WEEKLY" };

export function alarmLink(origin, { due, repeat = "none", task }) {
  const q = new URLSearchParams({ t: String(due), r: repeat || "none", m: String(task || "Báo thức").slice(0, 120) });
  return `${origin}/alarm?${q}`;
}

function params(url) {
  const t = Number(url.searchParams.get("t"));
  if (!Number.isFinite(t) || t < 1e12 || t > 4e12) return null;
  const r = ["daily", "weekly"].includes(url.searchParams.get("r")) ? url.searchParams.get("r") : "none";
  const m = (url.searchParams.get("m") || "Báo thức").slice(0, 120);
  return { t, r, m };
}

function ics({ t, r, m }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zalo family bot//VI",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${t}-${encodeURIComponent(m).slice(0, 40)}@zalobot`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    `DTSTART:${utcStamp(t)}`,
    `DTEND:${utcStamp(t + 10 * 60 * 1000)}`,
    `SUMMARY:⏰ ${icsText(m)}`,
    ...(RRULE[r] ? [RRULE[r]] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(m)}`,
    "TRIGGER:PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

function page(url, p) {
  const q = url.search;
  const lp = localParts(p.t);
  const gcal = new URL("https://calendar.google.com/calendar/render");
  gcal.searchParams.set("action", "TEMPLATE");
  gcal.searchParams.set("text", `⏰ ${p.m}`);
  gcal.searchParams.set("dates", `${utcStamp(p.t)}/${utcStamp(p.t + 10 * 60 * 1000)}`);
  if (RRULE[p.r]) gcal.searchParams.set("recur", RRULE[p.r]);
  const intent =
    `intent:#Intent;action=android.intent.action.SET_ALARM;` +
    `i.android.intent.extra.alarm.HOUR=${lp.h};i.android.intent.extra.alarm.MINUTES=${lp.mi};` +
    `S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(p.m)};end`;
  const repeat = p.r === "daily" ? " (lặp lại mỗi ngày)" : p.r === "weekly" ? " (lặp lại mỗi tuần)" : p.r === "weekdays" ? " (thứ 2 đến thứ 6)" : "";
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đặt báo thức</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f6fb;color:#1c2333}
main{max-width:460px;margin:0 auto;padding:24px 16px}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 4px}.time{font-size:34px;font-weight:700;margin:8px 0}.task{font-size:17px;margin:0 0 16px}
a.btn{display:block;text-align:center;text-decoration:none;padding:14px;border-radius:12px;margin:10px 0;font-weight:600;font-size:16px}
.p{background:#0068ff;color:#fff}.s{background:#e8f0ff;color:#0047b3}.t{background:#f1f3f6;color:#333}
p.note{font-size:13px;color:#5b6475;line-height:1.5}
</style></head><body><main><div class="card">
<h1>⏰ Báo thức trên điện thoại</h1>
<div class="time">${pad(lp.h)}:${pad(lp.mi)}</div>
<p class="task">${esc(p.m)}<br><small>${esc(formatLocal(p.t))}${repeat}</small></p>
<a class="btn p" href="/alarm.ics${esc(q)}">📅 Thêm vào Lịch điện thoại (có chuông báo)</a>
<a class="btn s" href="${esc(gcal.toString())}" target="_blank" rel="noopener">Thêm vào Google Lịch</a>
<a class="btn t" href="${esc(intent)}">Mở Đồng hồ để đặt báo thức (Android)</a>
<p class="note">• iPhone: bấm nút xanh → "Thêm tất cả".<br>
• Android: bấm nút xanh rồi mở file bằng Lịch (Google Lịch/Samsung Lịch). Nút "Đồng hồ" chỉ chạy khi mở trang bằng Chrome, một số máy không cho phép.<br>
• Đang xem trong Zalo mà nút không chạy: bấm ⋮ góc trên → "Mở bằng trình duyệt".<br>
• Bot vẫn nhắn nhắc trên Zalo đúng giờ.</p>
</div></main></body></html>`;
}

export function handleAlarm(url) {
  const p = params(url);
  if (!p) return new Response("Link báo thức không hợp lệ.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (url.pathname === "/alarm.ics") {
    return new Response(ics(p), {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'inline; filename="bao-thuc.ics"' },
    });
  }
  return new Response(page(url, p), { headers: { "content-type": "text/html; charset=utf-8" } });
}
