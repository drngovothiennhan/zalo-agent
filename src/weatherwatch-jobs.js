// Runtime side of the weather watch: switching it on per chat, fetching the forecast, and sending the messages.
import { sendText } from "./zalo.js";
import { botById, botEnv } from "./bots.js";
import { vnClock, rainAdvice, afternoonMessages, morningMessage, HCMC } from "./weatherwatch.js";

let ready = false;
async function ensureTable(env) {
  if (ready) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS watch_subs (chat_id TEXT NOT NULL, bot TEXT NOT NULL DEFAULT 'main', last_morning TEXT, last_afternoon TEXT, PRIMARY KEY (chat_id, bot))"
  ).run();
  ready = true;
}

export async function setWatch(env, chatId, on) {
  await ensureTable(env);
  const bot = env.BOT_ID || "main";
  if (on) {
    await env.DB.prepare("INSERT OR IGNORE INTO watch_subs (chat_id, bot) VALUES (?, ?)").bind(String(chatId), bot).run();
    return true;
  }
  const r = await env.DB.prepare("DELETE FROM watch_subs WHERE chat_id = ? AND bot = ?").bind(String(chatId), bot).run();
  return r.meta.changes > 0;
}

async function forecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${HCMC.lat}&longitude=${HCMC.lon}` +
    `&current=precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&hourly=precipitation_probability,precipitation&timezone=Asia%2FHo_Chi_Minh&forecast_days=1`;
  const f = await (await fetch(url)).json();
  const hourly = (f.hourly?.time || []).map((_, i) => ({
    hour: i,
    prob: f.hourly.precipitation_probability?.[i] ?? 0,
    precip: f.hourly.precipitation?.[i] ?? 0,
  }));
  return {
    nowPrecip: f.current?.precipitation ?? 0,
    hourly,
    tempMin: Math.round(f.daily?.temperature_2m_min?.[0] ?? 0),
    tempMax: Math.round(f.daily?.temperature_2m_max?.[0] ?? 0),
    rainChance: f.daily?.precipitation_probability_max?.[0] ?? 0,
  };
}

// Cron (every minute): 06:30–07:30 morning update, 16:00–17:00 rain and evening caution. Once per day each.
export async function runWeatherWatch(env, now = Date.now()) {
  await ensureTable(env);
  const { minutes, day } = vnClock(now);
  const morning = minutes >= 390 && minutes < 450;
  const afternoon = minutes >= 960 && minutes < 1020;
  if (!morning && !afternoon) return;

  const { results } = await env.DB.prepare("SELECT * FROM watch_subs").all();
  if (!results.length) return;

  const f = await forecast();
  const advice = rainAdvice(f);
  for (const s of results) {
    const benv = botEnv(env, botById(s.bot));
    if (!benv.BOT_TOKEN) continue;
    if (morning && s.last_morning !== day) {
      await env.DB.prepare("UPDATE watch_subs SET last_morning = ? WHERE chat_id = ? AND bot = ?").bind(day, s.chat_id, s.bot).run();
      await sendText(benv, s.chat_id, morningMessage({ ...f, rainNow: advice.rainNow }));
    }
    if (afternoon && s.last_afternoon !== day) {
      await env.DB.prepare("UPDATE watch_subs SET last_afternoon = ? WHERE chat_id = ? AND bot = ?").bind(day, s.chat_id, s.bot).run();
      for (const m of afternoonMessages(advice)) await sendText(benv, s.chat_id, m);
    }
  }
}
