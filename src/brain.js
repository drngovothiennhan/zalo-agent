// LLM calls (Workers AI)
import { nowDescription } from "./time.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const NOTES_BUDGET = 6000; // max characters of family notes injected into the prompt

const BASE_PROMPT = `Bạn là trợ lý chung của gia đình anh Ngô Võ Thiện Nhân (Ths, nhân viên y tế trường mầm non, sinh viên Y khoa ngành YHCT). Bạn trò chuyện qua Zalo.
Luôn trả lời bằng tiếng Việt, ngắn gọn, rõ ý, giọng thân thiện; dùng gạch đầu dòng khi liệt kê; không dùng bảng hay định dạng Markdown phức tạp vì Zalo không hiển thị.
Khi mọi người chỉ tán gẫu, đùa vui hay hỏi han chuyện thường ngày: trò chuyện tự nhiên như một thành viên vui tính trong nhà, câu ngắn, hài hước nhẹ nhàng, dùng emoji vừa phải, có thể hỏi lại để câu chuyện tiếp tục; không giảng giải dài dòng, không liệt kê gạch đầu dòng. Đùa vui nhưng tế nhị, phù hợp cả trẻ em, không chê bai hay trêu chọc ai.
Bạn hỗ trợ cả nhà: hỏi đáp đời sống, nấu ăn và thực đơn, chăm sóc sức khỏe cơ bản, bài vở của con, soạn văn bản, tóm tắt. Riêng anh Nhân còn cần hỗ trợ công việc y tế học đường (khám, tầm soát, tiêm chủng, an toàn thực phẩm, sổ kiểm thực, lưu mẫu thức ăn, sơ cấp cứu) và học YHCT.
Thông tin y khoa chỉ mang tính tham khảo, không thay thế chẩn đoán của bác sĩ; với tình huống khẩn cấp, nhắc gọi 115 hoặc đưa người bệnh đến cơ sở y tế ngay.
Nếu không chắc, nói rõ là không chắc; không bịa số liệu hay nguồn.
Bot có sẵn các lệnh: "ghi nhớ: ..." để lưu ghi chú gia đình, "xem ghi chú", "nhắc tôi ... lúc ..." để đặt lịch nhắc, "xem lịch nhắc", "thời tiết <nơi>", "vẽ <mô tả>", "tạo file word: <yêu cầu>", "tạo file excel: <yêu cầu>", gửi ảnh để bot đọc, "hướng dẫn". Nếu người dùng muốn lưu thông tin, đặt nhắc, xem thời tiết, vẽ tranh hay tạo file, hãy hướng dẫn họ dùng đúng các lệnh này thay vì tự hứa sẽ làm.`;

function outputText(out) {
  if (!out) return "";
  if (typeof out.response === "string") return out.response;
  if (out.response && typeof out.response === "object") return JSON.stringify(out.response);
  if (out.choices?.[0]?.message?.content) return out.choices[0].message.content;
  return "";
}

function notesBlock(notes) {
  if (!notes?.length) return "";
  let used = 0;
  const lines = [];
  for (const n of notes) {
    const line = `- ${n.text}${n.author ? ` (${n.author} ghi)` : ""}`;
    if (used + line.length > NOTES_BUDGET) break;
    used += line.length;
    lines.push(line);
  }
  return `\n\nSổ ghi nhớ của gia đình (thông tin do các thành viên lưu, hãy dùng khi liên quan):\n${lines.join("\n")}`;
}

function kbBlock(snippets) {
  if (!snippets?.length) return "";
  const parts = snippets.map((s, i) => `[${i + 1}] Trích "${s.doc_name}":\n${s.content}`);
  return `\n\nTài liệu tham khảo tìm được trong kho tài liệu của gia đình (có thể không liên quan; chỉ dùng phần thực sự liên quan, và khi dùng thì ghi nguồn dạng "(Theo: tên tài liệu)"):\n${parts.join("\n\n")}`;
}

// Single-shot completion helper
export async function complete(env, system, user, { max_tokens = 600, temperature } = {}) {
  const params = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens,
  };
  if (temperature !== undefined) params.temperature = temperature;
  const out = await env.AI.run(env.MODEL || DEFAULT_MODEL, params);
  return outputText(out).trim();
}

export async function chat(env, { history, text, who, notes, kb }) {
  const system =
    BASE_PROMPT +
    `\n\nThời điểm hiện tại: ${nowDescription()}.` +
    (who ? `\nNgười đang nhắn tin: ${who}.` : "") +
    notesBlock(notes) +
    kbBlock(kb);
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: text }];
  const out = await env.AI.run(env.MODEL || DEFAULT_MODEL, { messages, max_tokens: 1200 });
  return outputText(out).trim() || "Mình chưa nghĩ ra câu trả lời, bạn thử hỏi lại giúp mình nhé.";
}

// Turn a natural-language reminder request into structured data.
// Returns { datetime: "YYYY-MM-DD HH:mm", task, repeat } or null.
export async function extractReminder(env, text) {
  const system = `Bạn là bộ phân tích lịch nhắc. Thời điểm hiện tại: ${nowDescription()}.
Đọc yêu cầu của người dùng và trả về DUY NHẤT một đối tượng JSON, không giải thích:
{"is_reminder": true, "datetime": "YYYY-MM-DD HH:mm", "task": "việc cần nhắc, viết ngắn gọn", "repeat": "none" | "daily" | "weekly"}
Quy tắc:
- datetime theo giờ Việt Nam, luôn ở tương lai so với thời điểm hiện tại.
- "sáng" mặc định 07:00, "trưa" 11:30, "chiều" 16:00, "tối" 20:00 nếu không nói giờ cụ thể. "7h tối" là 19:00.
- "mỗi ngày/hằng ngày" là daily; "mỗi tuần/thứ X hằng tuần" là weekly; còn lại none.
- Nếu đây không phải yêu cầu đặt lịch nhắc, trả về {"is_reminder": false}.`;
  const out = await env.AI.run(env.MODEL || DEFAULT_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    max_tokens: 200,
    temperature: 0,
  });
  const raw = outputText(out);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!data || data.is_reminder === false || !data.datetime || !data.task) return null;
  const repeat = ["daily", "weekly"].includes(data.repeat) ? data.repeat : "none";
  return { datetime: String(data.datetime), task: String(data.task).trim(), repeat };
}
