// Chooses the tool for a plain-words request (picture, song, Word or Excel file) and the provider for it.
// No imports and no network calls, so it can be tested with node.
//
// Cost policy:
//   - free providers first; text chat never uses a paid model by default
//   - paid media (Gemini / OpenAI pictures, Lyria songs) only when the user asks for that provider or for
//     higher quality, and never past the daily cap (see media.js)
//   - Word / Excel use the "smart" text chain (Claude first, free models as fallback)

export const TOOL_IDS = ["chat", "image", "music", "word", "excel"];

// Price notes shown to the user before/after a paid task (USD, per item)
export const PRICE = {
  gemini_image: "khoảng $0.034 mỗi ảnh",
  lyria: "$0.08 mỗi bài",
  openai_image: "tính phí theo ảnh (giá theo bảng của OpenAI)",
};

const ACTION = /(tạo|làm|soạn|viết|xuất|lập|vẽ|sáng tác)/;
const norm = (s) => String(s || "").toLowerCase().normalize("NFC");

// Deterministic match for clear requests. Returns a tool id or null (null = unsure, ask the classifier or chat).
export function keywordRoute(text) {
  const t = norm(text);
  if (/(bài hát|bài nhạc|sáng tác nhạc|tạo nhạc|làm nhạc|soạn nhạc|viết nhạc|lời bài hát)/.test(t) && ACTION.test(t)) return "music";
  if (/\bexcel\b|bảng tính|sổ theo dõi/.test(t) && ACTION.test(t)) return "excel";
  if (/\bword\b|văn bản|công văn|biên bản|tờ trình|quyết định/.test(t) && ACTION.test(t)) return "word";
  if (/(vẽ|tạo ảnh|tạo hình|làm ảnh|minh họa)/.test(t)) return "image";
  return null;
}

// Requests that look like a task but matched no rule: worth one cheap classification call.
export function needsClassifier(text) {
  return ACTION.test(norm(text)) && keywordRoute(text) === null;
}

// Which provider the user asked for or implied: "openai" | "gemini" | "claude" | "premium" | null
export function providerHint(text) {
  const t = norm(text);
  if (/chatgpt|\bgpt\b|openai/.test(t)) return "openai";
  if (/gemini/.test(t)) return "gemini";
  if (/claude/.test(t)) return "claude";
  if (/đẹp hơn|chất lượng cao|xịn|thật đẹp|chi tiết hơn/.test(t)) return "premium";
  return null;
}

export const CLASSIFY_PROMPT = `Phân loại yêu cầu của người dùng (tiếng Việt) vào đúng một loại:
- image: vẽ tranh, tạo ảnh, minh họa
- music: sáng tác bài hát, tạo nhạc
- word: soạn văn bản, công văn, biên bản, tờ trình, file Word
- excel: lập bảng tính, sổ theo dõi, file Excel
- chat: mọi việc khác (hỏi đáp, trò chuyện, giải thích)
Chỉ trả về JSON dạng {"tool":"image"} hoặc {"tool":"chat"}, không giải thích.`;

// Reads the classifier answer. Returns a tool id, or null when the answer is not usable.
export function parseClassification(raw) {
  const m = /\{[^{}]*\}/.exec(String(raw || ""));
  if (!m) return null;
  try {
    const tool = JSON.parse(m[0]).tool;
    return TOOL_IDS.includes(tool) ? tool : null;
  } catch {
    return null;
  }
}

// Final decision. available: {gemini, openai, claude} booleans (keys present).
// Returns {tool, provider, note?, unavailable?}
//   provider: "free" | "gemini" | "openai" | "lyria" | "smart" (text chain) | null
export function planTool({ tool, hint, available }) {
  if (tool === "image") {
    if (hint === "openai") {
      if (available.openai) return { tool, provider: "openai" };
      return { tool, provider: "free", note: "Chưa bật ChatGPT (chưa có khóa OpenAI), nên mình vẽ bằng bản miễn phí." };
    }
    if (hint === "gemini" || hint === "premium") {
      if (available.gemini) return { tool, provider: "gemini" };
      return { tool, provider: "free", note: "Chưa bật Gemini nên mình vẽ bằng bản miễn phí." };
    }
    return { tool, provider: "free" };
  }
  if (tool === "music") {
    if (hint === "openai" || hint === "claude") {
      return { tool, unavailable: true, note: "Hiện mình chỉ tạo được nhạc bằng Gemini (Lyria), chưa tạo được nhạc bằng ChatGPT hay Claude." };
    }
    if (!available.gemini) return { tool, unavailable: true, note: "Mình chưa bật được tính năng tạo nhạc (chưa có khóa Gemini)." };
    return { tool, provider: "lyria" };
  }
  if (tool === "word" || tool === "excel") return { tool, provider: "smart" };
  return { tool: "chat", provider: null };
}
