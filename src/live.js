// Up-to-date answers: news, prices, economy (Gemini + Google Search, falling back to VnExpress RSS)
// and weather questions asked in plain words.
import { runText } from "./llm.js";
import { logEvent } from "./db.js";
import { nowDescription } from "./time.js";

const strip = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const LIVE_RE =
  /(tin tuc|tin moi|tin nong|thoi su|bao chi|diem bao|gia vang|vang sjc|vang nhan|ty gia|gia (do|usd|dola|dollar)|do la|chung khoan|vn-?index|co phieu|gia xang|xang dau|lai suat|bitcoin|tien ao|gia ca|lam phat|kinh te|thi truong|moi nhat|vua xay ra|hom nay co gi|su kien|bong da|ket qua tran|lich thi dau|chinh sach moi|quy dinh moi)/;
const WEATHER_RE = /(thoi tiet|troi (co )?(mua|nang|lanh|nong|dep)|co mua|mua khong|nang khong|nhiet do|nong khong|lanh khong|co bao|con bao|du bao|ap thap)/;
const ECON_RE = /(vang|ty gia|do la|usd|chung khoan|co phieu|xang|lai suat|bitcoin|gia ca|lam phat|kinh te|thi truong)/;

export const isWeatherQuestion = (text) => {
  const t = strip(text);
  return WEATHER_RE.test(t) && !/(bao chi|diem bao)/.test(t) && !ECON_RE.test(t); // "dự báo giá vàng" is not weather
};
export const needsLive = (text) => LIVE_RE.test(strip(text));

// Place named in a weather question ("" = default city)
export async function weatherPlace(env, text) {
  const t = String(text || "").normalize("NFC");
  const m = /thời tiết\s+(?:ở|tại)?\s*([^?.!,\n]+)/i.exec(t);
  let place = m ? m[1] : "";
  if (!place) {
    try {
      place = await runText(
        env,
        [
          { role: "system", content: "Trích tên địa danh (tỉnh, thành phố, quận, nơi chốn) trong câu hỏi thời tiết. Chỉ trả về tên địa danh, không giải thích. Nếu không có địa danh, trả về đúng chữ: KHÔNG" },
          { role: "user", content: t },
        ],
        { max_tokens: 30, temperature: 0, tier: "simple" }
      );
    } catch {
      place = "";
    }
  }
  place = String(place)
    .replace(/hôm nay|ngày mai|ngày kia|bây giờ|hiện tại|như thế nào|thế nào|ra sao|sao rồi|có mưa không|mưa không|nắng không|[?.!,"]/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !["ở", "tại", "thì", "sao", "nhỉ", "vậy", "trời", "không"].includes(w.toLowerCase()))
    .join(" ")
    .trim();
  return /^kh[oô]ng$/i.test(place) ? "" : place;
}

// ---------- Gemini with Google Search ----------
async function geminiSearch(env, question) {
  if (!env.GEMINI_API_KEY) throw new Error("chưa có GEMINI_API_KEY");
  const body = {
    systemInstruction: {
      parts: [
        {
          text:
            `Bạn là trợ lý gia đình trên Zalo. Thời điểm hiện tại: ${nowDescription()}. ` +
            "Hãy tìm trên Google rồi trả lời bằng tiếng Việt, ngắn gọn, đúng số liệu mới nhất (nêu rõ thời điểm của số liệu), gạch đầu dòng khi liệt kê, không dùng bảng hay Markdown. Không bịa số liệu.",
        },
      ],
    },
    contents: [{ role: "user", parts: [{ text: question }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 2048 },
  };
  const call = async (model) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  };
  let model = env.GEMINI_TEXT_MODEL || env.GEMINI_MODEL || "gemini-flash-latest";
  let r = await call(model);
  const suggested = !r.ok && /use models\/([\w.-]+)/.exec(JSON.stringify(r.data))?.[1];
  if (suggested && suggested !== model) {
    model = suggested;
    r = await call(model);
  }
  if (!r.ok) throw new Error(`Gemini search ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const cand = r.data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini search trả về rỗng");
  const sources = [];
  for (const c of cand.groundingMetadata?.groundingChunks || []) {
    const title = c.web?.title;
    if (title && !sources.includes(title)) sources.push(title);
  }
  return text + (sources.length ? `\n\nNguồn: ${sources.slice(0, 4).join(", ")}` : "");
}

// ---------- RSS fallback ----------
const FEEDS = {
  latest: "https://vnexpress.net/rss/tin-moi-nhat.rss",
  business: "https://vnexpress.net/rss/kinh-doanh.rss",
};

const decode = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

export async function fetchHeadlines(url, limit = 15) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (family Zalo bot)" } });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => decode((new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(m[1]) || [])[1]);
    items.push({ title: get("title"), summary: get("description").slice(0, 220), link: get("link"), date: get("pubDate") });
    if (items.length >= limit) break;
  }
  return items;
}

async function rssAnswer(env, question) {
  const econ = ECON_RE.test(strip(question));
  const lists = await Promise.all(
    (econ ? [FEEDS.business, FEEDS.latest] : [FEEDS.latest]).map((u) => fetchHeadlines(u, 15).catch(() => []))
  );
  const items = lists.flat();
  if (!items.length) throw new Error("không tải được tin");
  const digest = items.map((it, i) => `[${i + 1}] ${it.title} (${it.date})\n${it.summary}\n${it.link}`).join("\n\n");
  const answer = await runText(
    env,
    [
      {
        role: "system",
        content:
          `Thời điểm hiện tại: ${nowDescription()}. Dưới đây là các tin mới nhất từ VnExpress. Trả lời câu hỏi của người dùng bằng tiếng Việt, ngắn gọn, CHỈ dựa vào các tin này; ` +
          "liệt kê tối đa 5 ý, mỗi ý kèm link bài. Nếu các tin không có thông tin được hỏi (ví dụ giá vàng cụ thể), nói rõ là chưa có trong tin mới nhất. Không dùng bảng hay Markdown.\n\n" +
          digest,
      },
      { role: "user", content: question },
    ],
    { max_tokens: 900 }
  );
  return `${answer}\n\n(Nguồn: VnExpress)`;
}

export async function liveAnswer(env, question) {
  try {
    return await geminiSearch(env, question);
  } catch (e) {
    await logEvent(env, "live.gemini.error", String(e && e.message));
  }
  return rssAnswer(env, question);
}
