// Chit-chat, advice, and "call the bot without @tagging it" (wake words + per-group listening mode).
import { complete } from "./brain.js";
import { nowDescription } from "./time.js";

export const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Names the bot answers to. "Bot Bin Bơ" -> "bin bo", "binbo"; "Bot Dr Tâm Phúc" -> "tam phuc", "dr tam phuc".
export function wakeWords(botName) {
  const base = norm(botName).replace(/^bot\s+/, "");
  const set = new Set(["bot", "tro ly"]);
  if (base) {
    set.add(base);
    set.add(base.replace(/\s+/g, ""));
    set.add(base.replace(/^dr\s+/, ""));
  }
  return [...set].filter(Boolean);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns the text without the wake word if the message calls the bot by name, else null.
export function wakeMatch(text, botName) {
  const t = norm(text);
  const words = wakeWords(botName);
  for (const w of words) {
    // at the start: "bin bơ ơi, ...", "ê bot ...", "trợ lý ơi ..."
    const re = new RegExp(`^(?:(?:e|ê|nay|hey|alo|oi|ok)\\s+)?${esc(w)}(?![a-z0-9])\\s*(?:oi|a|nhe)?[\\s,:!.]*`);
    if (re.test(t)) return stripLead(text, w);
    // the bot's own name anywhere in the sentence: "nhờ bin bơ xem giúp..."
    if (w !== "bot" && w !== "tro ly" && new RegExp(`(?<![a-z0-9])${esc(w)}(?![a-z0-9])`).test(t)) return text;
  }
  return null;
}

function stripLead(text, w) {
  // length of the call phrase in normalized form, then map back to the original characters
  const m = norm(text).match(new RegExp(`^(?:(?:e|ê|nay|hey|alo|oi|ok)\\s+)?${esc(w)}(?![a-z0-9])\\s*(?:oi|a|nhe)?[\\s,:!.]*`));
  const want = m ? m[0].length : 0;
  const chars = [...String(text)];
  let i = 0;
  while (i < chars.length && norm(chars.slice(0, i).join("") + "x").length - 1 < want) i++;
  return chars.slice(i).join("").replace(/^[\s,:!.]+/, "").trim() || text;
}

// ---------- listening mode (group answers without being called) ----------
async function table(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)").run();
}
const lkey = (bot, chatId) => `listen:${bot || "main"}:${chatId}`;

export async function isListening(env, bot, chatId) {
  try {
    await table(env);
    const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(lkey(bot, chatId)).first();
    return r?.value === "1";
  } catch {
    return false;
  }
}

async function setListening(env, bot, chatId, on) {
  await table(env);
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(lkey(bot, chatId), on ? "1" : "0").run();
}

// In listening mode, only jump in on questions / requests / chit-chat, not on every line.
export function worthAnswering(text) {
  const t = norm(text);
  if (t.length < 4) return false;
  if (/\?/.test(text)) return true;
  return /(^|\s)(ai biet|sao|tai sao|lam sao|lam the nao|bao nhieu|khi nao|o dau|co nen|nen lam|giup|chi minh|chi em|goi y|tu van|buon|chan|met|stress|lo qua|ke chuyen|do vui|cuoi)(\s|$)/.test(t);
}

// ---------- chit-chat / advice modes ----------
const MODES = [
  { id: "joke", re: /(ke|noi|cho) (minh |em |toi )?(1 |mot )?(chuyen cuoi|cau chuyen cuoi|chuyen vui|cau dua|truyen cuoi)|(chuyen|truyen) cuoi|(cho|ke) (minh |em )?(cuoi|dua)|ke chuyen vui/, key: "chuyện cười",
    sys: "Hãy kể MỘT câu chuyện cười hoặc câu đùa ngắn (3-6 câu), trong sáng, phù hợp cả trẻ em và người lớn, không chê bai ai, không chính trị. Có thể mới lạ, đừng lặp những chuyện quá phổ biến." },
  { id: "riddle", re: /do vui|cau do|giai do/, key: "đố vui",
    sys: "Hãy ra MỘT câu đố vui (đố mẹo hoặc kiến thức nhẹ nhàng) hợp cả gia đình. Chỉ nêu câu đố, KHÔNG nêu đáp án; cuối câu nhắn: nhắn 'đáp án' để xem. Nếu người dùng đang trả lời/hỏi đáp án thì cho đáp án kèm giải thích ngắn." },
  { id: "advice", re: /(xin|cho|can|muon|nhan|nho) (minh |em |toi )?(1 |mot )?(loi khuyen|y kien|tu van)|loi khuyen|khuyen (minh|em|toi)/, key: "lời khuyên",
    sys: "Người dùng xin lời khuyên về đời sống, gia đình, công việc, nuôi dạy con, các mối quan hệ hoặc tiền bạc nhỏ. Hãy trả lời như một người anh/chị từng trải, ấm áp, thực tế: nêu 2-3 ý chính ngắn gọn (không dài dòng), cân nhắc cả hai phía, gợi ý bước nhỏ làm được ngay, và kết bằng một câu hỏi mở nếu cần thêm thông tin. Không phán xét. Vấn đề sức khỏe/pháp lý nghiêm trọng: chỉ nêu hướng chung và khuyên gặp bác sĩ/luật sư/cơ quan chức năng." },
  { id: "vent", re: /tam su|tam trang|dang buon|buon qua|chan qua|chan doi|met moi qua|met qua|stress|ap luc|co don|nho (nha|ba|me)|that vong|lo lang|khong vui|khoc|tuc qua/, key: "tâm sự",
    sys: "Người dùng đang tâm sự hoặc buồn/mệt/áp lực. Hãy lắng nghe trước: đồng cảm chân thành bằng 1-2 câu, không vội khuyên, không giáo điều, không liệt kê. Sau đó hỏi nhẹ một câu để họ kể thêm, hoặc đưa MỘT gợi ý nhỏ dễ làm (hít thở, đi bộ, gọi người thân, nghỉ một chút). Giọng ấm như người nhà. Nếu có dấu hiệu muốn làm hại bản thân hoặc tuyệt vọng nặng: nhẹ nhàng khuyến khích nói với người thân tin cậy ngay và gọi tổng đài hỗ trợ/115 khi nguy cấp, ở lại trò chuyện cùng họ." },
  { id: "cheer", re: /dong vien|khich le|tiep (them )?nang luong|khen (minh|em|toi)|can dong luc/, key: "động viên",
    sys: "Hãy động viên người dùng bằng vài câu chân thành, cụ thể, tích cực nhưng không sáo rỗng, có thể kèm một câu nói hay ngắn gọn (nói rõ nếu là danh ngôn nổi tiếng, không bịa tác giả)." },
  { id: "topic", re: /(noi chuyen|tan gau|chat) (voi|cung) (minh|em|toi|bot)|ranh qua|chan qua noi chuyen|ke gi di|noi gi di|hom nay (co )?gi vui|co gi hay|noi chuyen di|tan gau di/, key: "tán gẫu",
    sys: "Hãy mở một câu chuyện tán gẫu thú vị cho gia đình: một câu hỏi vui, một sự thật thú vị ít người biết (chắc chắn đúng), hoặc một chủ đề đời thường gần gũi; ngắn 2-4 câu, kết bằng câu hỏi để người dùng trả lời." },
];

const CHAT_SYS = (env) =>
  `Bạn là ${env.BOT_NAME || "trợ lý gia đình"}, một thành viên vui tính, tinh tế trong nhà, nhắn tin qua Zalo cho gia đình anh Nhân. Trả lời tiếng Việt, tự nhiên như nói chuyện, câu ngắn, emoji vừa phải, không dùng Markdown/bảng, không giảng bài. Đùa tế nhị, không chê ai. ` +
  (env.BOT_PERSONA ? env.BOT_PERSONA + " " : "") +
  `Thời điểm hiện tại: ${nowDescription()}. Thông tin y khoa/pháp luật chỉ mang tính tham khảo.`;

export function chitchatMode(text) {
  const t = norm(text);
  if (t.length > 300) return null; // long messages are tasks, not chit-chat
  return MODES.find((m) => m.re.test(t)) || null;
}

export async function handleChitchat(env, { text, who }, send, history = []) {
  const t = norm(text);
  const mode = chitchatMode(text);
  if (!mode) return false;
  // "đáp án" follow-up for riddles uses recent history
  const hist = history.slice(-4).map((h) => `${h.role === "user" ? "Người dùng" : "Bot"}: ${h.content}`).join("\n");
  const user = (hist ? `Hội thoại gần đây:\n${hist}\n\n` : "") + `${who ? who + " nhắn" : "Tin nhắn"}: ${text}`;
  const out = await complete(env, CHAT_SYS(env) + "\n\nNhiệm vụ: " + mode.sys, user, {
    max_tokens: mode.id === "advice" ? 700 : 450,
    temperature: 0.9,
    tier: mode.id === "advice" || mode.id === "vent" ? "main" : "simple",
  });
  await send(out || "Mình đang nghĩ… bạn nói lại giúp mình nhé 🙂");
  return true;
}

// "bật chế độ trò chuyện" / "tắt chế độ trò chuyện" (group): bot joins in on questions without being called.
export async function handleListenToggle(env, { chatId, text, bot, isGroup }, send) {
  const t = norm(text);
  const on = /^(bat|mo) (che do )?(tu (tra loi|dong)|lang nghe|tro chuyen|tan gau)/.test(t);
  const off = /^(tat|dung) (che do )?(tu (tra loi|dong)|lang nghe|tro chuyen|tan gau)/.test(t);
  if (!on && !off) return false;
  if (!isGroup) {
    await send("Trong chat riêng mình luôn trả lời mọi tin nhắn rồi. Chế độ này dành cho nhóm: vào nhóm gõ \"bật chế độ trò chuyện\" nhé.");
    return true;
  }
  await setListening(env, bot, chatId, on);
  await send(
    on
      ? "Đã bật chế độ trò chuyện trong nhóm này 🙌 Mình sẽ tự chen vào khi có câu hỏi, xin lời khuyên hay tâm sự. Muốn tắt gõ \"tắt chế độ trò chuyện\". Gọi tên mình hoặc \"bot ...\" thì lúc nào mình cũng trả lời."
      : "Đã tắt chế độ trò chuyện. Giờ mình chỉ trả lời khi được gọi tên (bot, tên mình, @…)."
  );
  return true;
}
