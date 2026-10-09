// Household helpers shared by the whole family (all bots, all chats):
//   - shopping list ("mua: trứng, sữa" · "đi chợ" · "đã mua trứng")
//   - spending book ("chi 50k rau" · "thu 10tr lương" · "chi tiêu tháng này" · "xuất chi tiêu")
//   - special dates, lunar or solar ("giỗ ông nội 15/7" · "sinh nhật bé An 20/11" · "ngày đặc biệt")
//   - morning brief per chat ("bật bản tin sáng 6h30" · "bản tin")
import { sendText } from "./zalo.js";
import { localParts, formatLocal } from "./time.js";
import { solarToLunar, lunarAnniversary, jdFromDate, yearName } from "./lunar.js";
import { weather, storeFile } from "./tools.js";
import { fetchHeadlines } from "./live.js";
import { botById, botEnv } from "./bots.js";
import { dayInfo, dayShort } from "./fortune.js";
import { complete } from "./brain.js";
import { DAILY_TIP_PROMPT, formatDailyTip } from "./tip.js";

const DAY = 24 * 60 * 60 * 1000;
const OFFSET = 7 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

export const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// ---------- tables (created on first use; also in schema.sql) ----------
let ready = false;
export async function ensureTables(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS shopping (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL, done_at INTEGER)"),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'chi', amount INTEGER NOT NULL, note TEXT, category TEXT, author TEXT, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS special_days (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, day INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER, lunar INTEGER NOT NULL DEFAULT 0, chat_id TEXT, bot TEXT NOT NULL DEFAULT 'main', author TEXT, created_at INTEGER NOT NULL)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS brief_subs (chat_id TEXT NOT NULL, bot TEXT NOT NULL DEFAULT 'main', hour INTEGER NOT NULL DEFAULT 6, minute INTEGER NOT NULL DEFAULT 0, last_sent TEXT, PRIMARY KEY (chat_id, bot))"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)"),
  ]);
  ready = true;
}

// Vietnam "today" as parts + key
function today(ms = Date.now()) {
  const p = localParts(ms);
  return { ...p, key: `${p.y}-${pad(p.mo)}-${pad(p.d)}` };
}
const daysBetween = (a, b) => jdFromDate(b[0], b[1], b[2]) - jdFromDate(a[0], a[1], a[2]);

// ---------- shopping ----------
function splitItems(s) {
  return String(s || "")
    .split(/[,;\n]| và | va |\+/)
    .map((x) => x.replace(/^[-•*\s]+/, "").trim())
    .filter((x) => x && x.length <= 80);
}

async function shoppingList(env) {
  const { results } = await env.DB.prepare("SELECT id, item, added_by FROM shopping WHERE done_at IS NULL ORDER BY id").all();
  return results;
}

function shoppingText(list) {
  if (!list.length) return 'Danh sách đi chợ đang trống. Thêm: "mua: trứng, sữa, rau muống".';
  return `🛒 Cần mua (${list.length}):\n${list.map((r, i) => `${i + 1}. ${r.item}`).join("\n")}\n\nMua xong: "đã mua trứng" · "đã mua 1, 3" · "đã mua hết"`;
}

// ---------- money ----------
// "50k" "50 nghìn" "1tr2" "1,5tr" "200.000" "2 triệu"; a bare number under 1000 means thousands ("chi 150 rau")
export function parseAmount(s) {
  const m = /^(\d+(?:[.,]\d+)*)\s*(k|nghìn|nghin|ngàn|ngan|n|tr|triệu|trieu|củ|cu|m|đ|d|vnd|đồng|dong)?(\d{1,3})?(?![\p{L}\d])/iu.exec(String(s || "").trim());
  if (!m) return null;
  const raw = m[1];
  const unit = (m[2] || "").toLowerCase();
  let value;
  if (/^(tr|triệu|trieu|củ|cu|m)$/.test(unit)) {
    value = parseFloat(raw.replace(",", ".")) * 1e6;
    if (m[3]) value += parseInt(m[3].padEnd(3, "0"), 10) * 1000; // 1tr2 = 1,200,000
  } else if (/^(k|nghìn|nghin|ngàn|ngan|n)$/.test(unit)) {
    value = parseFloat(raw.replace(",", ".")) * 1000;
  } else {
    const digits = raw.replace(/[.,]/g, "");
    value = parseInt(digits, 10);
    if (!/[.,]/.test(raw) && value < 1000) value *= 1000;
  }
  if (!Number.isFinite(value) || value <= 0 || value > 1e11) return null;
  return { amount: Math.round(value), rest: s.slice(m[0].length).trim() };
}

export const money = (n) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

const CATEGORIES = [
  ["Ăn uống, đi chợ", /(rau|thit|ca |ca$|trung|sua|gao|cho|an |an$|com|pho|bun|banh|trai cay|hoa qua|nuoc mam|dau an|mi |do an|thuc pham|sieu thi|bach hoa|cafe|ca phe|tra sua)/],
  ["Điện, nước, internet", /(dien|nuoc|internet|wifi|mang|cap|gas|ga )/],
  ["Học tập", /(hoc phi|hoc them|sach|vo |but|dong phuc|truong|lop)/],
  ["Sức khỏe", /(thuoc|kham|benh vien|nha thuoc|vitamin|bao hiem y te|xet nghiem)/],
  ["Đi lại", /(xang|grab|taxi|gui xe|sua xe|ve xe|ve may bay)/],
  ["Nhà cửa", /(thue nha|tien nha|sua nha|do dung|noi that|giat|ve sinh)/],
  ["Hiếu hỉ, quà", /(dam cuoi|dam ma|mung|qua|sinh nhat|gio|li xi|tu thien)/],
];
const categoryOf = (note) => (CATEGORIES.find(([, re]) => re.test(norm(note) + " ")) || ["Khác"])[0];

function monthRange(y, mo) {
  const start = Date.UTC(y, mo - 1, 1) - OFFSET;
  const end = Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - OFFSET;
  return [start, end];
}

async function monthReport(env, y, mo) {
  const [start, end] = monthRange(y, mo);
  const { results } = await env.DB.prepare("SELECT id, kind, amount, note, category, author, created_at FROM expenses WHERE created_at >= ? AND created_at < ? ORDER BY id").bind(start, end).all();
  return results;
}

function reportText(rows, y, mo) {
  if (!rows.length) return `Tháng ${mo}/${y} chưa ghi khoản thu chi nào. Ghi: "chi 50k rau" hoặc "thu 10tr lương".`;
  const chi = rows.filter((r) => r.kind === "chi");
  const thu = rows.filter((r) => r.kind === "thu");
  const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
  const byCat = {};
  for (const r of chi) byCat[r.category || "Khác"] = (byCat[r.category || "Khác"] || 0) + r.amount;
  const cats = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `- ${c}: ${money(v)}`);
  const recent = rows
    .slice(-5)
    .reverse()
    .map((r) => `#${r.id} ${r.kind === "thu" ? "+" : "-"}${money(r.amount)} ${r.note || ""}`.trim());
  return (
    `💰 Thu chi tháng ${mo}/${y}:\n- Tổng chi: ${money(sum(chi))}\n- Tổng thu: ${money(sum(thu))}\n- Còn lại: ${money(sum(thu) - sum(chi))}` +
    (cats.length ? `\n\nChi theo nhóm:\n${cats.join("\n")}` : "") +
    `\n\nGần đây:\n${recent.join("\n")}\n\nGhi nhầm: "xóa chi <số>" · Xuất file: "xuất chi tiêu"`
  );
}

function reportCsv(rows) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [["Số", "Ngày", "Loại", "Số tiền", "Nội dung", "Nhóm", "Người ghi"].map(q).join(",")];
  for (const r of rows) {
    const p = localParts(r.created_at);
    lines.push([r.id, `${pad(p.d)}/${pad(p.mo)}/${p.y}`, r.kind === "thu" ? "Thu" : "Chi", r.amount, r.note, r.category, r.author].map(q).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ---------- special days ----------
const KIND_LABEL = { gio: "Giỗ", sinhnhat: "Sinh nhật", kyniem: "Kỷ niệm" };

// Next solar date [d, m, y] of an event on or after today
export function nextOccurrence(ev, now = Date.now()) {
  const t = today(now);
  const todayArr = [t.d, t.mo, t.y];
  if (ev.lunar) {
    const ly = solarToLunar(t.d, t.mo, t.y).year;
    for (const y of [ly - 1, ly, ly + 1]) {
      const s = lunarAnniversary(ev.day, ev.month, y);
      if (s && daysBetween(todayArr, s) >= 0) return s;
    }
    return null;
  }
  for (const y of [t.y, t.y + 1]) {
    let d = ev.day;
    if (ev.month === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) d = 28;
    const s = [d, ev.month, y];
    if (daysBetween(todayArr, s) >= 0) return s;
  }
  return null;
}

function eventLine(ev, now = Date.now()) {
  const t = today(now);
  const next = nextOccurrence(ev, now);
  if (!next) return `#${ev.id} ${KIND_LABEL[ev.kind] || ""} ${ev.name}`;
  const left = daysBetween([t.d, t.mo, t.y], next);
  const when = left === 0 ? "HÔM NAY" : left === 1 ? "ngày mai" : `còn ${left} ngày`;
  const date = ev.lunar ? `${ev.day}/${ev.month} âm (dương lịch ${next[0]}/${next[1]}/${next[2]})` : `${next[0]}/${next[1]}/${next[2]}`;
  let extra = "";
  if (ev.year && ev.kind === "sinhnhat") extra = ` · tròn ${(ev.lunar ? solarToLunar(...next).year : next[2]) - ev.year} tuổi`;
  if (ev.year && ev.kind === "kyniem") extra = ` · ${next[2] - ev.year} năm`;
  return `#${ev.id} ${KIND_LABEL[ev.kind] || ""} ${ev.name}: ${date} — ${when}${extra}`;
}

async function listSpecialDays(env, now = Date.now()) {
  const { results } = await env.DB.prepare("SELECT * FROM special_days").all();
  const t = today(now);
  const left = (ev) => {
    const n = nextOccurrence(ev, now);
    return n ? daysBetween([t.d, t.mo, t.y], n) : 9999;
  };
  return results.map((ev) => ({ ...ev, left: left(ev) })).sort((a, b) => a.left - b.left);
}

// "giỗ ông nội 15/7" · "thêm sinh nhật bé An 20/11/2019" · "kỷ niệm ngày cưới 10/10/2015" · "sinh nhật mẹ 3/2 âm"
const ADD_DAY_RE =
  /^(?:thêm |lưu |ghi |nhớ )?(đám giỗ|ngày giỗ|giỗ|sinh nhật|kỷ niệm)\s+(.+?)\s+(?:vào |là |ngày |vào ngày )*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{4}))?\s*(\(?\s*(?:âm lịch|âm|al)\s*\)?|\(?\s*(?:dương lịch|dương|dl)\s*\)?)?\s*\.?$/iu;

// ---------- morning brief ----------
export async function briefText(env, chatId, botId = "main", now = Date.now()) {
  await ensureTables(env);
  const t = today(now);
  const wd = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][t.wd];
  const l = solarToLunar(t.d, t.mo, t.y);
  const parts = [`☀️ Chào buổi sáng cả nhà! ${wd}, ${pad(t.d)}/${pad(t.mo)}/${t.y} — ngày ${l.day}/${l.month}${l.leap ? " (nhuận)" : ""} âm lịch, năm ${yearName(l.year)}.`];
  if (l.day === 1 || l.day === 15) parts.push(`🙏 Hôm nay là ${l.day === 1 ? "mùng 1" : "rằm"} âm lịch.`);
  try {
    parts.push(`🔮 ${dayShort(dayInfo(t.d, t.mo, t.y))}`);
  } catch {
    /* optional */
  }

  try {
    const w = (await weather(env, "")).split("\n");
    parts.push(`🌤 ${w.slice(0, 3).join("\n")}${w.find((x) => x.startsWith("Lưu ý")) ? "\n" + w.find((x) => x.startsWith("Lưu ý")) : ""}`);
  } catch {
    /* weather is optional */
  }

  try {
    const end = Date.UTC(t.y, t.mo - 1, t.d + 1) - OFFSET;
    const { results } = await env.DB.prepare("SELECT text, due_at FROM reminders WHERE chat_id = ? AND bot = ? AND due_at < ? ORDER BY due_at")
      .bind(String(chatId), botId, end)
      .all();
    if (results.length) parts.push(`⏰ Hôm nay:\n${results.map((r) => `- ${formatLocal(r.due_at).slice(0, 5)} ${r.text}`).join("\n")}`);
  } catch {
    /* reminders table may lack the bot column in old databases */
  }

  try {
    const days = (await listSpecialDays(env, now)).filter((e) => e.left <= 7);
    if (days.length) parts.push(`📅 Sắp tới:\n${days.map((e) => "- " + eventLine(e, now).replace(/^#\d+ /, "")).join("\n")}`);
  } catch {
    /* optional */
  }

  try {
    const list = await shoppingList(env);
    if (list.length) parts.push(`🛒 Cần mua: ${list.slice(0, 10).map((r) => r.item).join(", ")}${list.length > 10 ? `… (+${list.length - 10})` : ""}`);
  } catch {
    /* optional */
  }

  try {
    const rows = await monthReport(env, t.y, t.mo);
    const chi = rows.filter((r) => r.kind === "chi").reduce((s, r) => s + r.amount, 0);
    if (chi) parts.push(`💰 Đã chi tháng ${t.mo}: ${money(chi)}`);
  } catch {
    /* optional */
  }

  try {
    const news = await fetchHeadlines("https://vnexpress.net/rss/tin-noi-bat.rss", 3).catch(() => fetchHeadlines("https://vnexpress.net/rss/tin-moi-nhat.rss", 3));
    if (news.length) parts.push(`📰 Tin chính (VnExpress):\n${news.map((n) => `- ${n.title}`).join("\n")}`);
  } catch {
    /* optional */
  }

  // AI "gợi ý hôm nay", grounded only in the facts gathered above; optional, so failures are ignored
  try {
    const tip = formatDailyTip(await complete(env, DAILY_TIP_PROMPT, parts.join("\n\n"), { max_tokens: 250, temperature: 0.3 }));
    if (tip) parts.push(tip);
  } catch {
    /* no AI available: the brief still goes out without the tip */
  }

  parts.push('Chúc cả nhà một ngày vui khỏe! (Tắt: "tắt bản tin sáng")');
  return parts.join("\n\n");
}

// Cron: send briefs that are due (within 3 hours after the chosen time, once per day)
export async function runBriefs(env, now = Date.now()) {
  await ensureTables(env);
  const t = today(now);
  const minutes = t.h * 60 + t.mi;
  const { results } = await env.DB.prepare("SELECT * FROM brief_subs WHERE last_sent IS NULL OR last_sent != ?").bind(t.key).all();
  for (const s of results) {
    const at = s.hour * 60 + s.minute;
    if (minutes < at || minutes > at + 180) continue;
    await env.DB.prepare("UPDATE brief_subs SET last_sent = ? WHERE chat_id = ? AND bot = ?").bind(t.key, s.chat_id, s.bot).run();
    const benv = botEnv(env, botById(s.bot));
    if (!benv.BOT_TOKEN) continue;
    await sendText(benv, s.chat_id, await briefText(benv, s.chat_id, s.bot, now));
  }
}

// Cron: special-day alerts once a day after 07:00 — 3 days before, the day before and on the day
export async function runSpecialDayAlerts(env, now = Date.now()) {
  await ensureTables(env);
  const t = today(now);
  if (t.h < 7) return;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'specialdays:last'").first();
  if (row?.value === t.key) return;
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('specialdays:last', ?)").bind(t.key).run();
  for (const ev of await listSpecialDays(env, now)) {
    if (![0, 1, 3].includes(ev.left) || !ev.chat_id) continue;
    const benv = botEnv(env, botById(ev.bot));
    if (!benv.BOT_TOKEN) continue;
    const head = ev.left === 0 ? "📅 HÔM NAY" : ev.left === 1 ? "📅 Ngày mai" : "📅 Còn 3 ngày nữa";
    const tip = ev.kind === "gio" ? "\nNhớ chuẩn bị mâm cúng và báo bà con nhé." : ev.kind === "sinhnhat" ? "\nĐừng quên quà và lời chúc nhé! 🎂" : "";
    await sendText(benv, ev.chat_id, `${head}: ${eventLine(ev, now).replace(/^#\d+ /, "").replace(/ — (HÔM NAY|ngày mai|còn \d+ ngày)/, "")}${tip}`);
  }
}

// ---------- command router ----------
// Returns true when the message was handled.
export async function handleHousehold(env, { chatId, text, who, origin }) {
  const n = norm(text);
  const lower = String(text || "").toLowerCase().normalize("NFC").trim();
  let m;

  // ----- shopping -----
  m = /^(?:mua|can mua|them vao (?:danh sach )?(?:di cho|mua)|di cho them)\s*:\s*([\s\S]+)$/.exec(n) || /^(?:cần mua|thêm vào (?:danh sách )?(?:đi chợ|mua))\s+([\s\S]+)$/.exec(lower);
  if (m) {
    await ensureTables(env);
    const raw = /:/.test(text) ? text.slice(text.indexOf(":") + 1) : text.replace(/^(cần mua|thêm vào (danh sách )?(đi chợ|mua))\s+/i, "");
    const items = splitItems(raw);
    if (!items.length) return false;
    await env.DB.batch(items.map((it) => env.DB.prepare("INSERT INTO shopping (item, added_by, created_at) VALUES (?, ?, ?)").bind(it, who || "", Date.now())));
    await sendText(env, chatId, `Đã thêm ${items.length} món.\n\n${shoppingText(await shoppingList(env))}`);
    return true;
  }
  if (["di cho", "danh sach di cho", "danh sach mua", "can mua gi", "mua gi", "/shop", "can mua gi khong", "danh sach mua sam"].includes(n)) {
    await ensureTables(env);
    await sendText(env, chatId, shoppingText(await shoppingList(env)));
    return true;
  }
  m = /^da mua\s+(.+)$/.exec(n);
  if (m) {
    await ensureTables(env);
    const list = await shoppingList(env);
    const arg = m[1].trim();
    let picked = [];
    if (/^(het|tat ca|xong|ca)$/.test(arg)) picked = list;
    else if (/^[\d,\s]+$/.test(arg)) picked = arg.split(/[,\s]+/).map((x) => list[Number(x) - 1]).filter(Boolean);
    else {
      const wanted = splitItems(arg).map(norm);
      picked = list.filter((r) => wanted.some((w) => norm(r.item).includes(w) || w.includes(norm(r.item))));
    }
    if (!picked.length) {
      await sendText(env, chatId, `Không thấy món "${m[1]}" trong danh sách.\n\n${shoppingText(list)}`);
      return true;
    }
    await env.DB.batch(picked.map((r) => env.DB.prepare("UPDATE shopping SET done_at = ? WHERE id = ?").bind(Date.now(), r.id)));
    const left = await shoppingList(env);
    await sendText(env, chatId, `Đã gạch: ${picked.map((r) => r.item).join(", ")} ✅\n\n${left.length ? shoppingText(left) : "Đã mua đủ hết rồi! 🎉"}`);
    return true;
  }

  // ----- money -----
  m = /^(chi|thu)\s+(.+)$/i.exec(lower);
  if (m && /^\d/.test(m[2].trim())) {
    const p = parseAmount(m[2]);
    if (p) {
      await ensureTables(env);
      const kind = m[1].toLowerCase();
      const note = p.rest.trim();
      const category = kind === "chi" ? categoryOf(note) : "Thu nhập";
      const r = await env.DB.prepare("INSERT INTO expenses (kind, amount, note, category, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(kind, p.amount, note, category, who || "", Date.now())
        .run();
      const t = today();
      const rows = await monthReport(env, t.y, t.mo);
      const total = rows.filter((x) => x.kind === kind).reduce((s, x) => s + x.amount, 0);
      await sendText(
        env,
        chatId,
        `Đã ghi #${r.meta.last_row_id}: ${kind === "chi" ? "chi" : "thu"} ${money(p.amount)}${note ? ` — ${note}` : ""}${kind === "chi" ? ` (${category})` : ""}.\nTổng ${kind} tháng ${t.mo}: ${money(total)}.`
      );
      return true;
    }
  }
  m = /^(?:thu chi|chi tieu|tong chi|tong thu chi|so thu chi|bao cao chi tieu)(?:\s+thang\s+(\d{1,2})(?:\s*[/-]\s*(\d{4}))?|\s+thang nay|\s+thang truoc)?$/.exec(n);
  if (m) {
    await ensureTables(env);
    const t = today();
    let y = t.y;
    let mo = t.mo;
    if (/thang truoc$/.test(n)) {
      mo -= 1;
      if (mo === 0) {
        mo = 12;
        y -= 1;
      }
    } else if (m[1]) {
      mo = Number(m[1]);
      y = m[2] ? Number(m[2]) : mo > t.mo ? t.y - 1 : t.y;
    }
    await sendText(env, chatId, reportText(await monthReport(env, y, mo), y, mo));
    return true;
  }
  m = /^xoa (?:chi|thu|khoan chi|khoan thu)\s*#?(\d+)$/.exec(n);
  if (m) {
    await ensureTables(env);
    const r = await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(Number(m[1])).run();
    await sendText(env, chatId, r.meta.changes ? `Đã xóa khoản #${m[1]}.` : `Không thấy khoản #${m[1]}.`);
    return true;
  }
  m = /^xuat (?:file )?(?:chi tieu|thu chi|so thu chi)(?:\s+thang\s+(\d{1,2})(?:\s*[/-]\s*(\d{4}))?)?$/.exec(n);
  if (m) {
    await ensureTables(env);
    const t = today();
    const mo = m[1] ? Number(m[1]) : t.mo;
    const y = m[2] ? Number(m[2]) : mo > t.mo ? t.y - 1 : t.y;
    const rows = await monthReport(env, y, mo);
    if (!rows.length) {
      await sendText(env, chatId, `Tháng ${mo}/${y} chưa có khoản nào để xuất.`);
      return true;
    }
    const link = await storeFile(env, origin, { body: reportCsv(rows), type: "text/csv; charset=utf-8", filename: `thu-chi-${y}-${pad(mo)}.csv` });
    await sendText(env, chatId, `File thu chi tháng ${mo}/${y} (${rows.length} khoản), mở bằng Excel/Google Sheets:\n${link}`);
    return true;
  }

  // ----- special days -----
  m = ADD_DAY_RE.exec(String(text || "").normalize("NFC").trim()); // original case keeps names like "bé An"
  if (m) {
    await ensureTables(env);
    const kind = /giỗ/i.test(m[1]) ? "gio" : /sinh nhật/i.test(m[1]) ? "sinhnhat" : "kyniem";
    const name = m[2].replace(/\s+(ngày|vào)$/i, "").trim();
    const day = Number(m[3]);
    const month = Number(m[4]);
    const year = m[5] ? Number(m[5]) : null;
    const tag = norm(m[6] || "");
    const lunar = /am|al/.test(tag) ? 1 : /duong|dl/.test(tag) ? 0 : kind === "gio" ? 1 : 0; // giỗ is lunar unless told otherwise
    if (day < 1 || day > (lunar ? 30 : 31) || month < 1 || month > 12) {
      await sendText(env, chatId, "Ngày tháng chưa đúng, bạn kiểm tra lại giúp mình (ví dụ 15/7).");
      return true;
    }
    const r = await env.DB.prepare(
      "INSERT INTO special_days (kind, name, day, month, year, lunar, chat_id, bot, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(kind, name, day, month, year, lunar, String(chatId), env.BOT_ID || "main", who || "", Date.now())
      .run();
    const ev = { id: r.meta.last_row_id, kind, name, day, month, year, lunar };
    await sendText(
      env,
      chatId,
      `Đã lưu ${eventLine(ev)}.\nBot sẽ nhắc trước 3 ngày, trước 1 ngày và đúng ngày${lunar ? " (tự đổi âm lịch sang dương lịch mỗi năm)" : ""}.` +
        (lunar && !/am|al/.test(tag) ? '\n(Mình hiểu là ngày âm lịch. Nếu là dương lịch, xóa rồi thêm lại kèm chữ "dương".)' : "")
    );
    return true;
  }
  if (["ngay dac biet", "ngay gio", "lich gio", "danh sach gio", "cac ngay gio", "sinh nhat", "danh sach sinh nhat", "ngay ky niem", "ngay le gia dinh"].includes(n)) {
    await ensureTables(env);
    const list = await listSpecialDays(env);
    await sendText(
      env,
      chatId,
      list.length
        ? `📅 Ngày đặc biệt của gia đình:\n${list.map((e) => eventLine(e)).join("\n")}\n\nXóa: "xóa ngày <số>"`
        : 'Chưa lưu ngày nào. Ví dụ: "giỗ ông nội 15/7" (âm lịch), "sinh nhật bé An 20/11/2019", "kỷ niệm ngày cưới 10/10/2015".'
    );
    return true;
  }
  m = /^xoa (?:ngay|gio|sinh nhat|ky niem)\s*#?(\d+)$/.exec(n);
  if (m) {
    await ensureTables(env);
    const r = await env.DB.prepare("DELETE FROM special_days WHERE id = ?").bind(Number(m[1])).run();
    await sendText(env, chatId, r.meta.changes ? `Đã xóa ngày #${m[1]}.` : `Không thấy ngày #${m[1]}.`);
    return true;
  }
  if (["am lich", "hom nay am lich", "ngay am lich", "hom nay ngay bao nhieu am", "hom nay bao nhieu am"].includes(n)) {
    const t = today();
    const l = solarToLunar(t.d, t.mo, t.y);
    await sendText(env, chatId, `Hôm nay ${pad(t.d)}/${pad(t.mo)}/${t.y} là ngày ${l.day}/${l.month}${l.leap ? " (tháng nhuận)" : ""} âm lịch, năm ${yearName(l.year)}.`);
    return true;
  }

  // ----- morning brief -----
  m = /^(?:bat|mo|dang ky|cai) ban tin(?: sang)?(?:\s+(?:luc\s+)?(\d{1,2})\s*(?:h|gio|:)\s*(\d{1,2})?)?/.exec(n);
  if (m) {
    await ensureTables(env);
    const hour = m[1] ? Math.min(23, Number(m[1])) : 6;
    const minute = m[2] ? Math.min(59, Number(m[2])) : 0;
    const t = today();
    // Turning it on after today's time: start tomorrow
    const lastSent = t.h * 60 + t.mi > hour * 60 + minute ? t.key : null;
    await env.DB.prepare("INSERT OR REPLACE INTO brief_subs (chat_id, bot, hour, minute, last_sent) VALUES (?, ?, ?, ?, ?)")
      .bind(String(chatId), env.BOT_ID || "main", hour, minute, lastSent)
      .run();
    await sendText(
      env,
      chatId,
      `Đã bật bản tin sáng lúc ${pad(hour)}:${pad(minute)} mỗi ngày cho cuộc trò chuyện này: thời tiết, ngày âm lịch, việc cần nhắc, ngày giỗ/sinh nhật sắp tới, danh sách đi chợ và tin chính.\nXem thử ngay: "bản tin" · Đổi giờ: "bật bản tin sáng 6h30" · Tắt: "tắt bản tin sáng"`
    );
    return true;
  }
  if (/^(?:tat|huy|ngung) ban tin(?: sang)?$/.test(n)) {
    await ensureTables(env);
    const r = await env.DB.prepare("DELETE FROM brief_subs WHERE chat_id = ? AND bot = ?").bind(String(chatId), env.BOT_ID || "main").run();
    await sendText(env, chatId, r.meta.changes ? "Đã tắt bản tin sáng." : "Bản tin sáng chưa bật ở đây.");
    return true;
  }
  if (["ban tin", "ban tin sang", "ban tin hom nay", "/brief"].includes(n)) {
    await sendText(env, chatId, await briefText(env, chatId, env.BOT_ID || "main"));
    return true;
  }

  return false;
}
