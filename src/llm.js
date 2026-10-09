// Text generation across several AI providers with automatic fallback.
// A provider is used only when its key is set (Workers AI needs none). When one fails
// (free quota used up, rate limit, model error, empty answer) the next one gets the same request.
//
//   tier "main"   (chat, Word/Excel):        Workers AI -> Gemini Flash -> Gemini Flash-Lite -> Groq -> Cerebras -> OpenRouter
//   tier "simple" (reminders, short prompts): Groq -> Cerebras -> Gemini Flash-Lite -> Workers AI -> Gemini Flash -> OpenRouter
//
// Secrets (Cloudflare > Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY
// Optional model overrides: MODEL, GEMINI_TEXT_MODEL, GEMINI_LITE_MODEL, GROQ_MODEL, GROQ_SIMPLE_MODEL, CEREBRAS_MODEL, OPENROUTER_MODEL
import { trace } from "./zalo.js";
import { logEvent } from "./db.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const COOLDOWN_MS = 15 * 60 * 1000; // after a quota/rate-limit error, skip that provider for a while
const skipUntil = {};

const isQuotaError = (msg) => /4006|neurons|daily free allocation|quota|rate.?limit|too many requests|\b429\b|exhausted/i.test(msg);

// ---------- Workers AI ----------
function workersText(out) {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return JSON.stringify(out.response);
  return out.choices?.[0]?.message?.content || "";
}

async function viaWorkers(env, messages, { max_tokens, temperature }) {
  const params = { messages, max_tokens };
  if (temperature !== undefined) params.temperature = temperature;
  return workersText(await env.AI.run(env.MODEL || DEFAULT_MODEL, params));
}

// ---------- Gemini ----------
async function geminiRequest(env, model, body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function viaGemini(env, messages, { max_tokens, temperature }, defaultModel = "gemini-flash-latest", override = env.GEMINI_TEXT_MODEL || env.GEMINI_MODEL) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system" && m.content)
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] }));
  const generationConfig = { maxOutputTokens: Math.max(max_tokens * 2, 2048) }; // room for the model's own reasoning
  if (temperature !== undefined) generationConfig.temperature = temperature;
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig };

  let model = override || defaultModel;
  let r = await geminiRequest(env, model, body);
  // Retired model: Google names the replacement in the error ("use models/<name>"), retry once with it
  const suggested = !r.ok && /use models\/([\w.-]+)/.exec(JSON.stringify(r.data))?.[1];
  if (suggested && suggested !== model) {
    model = suggested;
    r = await geminiRequest(env, model, body);
  }
  if (!r.ok) throw new Error(`${r.status} (${model}): ${JSON.stringify(r.data).slice(0, 200)}`);
  return (r.data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
}

// ---------- OpenAI-compatible APIs (Groq, Cerebras, OpenRouter) ----------
async function viaOpenAICompatible(env, { base, key, model, extraHeaders = {} }, messages, { max_tokens, temperature }) {
  const reasoning = /gpt-oss/.test(model);
  const body = { model, messages, max_tokens: reasoning ? max_tokens + 1024 : max_tokens };
  if (temperature !== undefined) body.temperature = temperature;
  if (reasoning) body.reasoning_effort = "low";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} (${model}): ${JSON.stringify(data).slice(0, 200)}`);
  return data.choices?.[0]?.message?.content || "";
}

const PROVIDERS = {
  workers: { label: "Cloudflare Workers AI", enabled: () => true, run: viaWorkers },
  gemini: { label: "Gemini Flash", enabled: (env) => !!env.GEMINI_API_KEY, run: (env, messages, opts) => viaGemini(env, messages, opts) },
  // Same Google key, separate free quota per model
  geminiLite: {
    label: "Gemini Flash-Lite",
    enabled: (env) => !!env.GEMINI_API_KEY,
    run: (env, messages, opts) => viaGemini(env, messages, opts, "gemini-flash-lite-latest", env.GEMINI_LITE_MODEL),
  },
  groq: {
    label: "Groq",
    enabled: (env) => !!env.GROQ_API_KEY,
    run: (env, messages, opts) =>
      viaOpenAICompatible(
        env,
        {
          base: "https://api.groq.com/openai/v1",
          key: env.GROQ_API_KEY,
          model: opts.tier === "simple" ? env.GROQ_SIMPLE_MODEL || "openai/gpt-oss-20b" : env.GROQ_MODEL || "llama-3.3-70b-versatile",
        },
        messages,
        opts
      ),
  },
  cerebras: {
    label: "Cerebras",
    enabled: (env) => !!env.CEREBRAS_API_KEY,
    run: (env, messages, opts) =>
      viaOpenAICompatible(env, { base: "https://api.cerebras.ai/v1", key: env.CEREBRAS_API_KEY, model: env.CEREBRAS_MODEL || "gpt-oss-120b" }, messages, opts),
  },
  openrouter: {
    label: "OpenRouter",
    enabled: (env) => !!env.OPENROUTER_API_KEY,
    run: (env, messages, opts) =>
      viaOpenAICompatible(
        env,
        {
          base: "https://openrouter.ai/api/v1",
          key: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL || "openrouter/free",
          extraHeaders: { "X-Title": "Zalo family bot" },
        },
        messages,
        opts
      ),
  },
};

const ORDER = {
  main: ["workers", "gemini", "geminiLite", "groq", "cerebras", "openrouter"],
  simple: ["groq", "cerebras", "geminiLite", "workers", "gemini", "openrouter"],
};

// Which providers are switched on (for the "trạng thái AI" command)
export function aiStatus(env) {
  const now = Date.now();
  return ORDER.main.map((id) => {
    const p = PROVIDERS[id];
    const state = !p.enabled(env) ? "chưa có khóa" : (skipUntil[id] || 0) > now ? "tạm nghỉ (vừa hết hạn mức)" : "sẵn sàng";
    return `- ${p.label}: ${state}`;
  });
}

// messages: [{role: system|user|assistant, content}]
export async function runText(env, messages, { max_tokens = 600, temperature, tier = "main" } = {}) {
  const opts = { max_tokens, temperature, tier };
  const failures = [];
  for (const id of ORDER[tier] || ORDER.main) {
    const p = PROVIDERS[id];
    if (!p.enabled(env)) continue;
    if ((skipUntil[id] || 0) > Date.now()) {
      failures.push(`${p.label}: tạm nghỉ`);
      continue;
    }
    try {
      const text = String((await p.run(env, messages, opts)) || "").trim();
      if (!text) throw new Error("trả về rỗng");
      if (failures.length) {
        trace("ai.fallback", { used: p.label, failed: failures });
        await logEvent(env, "ai.fallback", `${failures.join(" | ").slice(0, 600)} -> ${p.label}`);
      }
      return text;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (isQuotaError(msg)) skipUntil[id] = Date.now() + COOLDOWN_MS;
      failures.push(`${p.label}: ${msg.slice(0, 150)}`);
    }
  }
  await logEvent(env, "ai.error", failures.join(" | ").slice(0, 1000));
  throw new Error(`tất cả AI đều lỗi (${failures.map((f) => f.split(":")[0]).join(", ")})`);
}
