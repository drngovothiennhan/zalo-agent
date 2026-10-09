// Paid picture and music providers (Gemini, OpenAI, Lyria) plus the daily cap on paid calls.
// The request builders and response reader at the top are pure (tested in test/media.test.mjs).
// The API shapes come from Google's and OpenAI's public docs; the Gemini music/picture responses are
// read generically (see findMedia), so check the first real reply after adding a key.

export const GEMINI_IMAGE_DEFAULT = "gemini-nano-banana-2.1";
export const OPENAI_IMAGE_DEFAULT = "gpt-image-2.5-flare";
export const LYRIA_MODEL = "lyria-3.5";

// Gemini image models use the Interactions API
export function geminiImageBody(prompt, model = GEMINI_IMAGE_DEFAULT) {
  return { model, input: { type: "text", text: prompt } };
}

// Lyria song: a plain generateContent request
export function lyriaBody(prompt) {
  return { contents: [{ role: "user", parts: [{ text: prompt }] }] };
}

export function openaiImageBody(prompt, model = OPENAI_IMAGE_DEFAULT) {
  return { model, prompt, n: 1, size: "1024x1024" };
}

// Finds the first media item of the given kind ("image" or "audio") in any response shape:
//   generateContent:  {inlineData: {mimeType, data}}  (or inline_data)
//   Interactions:     {type: "image", data, mime_type?}
//   OpenAI images:    {b64_json}
// Returns {mime, b64} or null.
export function findMedia(node, kind) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const r = findMedia(x, kind);
      if (r) return r;
    }
    return null;
  }
  const inl = node.inlineData || node.inline_data;
  if (inl && typeof inl.data === "string" && String(inl.mimeType || inl.mime_type || "").startsWith(kind + "/")) {
    return { mime: inl.mimeType || inl.mime_type, b64: inl.data };
  }
  if (node.type === kind && typeof node.data === "string") {
    return { mime: node.mime_type || node.mimeType || (kind === "image" ? "image/png" : "audio/mpeg"), b64: node.data };
  }
  if (kind === "image" && typeof node.b64_json === "string") return { mime: "image/png", b64: node.b64_json };
  for (const v of Object.values(node)) {
    const r = findMedia(v, kind);
    if (r) return r;
  }
  return null;
}

async function postJson(url, headers, body, label) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} (${label}): ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function geminiImage(env, prompt) {
  const data = await postJson(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    { "x-goog-api-key": env.GEMINI_API_KEY },
    geminiImageBody(prompt, env.GEMINI_IMAGE_MODEL || GEMINI_IMAGE_DEFAULT),
    "gemini image"
  );
  const img = findMedia(data, "image");
  if (!img) throw new Error("Gemini không trả về ảnh");
  return img;
}

export async function openaiImage(env, prompt) {
  const data = await postJson(
    "https://api.openai.com/v1/images/generations",
    { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    openaiImageBody(prompt, env.OPENAI_IMAGE_MODEL || OPENAI_IMAGE_DEFAULT),
    "openai image"
  );
  const img = findMedia(data, "image");
  if (!img) throw new Error("ChatGPT không trả về ảnh");
  return img;
}

export async function lyriaSong(env, prompt) {
  const model = env.LYRIA_MODEL || LYRIA_MODEL;
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": env.GEMINI_API_KEY },
    lyriaBody(prompt),
    "lyria"
  );
  const song = findMedia(data, "audio");
  if (!song) throw new Error("Gemini không trả về bài nhạc");
  return song;
}

// Daily cap on paid calls, counted in the meta table (per Vietnam day and provider).
// Throws when the cap is reached, so the caller can tell the user instead of spending.
export async function reservePaid(env, provider) {
  const limit = Number(env.PAID_MEDIA_PER_DAY || 20);
  const day = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = `paid:${day}:${provider}`;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)").run();
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  const used = Number(row?.value || 0);
  if (used >= limit) throw new Error(`đã đạt giới hạn ${limit} lượt trả phí hôm nay`);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, String(used + 1)).run();
}
