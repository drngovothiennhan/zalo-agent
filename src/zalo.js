// Zalo Bot Platform API helpers + in-memory diagnostics
export const ZALO_API = "https://bot-api.zaloplatforms.com";
const MAX_CHUNK = 2000; // Zalo limit per outgoing text

export const DEBUG = [];
export function trace(kind, data) {
  DEBUG.push({ t: new Date().toISOString(), kind, data });
  if (DEBUG.length > 40) DEBUG.shift();
  console.log(kind, JSON.stringify(data));
}

export async function zalo(env, method, body) {
  let data;
  try {
    const res = await fetch(`${ZALO_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    try {
      data = JSON.parse(raw);
    } catch {
      data = { ok: false, http: res.status, raw: raw.slice(0, 300) };
    }
  } catch (e) {
    data = { ok: false, fetch_error: String(e && e.message) };
  }
  if (method !== "sendChatAction" || !data.ok) {
    trace(`zalo.${method}`, {
      ok: data.ok,
      error_code: data.error_code,
      description: data.description,
      http: data.http,
      raw: data.raw,
      fetch_error: data.fetch_error,
    });
  }
  return data;
}

export function chunk(text) {
  const out = [];
  let rest = String(text || "").trim();
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf("\n", MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.5) cut = rest.lastIndexOf(" ", MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.5) cut = MAX_CHUNK;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export async function sendText(env, chatId, text) {
  for (const part of chunk(text)) {
    await zalo(env, "sendMessage", { chat_id: chatId, text: part });
  }
}

export async function typing(env, chatId) {
  await zalo(env, "sendChatAction", { chat_id: chatId, action: "typing" });
}
