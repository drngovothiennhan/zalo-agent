// Runtime side of the traffic watch: TomTom lookups (cached in D1), scheduled checks, and manual checks.
import { sendText } from "./zalo.js";
import { logEvent } from "./db.js";
import { botById, botEnv } from "./bots.js";
import { vnClock } from "./weatherwatch.js";
import { dueSlot, slotLabel, congestion, trafficMessage } from "./traffic.js";

// Roads watched in Thủ Đức, Linh Xuân, Tam Bình, Bình Chiểu: the two routes the family named, plus main roads
export const ROADS = [
  "Đặng Văn Bi",
  "Tô Ngọc Vân",
  "Phạm Văn Đồng",
  "Tam Hà",
  "Tỉnh lộ 43",
  "Bình Chiểu",
  "Võ Văn Ngân",
  "Kha Vạn Cân",
  "Lê Văn Việt",
  "Đỗ Xuân Hợp",
  "Nguyễn Duy Trinh",
  "Tăng Nhơn Phú",
  "Man Thiện",
  "Lê Văn Chí",
];
const AREA = ", Thủ Đức, TP. Hồ Chí Minh";
const CENTER = { lat: 10.85, lon: 106.75 };

let ready = false;
async function ensureTables(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS traffic_roads (name TEXT PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS traffic_subs (chat_id TEXT NOT NULL, bot TEXT NOT NULL DEFAULT 'main', last_key TEXT, PRIMARY KEY (chat_id, bot))"),
  ]);
  ready = true;
}

export async function setTraffic(env, chatId, on) {
  await ensureTables(env);
  const bot = env.BOT_ID || "main";
  if (on) {
    await env.DB.prepare("INSERT OR IGNORE INTO traffic_subs (chat_id, bot) VALUES (?, ?)").bind(String(chatId), bot).run();
    return true;
  }
  const r = await env.DB.prepare("DELETE FROM traffic_subs WHERE chat_id = ? AND bot = ?").bind(String(chatId), bot).run();
  return r.meta.changes > 0;
}

// Finds a point on each road once, then keeps it in D1
async function resolveRoads(env) {
  const { results } = await env.DB.prepare("SELECT name, lat, lon FROM traffic_roads").all();
  const known = new Map(results.map((r) => [r.name, r]));
  for (const name of ROADS) {
    if (known.has(name)) continue;
    const url =
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(name + AREA)}.json` +
      `?key=${env.TOMTOM_API_KEY}&countrySet=VN&limit=1&lat=${CENTER.lat}&lon=${CENTER.lon}&radius=20000`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`TomTom tìm đường ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
    const pos = data.results?.[0]?.position;
    if (!pos) continue; // road not found: skip it, do not stop the others
    await env.DB.prepare("INSERT OR REPLACE INTO traffic_roads (name, lat, lon) VALUES (?, ?, ?)").bind(name, pos.lat, pos.lon).run();
    known.set(name, { name, lat: pos.lat, lon: pos.lon });
  }
  return [...known.values()];
}

// Current speed on every watched road: [{name, level, speed}]
export async function checkRoads(env) {
  if (!env.TOMTOM_API_KEY) throw new Error("chưa có khóa TomTom (TOMTOM_API_KEY)");
  const roads = await resolveRoads(env);
  if (!roads.length) throw new Error("không tìm được đoạn đường nào");
  const rows = await Promise.all(
    roads.map(async (r) => {
      const url =
        `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
        `?key=${env.TOMTOM_API_KEY}&point=${r.lat},${r.lon}&unit=KMPH`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`TomTom lưu lượng ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
      const f = data.flowSegmentData || {};
      const c = congestion(f.currentSpeed, f.freeFlowSpeed);
      return c ? { name: r.name, level: c.level, speed: f.currentSpeed } : null;
    })
  );
  return rows.filter(Boolean);
}

// Manual check: "kiểm tra kẹt xe" — always replies, so the key and roads can be tested
export async function manualTraffic(env) {
  try {
    const rows = await checkRoads(env);
    const now = vnClock(Date.now());
    const lines = rows.map((r) => `- ${r.name}: ${r.level} (${Math.round(r.speed)} km/h)`);
    return `🚗 Kẹt xe lúc ${slotLabel(now.minutes)} (${rows.length} tuyến):\n${lines.join("\n")}`;
  } catch (e) {
    await logEvent(env, "traffic.error", String(e && e.message));
    return `Chưa lấy được dữ liệu kẹt xe: ${String(e && e.message).slice(0, 160)}`;
  }
}

// Cron (every minute): at each check time, one message to each subscribed group if roads are congested
export async function runTraffic(env, now = Date.now()) {
  if (!env.TOMTOM_API_KEY) return;
  const { minutes, day } = vnClock(now);
  const slot = dueSlot(minutes);
  if (slot === null) return;
  await ensureTables(env);
  const key = `${day}-${slot}`;
  const { results } = await env.DB.prepare("SELECT * FROM traffic_subs WHERE last_key IS NULL OR last_key != ?").bind(key).all();
  if (!results.length) return;

  let rows;
  try {
    rows = await checkRoads(env);
  } catch (e) {
    await logEvent(env, "traffic.error", String(e && e.message));
    return;
  }
  const text = trafficMessage(slot, rows);
  for (const s of results) {
    await env.DB.prepare("UPDATE traffic_subs SET last_key = ? WHERE chat_id = ? AND bot = ?").bind(key, s.chat_id, s.bot).run();
    const benv = botEnv(env, botById(s.bot));
    if (text && benv.BOT_TOKEN) await sendText(benv, s.chat_id, text);
  }
}
