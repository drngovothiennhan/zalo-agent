// Chooses which tool handles a plain-words request, so the family does not need command words.
// Pure: no imports, no network, so it can be tested with node.
//
// Cost policy (built in, nothing to configure):
//   - every tool here runs on free providers the bot already uses (Workers AI, Gemini, Groq, ...)
//   - Claude is only the last resort for Word/Excel, and only if an ANTHROPIC_API_KEY was added
//   - a plain chat question never goes to a paid model

export const TOOL_IDS = ["chat", "image", "word", "excel"];

const ACTION = /(tạo|làm|soạn|viết|xuất|lập|vẽ|minh họa)/;
const norm = (s) => String(s || "").toLowerCase().normalize("NFC");

// Clear requests, matched without a model. Returns a tool id, or null when unsure.
export function keywordRoute(text) {
  const t = norm(text);
  if (/\bexcel\b|bảng tính|sổ theo dõi/.test(t) && ACTION.test(t)) return "excel";
  if (/\bword\b|văn bản|công văn|biên bản|tờ trình|quyết định/.test(t) && ACTION.test(t)) return "word";
  if (/(vẽ|tạo ảnh|tạo hình|làm ảnh|minh họa)/.test(t) && !/(là gì|là sao|nghĩa là)/.test(t)) return "image";
  return null;
}

// A task-like sentence that matched no rule: worth one cheap classification call.
export function needsClassifier(text) {
  return ACTION.test(norm(text)) && keywordRoute(text) === null;
}

export const CLASSIFY_PROMPT = `Phân loại yêu cầu của người dùng (tiếng Việt) vào đúng một loại:
- image: vẽ tranh, tạo ảnh, minh họa
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
