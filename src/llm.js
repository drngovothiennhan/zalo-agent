// Text generation with automatic fallback:
// Workers AI (Llama) first; if it fails (daily free quota used up, model error, empty answer)
// the same request goes to Gemini (GEMINI_API_KEY). Logged to event_log as "ai.fallback".
import { trace } from "./zalo.js";
import { logEvent } from "./db.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_GEMINI_TEXT_MODEL = "gemini-flash-latest";
const COOLDOWN_MS = 15 * 60 * 1000; // after a quota error, skip Workers AI for a while

let workersSkipUntil = 0;

function outputText(out) {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return JSON.stringify(out.response);
  if (out.choices?.[0]?.message?.content) return out.choices[0].message.content;
  return "";
}

const isQuotaError = (msg) => /4006|neurons|daily free allocation|quota|limit|429/i.test(msg);

async function viaWorkers(env, messages, { max_tokens, temperature }) {
  const params = { messages, max_tokens };
  if (temperature !== undefined) params.temperature = temperature;
  const out = await env.AI.run(env.MODEL || DEFAULT_MODEL, params);
  const text = outputText(out).trim();
  if (!text) throw new Error("Workers AI trả về rỗng");
  return text;
}

async function geminiRequest(env, model, body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function viaGemini(env, messages, { max_tokens, temperature }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system" && m.content)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  const generationConfig = { maxOutputTokens: Math.max(max_tokens * 2, 2048) }; // room for the model's own reasoning
  if (temperature !== undefined) generationConfig.temperature = temperature;
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig };

  let model = env.GEMINI_TEXT_MODEL || env.GEMINI_MODEL || DEFAULT_GEMINI_TEXT_MODEL;
  let r = await geminiRequest(env, model, body);
  const suggested = !r.ok && /use models\/([\w.-]+)/.exec(JSON.stringify(r.data))?.[1];
  if (suggested && suggested !== model) {
    model = suggested;
    r = await geminiRequest(env, model, body);
  }
  if (!r.ok) throw new Error(`Gemini ${r.status} (${model}): ${JSON.stringify(r.data).slice(0, 200)}`);
  const text = (r.data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini trả về rỗng");
  return text;
}

// messages: [{role: system|user|assistant, content}]
export async function runText(env, messages, { max_tokens = 600, temperature } = {}) {
  const opts = { max_tokens, temperature };
  let workersError = null;
  if (Date.now() >= workersSkipUntil) {
    try {
      return await viaWorkers(env, messages, opts);
    } catch (e) {
      workersError = String((e && e.message) || e);
      if (isQuotaError(workersError)) workersSkipUntil = Date.now() + COOLDOWN_MS;
    }
  } else {
    workersError = "đang tạm bỏ qua Workers AI sau lỗi hạn mức";
  }
  if (!env.GEMINI_API_KEY) throw new Error(workersError);
  trace("ai.fallback", { to: "gemini", reason: workersError.slice(0, 200) });
  await logEvent(env, "ai.fallback", `Workers AI: ${workersError.slice(0, 300)} -> Gemini`);
  try {
    return await viaGemini(env, messages, opts);
  } catch (e) {
    await logEvent(env, "ai.error", `Workers AI: ${workersError.slice(0, 200)} | Gemini: ${String(e && e.message).slice(0, 300)}`);
    throw new Error(`cả Workers AI và Gemini đều lỗi (${String(e && e.message).slice(0, 80)})`);
  }
}
