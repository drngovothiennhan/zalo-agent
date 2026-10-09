// Zalo family assistant — Cloudflare Worker
// Bindings: AI (Workers AI), DB (D1), FILES (R2)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET, GEMINI_API_KEY (optional)   Vars: ALLOWED_IDS, MODEL, WEATHER_CITY, BOT_NAME (optional)
// More bots on the same Worker: see bots.js (e.g. BOT_TOKEN_BINBO, WEBHOOK_SECRET_BINBO, ALLOWED_IDS_BINBO)
import { DEBUG, trace, zalo, sendText, typing } from "./zalo.js";
import * as db from "./db.js";
import { chat, extractReminder } from "./brain.js";
import { wakeMatch, isListening, worthAnswering, handleChitchat, handleListenToggle } from "./chitchat.js";
import { parseLocal, formatLocal } from "./time.js";
import { describeImage } from "./vision.js";
import { searchKb, findTemplate, listDocs, handleKb, createDoc, addText, getDoc, docText, setKind, deleteDoc } from "./kb.js";
import { makeFile, serveFile, weather, draw } from "./tools.js";
import { isTemplate, wantsSave, cleanName, findFile, ingestImage, ingestFile, markLast, DOC_TYPES } from "./intake.js";
import { runSeed } from "./seed.js";
import { aiStatus } from "./llm.js";
import { BOTS, botById, botByPath, botEnv } from "./bots.js";
import { isWeatherQuestion, weatherPlace, needsLive, liveAnswer } from "./live.js";
import { alarmLink, handleAlarm } from "./alarm.js";
import { handleHousehold, runBriefs, runSpecialDayAlerts } from "./household.js";
import { handleFortune } from "./fortune.js";
import SEED_MAU_UBND from "../seed/mau-ubnd-2026-10.json" with { type: "json" };

const DAY = 24 * 60 * 60 * 1000;
const REPEAT_LABEL = { none: "", daily: " (lặp lại mỗi ngày)", weekly: " (lặp lại mỗi tuần)" };

const HELP = `Mình là trợ lý của gia đình. Bạn có thể:
- Hỏi bất cứ điều gì: thực đơn, sức khỏe, bài vở, soạn văn bản…
- Gửi ảnh (kèm câu hỏi nếu muốn): đọc giấy tờ, đơn thuốc, bài tập của con, món ăn…
- Lưu thông tin chung: "ghi nhớ: bé An dị ứng tôm" · "xem ghi chú" · "xóa ghi chú 3"
- Báo thức: "đặt báo thức 5h30 sáng mai" → bot gửi link để thêm chuông báo vào điện thoại
- Nhắc việc: "nhắc tôi 7h sáng mai lấy mẫu thức ăn", "nhắc tôi 21h mỗi ngày uống thuốc" · "xem lịch nhắc" · "hủy nhắc 2"
- Thời tiết: "thời tiết", "thời tiết Đà Lạt", hoặc hỏi tự nhiên "mai Đà Lạt có mưa không"
- Tin mới, giá cả: "tin tức hôm nay", "giá vàng hôm nay", "tỷ giá đô la", "giá xăng" (bot tra cứu trên mạng)
- Tạo file: "tạo file word: biên bản kiểm tra bếp ăn tháng 10" · "tạo file excel: sổ theo dõi cân nặng 30 trẻ"
- Vẽ tranh: "vẽ chú mèo đội mũ phi hành gia"
- Nạp tài liệu/mẫu ngay trong chat:
  · Gửi ảnh chụp văn bản kèm chú thích "mẫu biên bản kiểm tra" (hoặc gửi ảnh rồi nhắn "đây là mẫu")
  · Nhiều trang: "nạp mẫu: Quyết định thành lập đoàn" → gửi lần lượt ảnh từng trang → "xong"
  · Dán chữ: "lưu mẫu: <tên>" xuống dòng rồi dán nội dung
  · "danh sách mẫu" · "xem mẫu 3" · "xóa mẫu 3" · "tài liệu" (xem tất cả, link trang tải file)
- Đi chợ: "mua: trứng, sữa, rau" · "đi chợ" · "đã mua trứng" / "đã mua hết"
- Thu chi: "chi 50k rau" · "thu 10tr lương" · "chi tiêu tháng này" · "xuất chi tiêu" · "xóa chi 5"
- Ngày giỗ, sinh nhật: "giỗ ông nội 15/7" (âm lịch) · "sinh nhật bé An 20/11/2019" · "ngày đặc biệt" · "âm lịch"
- Bản tin sáng: "bật bản tin sáng 6h" · "bản tin" · "tắt bản tin sáng"
- Xem ngày, tuổi, gieo quẻ (tham khảo cho vui): "xem ngày mai" · "giờ hoàng đạo" · "ngày tốt tháng 11 tuổi 1990" · "xem tuổi 1990" · "hợp tuổi 1990 1993" · "gieo quẻ: có nên đổi việc không"
- Tán gẫu, xin lời khuyên: "kể chuyện cười", "đố vui", "xin lời khuyên: con không chịu ăn", "mình buồn quá, tâm sự chút", "động viên mình đi"
- Gọi bot không cần tag: bắt đầu bằng "bot ơi…" hoặc gọi tên bot (nhóm "Bin Bơ ơi…", "Tâm Phúc ơi…"). Trong nhóm, gõ "bật chế độ trò chuyện" để bot tự chen vào khi có câu hỏi (tắt: "tắt chế độ trò chuyện")
- Xem AI nào đang chạy: "trạng thái AI"
- Bắt đầu cuộc trò chuyện mới: "/reset"`;

// Lowercase, strip Vietnamese diacritics, collapse spaces — for command matching only
// Reject if the work takes longer than ms, so the handler always reaches its reply path
function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function allowedIds(env) {
  return String(env.ALLOWED_IDS || env.OWNER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Text after the first `wordCount` words, without a leading ":" or "-"
function afterCommand(original, wordCount) {
  const rest = original.trim().split(/\s+/).slice(wordCount).join(" ");
  return rest.replace(/^[:\-–\s]+/, "").trim();
}

// Text after the first ":" if present, otherwise after `wordCount` words
function payload(original, wordCount) {
  const i = original.indexOf(":");
  if (i >= 0 && i < 40) return original.slice(i + 1).trim();
  return afterCommand(original, wordCount);
}

async function handleCommand(env, ctx) {
  const { chatId, userId, text, who, origin } = ctx;
  const n = norm(text);
  const lower = text.toLowerCase().normalize("NFC");

  if (["/help", "/start", "huong dan", "tro giup", "help", "menu"].includes(n)) {
    await sendText(env, chatId, HELP);
    return true;
  }

  if (["/ai", "trang thai ai", "ai nao dang chay"].includes(n)) {
    await sendText(env, chatId, `Các AI của bot (dùng lần lượt, cái trước hết hạn mức thì chuyển sang cái sau):\n${aiStatus(env).join("\n")}`);
    return true;
  }

  // Shopping list, spending book, special days, morning brief
  if (await handleHousehold(env, ctx)) return true;
  // Folk almanac: good days, auspicious hours, I Ching, age reading
  if (await handleFortune(env, ctx, (msg) => sendText(env, chatId, msg))) return true;

  if (n === "/reset" || n === "xoa ngu canh") {
    await db.clearHistory(env, chatId);
    await sendText(env, chatId, "Đã xóa ngữ cảnh cuộc trò chuyện. Mình bắt đầu lại nhé!");
    return true;
  }

  // ----- Notes -----
  if (/^(ghi nho|\/note)\b/.test(n)) {
    const content = afterCommand(text, n.startsWith("/note") ? 1 : 2);
    if (!content) {
      await sendText(env, chatId, 'Bạn muốn ghi nhớ điều gì? Ví dụ: "ghi nhớ: bé An dị ứng tôm".');
      return true;
    }
    const id = await db.addNote(env, content, who);
    await sendText(env, chatId, `Đã ghi nhớ (#${id}): ${content}\nCả nhà hỏi bot đều dùng được thông tin này.`);
    return true;
  }
  if (["xem ghi chu", "/notes", "danh sach ghi chu", "ghi chu"].includes(n)) {
    const notes = await db.listNotes(env);
    if (!notes.length) {
      await sendText(env, chatId, 'Chưa có ghi chú nào. Thử: "ghi nhớ: lịch tiêm của bé vào thứ 7".');
    } else {
      const lines = notes.map((x) => `#${x.id} ${x.text}${x.author ? ` (${x.author})` : ""}`);
      await sendText(env, chatId, `Sổ ghi nhớ gia đình:\n${lines.join("\n")}\n\nXóa: "xóa ghi chú <số>"`);
    }
    return true;
  }
  let m = /^(?:xoa ghi chu|\/delnote)\s*#?(\d+)$/.exec(n);
  if (m) {
    const ok = await db.deleteNote(env, m[1]);
    await sendText(env, chatId, ok ? `Đã xóa ghi chú #${m[1]}.` : `Không tìm thấy ghi chú #${m[1]}.`);
    return true;
  }

  // ----- Reminders -----
  if (["xem lich nhac", "/reminders", "danh sach nhac", "lich nhac"].includes(n)) {
    const list = await db.listReminders(env, chatId);
    if (!list.length) {
      await sendText(env, chatId, 'Chưa có lịch nhắc nào. Thử: "nhắc tôi 7h sáng mai lấy mẫu thức ăn".');
    } else {
      const lines = list.map((r) => `#${r.id} ${formatLocal(r.due_at)}: ${r.text}${REPEAT_LABEL[r.repeat] || ""}`);
      await sendText(env, chatId, `Lịch nhắc:\n${lines.join("\n")}\n\nHủy: "hủy nhắc <số>"`);
    }
    return true;
  }
  m = /^(?:huy nhac|xoa nhac|\/unremind)\s*#?(\d+)$/.exec(n);
  if (m) {
    const ok = await db.deleteReminder(env, chatId, m[1]);
    await sendText(env, chatId, ok ? `Đã hủy nhắc #${m[1]}.` : `Không tìm thấy lịch nhắc #${m[1]}.`);
    return true;
  }
  if (
    (/^(nhắc|\/remind)/.test(lower) && !/^nhắc lại\b/.test(lower)) ||
    /^(?:đặt |cài |hẹn )?(báo thức|chuông báo|hẹn giờ|đánh thức)|^gọi (tôi|mình|em|anh|chị|con) dậy/.test(lower)
  ) {
    await typing(env, chatId);
    let r = null;
    try {
      r = await extractReminder(env, text);
    } catch (e) {
      trace("ai.error", { where: "extractReminder", message: String(e && e.message) });
    }
    if (!r) return false; // not a reminder after all -> normal chat
    let due = parseLocal(r.datetime);
    if (!due) {
      await sendText(env, chatId, 'Mình chưa hiểu thời gian cần nhắc. Bạn nói rõ hơn giúp mình, ví dụ: "nhắc tôi 7h sáng mai lấy mẫu thức ăn".');
      return true;
    }
    const now = Date.now();
    if (due < now - 60 * 1000) while (due < now) due += DAY; // time already passed -> next occurrence
    const id = await db.addReminder(env, { chatId, text: r.task, dueAt: due, repeat: r.repeat, author: who });
    await sendText(
      env,
      chatId,
      `Đã đặt nhắc #${id}: "${r.task}" lúc ${formatLocal(due)}${REPEAT_LABEL[r.repeat] || ""}. Đến giờ bot sẽ nhắn bạn.\n` +
        `Muốn điện thoại tự đổ chuông (kể cả không mở Zalo), bấm link này rồi chọn "Thêm vào Lịch điện thoại":\n${alarmLink(origin, { due, repeat: r.repeat, task: r.task })}`
    );
    return true;
  }

  // ----- Weather -----
  if (/^(thoi tiet|\/weather)\b/.test(n)) {
    const place = afterCommand(text.normalize("NFC"), n.startsWith("/weather") ? 1 : 2)
      .replace(/hôm nay|ngày mai|bây giờ|hiện tại|như thế nào|thế nào|ra sao|sao rồi|[?.!,]/gi, " ")
      .split(/\s+/)
      .filter((w) => w && !["ở", "tại", "thì", "sao", "nhỉ", "vậy"].includes(w.toLowerCase()))
      .join(" ");
    await typing(env, chatId);
    try {
      await sendText(env, chatId, await weather(env, place));
    } catch (e) {
      trace("weather.error", { message: String(e && e.message) });
      await sendText(env, chatId, "Mình chưa lấy được thông tin thời tiết, bạn thử lại sau nhé.");
    }
    return true;
  }

  // ----- Files -----
  m = /^(?:(?:tạo|soạn|làm|xuất)\s+(?:file|tệp|tập tin)\s+(word|excel)|\/(word|excel))\b/i.exec(lower);
  if (m) {
    const kind = (m[1] || m[2]).toLowerCase();
    const request = payload(text, m[1] ? 3 : 1);
    if (!request) {
      await sendText(env, chatId, `Bạn muốn tạo file ${kind} gì? Ví dụ: "tạo file ${kind}: ${kind === "word" ? "biên bản kiểm tra bếp ăn tháng 10" : "sổ theo dõi cân nặng 30 trẻ"}".`);
      return true;
    }
    await sendText(env, chatId, `Đang soạn file ${kind === "word" ? "Word" : "Excel"}, bạn chờ khoảng 20–40 giây nhé…`);
    const started = Date.now();
    trace("file.start", { kind, chars: request.length });
    try {
      // Prefer saved templates ("mẫu"), otherwise any related document
      let templates = kind === "word" ? await findTemplate(env, request) : [];
      if (kind === "word" && !templates.length) templates = await searchKb(env, request, 3, "mau");
      if (kind === "word" && !templates.length) templates = await searchKb(env, request, 2);
      // Hard limit so the user always gets a reply (the platform may kill a stalled request silently)
      const f = await withTimeout(makeFile(env, origin, kind, request, templates), 90_000, "soạn file quá lâu");
      trace("file.done", { kind, ms: Date.now() - started, templates: templates.length });
      await sendText(
        env,
        chatId,
        `Đã tạo xong: ${f.title}\nTải về: ${f.link}\n` +
          (f.usedTemplates?.length ? `Có tham khảo: ${f.usedTemplates.join(", ")}\n` : "") +
          (kind === "word"
            ? "(Bản nháp: mở bằng Word/WPS, điền các chỗ \"…\" và rà soát kỹ trước khi trình ký.)"
            : "(File CSV mở trực tiếp bằng Excel/Google Sheets.)")
      );
      await db.saveTurn(env, chatId, text, `[Đã tạo file ${kind}: ${f.title}]`);
    } catch (e) {
      trace("file.error", { kind, ms: Date.now() - started, message: String(e && e.message) });
      await sendText(env, chatId, `Mình chưa tạo được file (${String(e && e.message).slice(0, 80)}). Bạn thử lại với yêu cầu ngắn hơn hoặc sau ít phút nhé.`);
    }
    return true;
  }

  // ----- Drawing -----
  if (/^(vẽ|\/draw|\/ve|tạo ảnh|tạo hình)\s/.test(lower + " ")) {
    const request = lower.startsWith("tạo") ? afterCommand(text, 2) : afterCommand(text, 1);
    if (!request) {
      await sendText(env, chatId, 'Bạn muốn vẽ gì? Ví dụ: "vẽ chú mèo đội mũ phi hành gia".');
      return true;
    }
    await sendText(env, chatId, "Đang vẽ, bạn chờ chút nhé… 🎨");
    try {
      const url = await draw(env, origin, request);
      const sent = await zalo(env, "sendPhoto", { chat_id: chatId, photo: url, caption: request.slice(0, 200) });
      if (!sent.ok) await sendText(env, chatId, `Tranh đây: ${url}`);
    } catch (e) {
      trace("draw.error", { message: String(e && e.message) });
      await sendText(env, chatId, "Mình chưa vẽ được, có thể đã hết hạn mức AI hôm nay. Bạn thử lại sau nhé.");
    }
    return true;
  }

  // ----- Loading documents / templates from the chat -----
  const session = await db.getSession(env, chatId);
  if (session && ["xong", "/xong", "hoan tat", "da xong", "ket thuc"].includes(n)) {
    await db.endSession(env, chatId);
    const doc = await getDoc(env, session.doc_id);
    if (!doc || !doc.chunks) {
      if (doc) await deleteDoc(env, doc.id);
      await sendText(env, chatId, "Chưa có trang nào được lưu nên mình hủy tài liệu này.");
    } else {
      await sendText(env, chatId, `Đã lưu xong ${doc.kind === "mau" ? "mẫu" : "tài liệu"} #${doc.id}: ${doc.name} (${doc.chunks} đoạn).` + (doc.kind === "mau" ? `\nKhi cần, nhắn: "tạo file word: …" là mình bám theo mẫu này.` : ""));
    }
    return true;
  }

  m = /^(?:nạp|lưu|thêm)\s+(tài liệu mẫu|mẫu văn bản|văn bản mẫu|biểu mẫu|mẫu|tài liệu|văn bản)(?=[\s:]|$)([\s\S]*)$/i.exec(lower);
  if (m && !/[?？]\s*$/.test(lower)) {
    // Bare "mẫu" only counts when followed by ":" , nothing, or a document type ("lưu mẫu thức ăn" is a food sample!)
    const after = m[2].trim();
    if (m[1] === "mẫu" && after && !after.startsWith(":") && !new RegExp(`^(${DOC_TYPES})`).test(after)) m = null;
  } else m = null;
  if (m) {
    const kind = m[1] === "tài liệu" || m[1] === "văn bản" ? "doc" : "mau";
    const original = text.normalize("NFC");
    const rest = (m[1] === "mẫu" && !m[2].trim().startsWith(":") ? "mẫu " : "") + original.slice(original.length - m[2].length);
    const [firstLine, ...more] = rest.split("\n");
    const name = cleanName(firstLine, kind);
    const content = more.join("\n").trim();
    if (content.length > 40) {
      const docName = name || (kind === "mau" ? "Mẫu: " : "") + content.split("\n")[0].slice(0, 80);
      const id = await createDoc(env, docName, kind);
      const chunks = await addText(env, id, content);
      await db.setLastMedia(env, chatId, { name: docName, docId: id });
      await sendText(env, chatId, `Đã lưu ${kind === "mau" ? "mẫu" : "tài liệu"} #${id}: ${docName} (${chunks} đoạn).`);
      return true;
    }
    const docName = name || `${kind === "mau" ? "Mẫu" : "Tài liệu"} ${formatLocal(Date.now())}`;
    const id = await createDoc(env, docName, kind);
    await db.startSession(env, chatId, id, kind);
    await sendText(
      env,
      chatId,
      `Bắt đầu nạp ${kind === "mau" ? "mẫu" : "tài liệu"} #${id}: ${docName}\n` +
        `- Gửi lần lượt ảnh chụp từng trang (thẳng, rõ, đủ sáng), hoặc dán nội dung chữ.\n- Xong thì nhắn "xong".`
    );
    return true;
  }

  // Pasted text while an intake session is open -> append to that document
  if (session && text.length > 40 && !text.startsWith("/")) {
    await addText(env, session.doc_id, text);
    await db.touchSession(env, chatId);
    await sendText(env, chatId, `Đã thêm nội dung vào #${session.doc_id}. Gửi tiếp hoặc nhắn "xong".`);
    return true;
  }

  // "đây là mẫu …" / "đây là tài liệu …" right after sending a photo/file
  if (/^(đây là|đây cũng là|đánh dấu là|lưu làm|lưu cái này làm|cái này là)\s/.test(lower) && (/(tài liệu|văn bản)/.test(lower) || isTemplate(lower)) && !/[?？]\s*$/.test(lower)) {
    const kind = isTemplate(lower) ? "mau" : "doc";
    await typing(env, chatId);
    const r = await markLast(env, chatId, kind, cleanName(text.normalize("NFC"), kind));
    if (r.status === "none") {
      await sendText(env, chatId, 'Mình chưa thấy tài liệu nào bạn vừa gửi (trong 30 phút gần đây). Bạn gửi ảnh chụp văn bản, rồi nhắn lại "đây là mẫu…", hoặc nhắn "nạp mẫu: <tên>".');
    } else if (r.status === "notext") {
      await sendText(env, chatId, "Ảnh vừa gửi không có chữ đọc được nên mình chưa lưu. Bạn chụp lại văn bản thẳng và rõ hơn nhé.");
    } else {
      await sendText(env, chatId, `Đã ghi nhớ ${kind === "mau" ? "là tài liệu mẫu" : "vào kho tài liệu"} #${r.docId}: ${r.name}.` + (kind === "mau" ? `\nKhi cần, nhắn: "tạo file word: …" là mình bám theo mẫu này.` : ""));
    }
    return true;
  }

  if (["danh sach mau", "xem mau", "mau van ban", "cac mau", "/mau"].includes(n)) {
    const docs = await listDocs(env, "mau");
    await sendText(
      env,
      chatId,
      docs.length
        ? `Các mẫu văn bản đã lưu:\n${docs.map((d) => `#${d.id} ${d.name}`).join("\n")}\n\nXem: "xem mẫu <số>" · Xóa: "xóa mẫu <số>"`
        : 'Chưa có mẫu nào. Gửi ảnh chụp văn bản mẫu kèm chú thích "mẫu …", hoặc nhắn "nạp mẫu: <tên>".'
    );
    return true;
  }
  m = /^xem (mau|tai lieu|van ban) #?(\d+)$/.exec(n);
  if (m) {
    const doc = await getDoc(env, m[2]);
    if (!doc) {
      await sendText(env, chatId, `Không tìm thấy #${m[2]}.`);
    } else {
      const body = await docText(env, doc.id);
      await sendText(env, chatId, `${doc.kind === "mau" ? "Mẫu" : "Tài liệu"} #${doc.id}: ${doc.name}\n\n${body.slice(0, 1700)}${body.length > 1700 ? "\n…(còn tiếp)" : ""}`);
    }
    return true;
  }
  m = /^xoa (mau|tai lieu|van ban) #?(\d+)$/.exec(n);
  if (m) {
    const doc = await getDoc(env, m[2]);
    if (doc) await deleteDoc(env, doc.id);
    await sendText(env, chatId, doc ? `Đã xóa #${doc.id}: ${doc.name}.` : `Không tìm thấy #${m[2]}.`);
    return true;
  }
  m = /^(danh dau|dat lam|chuyen thanh) mau #?(\d+)$/.exec(n) || /^(bo mau) #?(\d+)$/.exec(n);
  if (m) {
    const kind = m[1] === "bo mau" ? "doc" : "mau";
    const ok = await setKind(env, m[2], kind);
    await sendText(env, chatId, ok ? (kind === "mau" ? `Đã đánh dấu #${m[2]} là mẫu.` : `Đã bỏ đánh dấu mẫu #${m[2]}.`) : `Không tìm thấy #${m[2]}.`);
    return true;
  }

  // ----- Knowledge base -----
  if (["tai lieu", "kho tai lieu", "xem tai lieu", "/kb", "/docs"].includes(n)) {
    const docs = await listDocs(env);
    const list = docs.length ? docs.map((d) => `#${d.id} ${d.kind === "mau" ? "📄 " : ""}${d.name} (${d.chunks} đoạn)`).join("\n") : "(chưa có tài liệu nào)";
    let msg = `Tài liệu bot đang tra cứu:\n${list}`;
    if (String(userId) === allowedIds(env)[0]) {
      msg += `\n\nThêm/xóa tài liệu tại (chỉ gửi cho bạn, đừng chia sẻ link này):\n${origin}/kb?key=${env.WEBHOOK_SECRET}`;
    }
    await sendText(env, chatId, msg);
    return true;
  }

  return false;
}

async function handleImage(env, ctx, msg, session) {
  const { chatId, who } = ctx;
  await typing(env, chatId);
  const lower = String(msg.caption || "").toLowerCase().normalize("NFC");

  // 1) An intake session is open, or 2) the caption asks to save it as a document/template
  if (session || wantsSave(lower)) {
    const kind = session ? session.kind : isTemplate(lower) ? "mau" : "doc";
    try {
      const r = await ingestImage(env, chatId, msg.photo_url, {
        kind,
        name: session ? "" : cleanName(msg.caption, kind),
        docId: session ? session.doc_id : null,
      });
      if (r) {
        if (session) {
          await db.touchSession(env, chatId);
          await sendText(env, chatId, `Đã thêm trang vào #${r.docId} (${r.chars} ký tự). Gửi tiếp trang sau, hoặc nhắn "xong".`);
        } else {
          await sendText(
            env,
            chatId,
            `Đã lưu ${kind === "mau" ? "mẫu" : "tài liệu"} #${r.docId}: ${r.name}\nMở đầu: "${r.preview.replace(/\s+/g, " ").slice(0, 160)}…"\n` +
              `Văn bản nhiều trang thì nhắn "nạp ${kind === "mau" ? "mẫu" : "tài liệu"}: <tên>" rồi gửi từng trang.` +
              (kind === "mau" ? "" : `\nNếu đây là văn bản mẫu, nhắn "đây là mẫu".`)
          );
        }
        return;
      }
      if (session) {
        await sendText(env, chatId, "Ảnh này không đọc được chữ, mình bỏ qua. Bạn chụp lại thẳng, rõ hơn nhé.");
        return;
      }
      // No text in the photo (e.g. "mẫu thức ăn") -> answer about the photo normally below
    } catch (e) {
      trace("intake.error", { message: String(e && e.message) });
      await sendText(env, chatId, "Mình chưa lưu được ảnh này (có thể đã hết hạn mức AI hôm nay). Bạn thử lại sau nhé.");
      return;
    }
  }

  let reply;
  try {
    reply = await describeImage(env, { url: msg.photo_url, caption: msg.caption });
  } catch (e) {
    trace("vision.error", { message: String(e && e.message) });
    await db.logEvent(env, "vision.error", String((e && (e.stack || e.message)) || e));
    reply = `Mình chưa đọc được ảnh này. Lỗi: ${String(e && e.message).slice(0, 120)}`;
  }
  await sendText(env, chatId, reply);
  await db.saveTurn(env, chatId, `[${who || "Người dùng"} gửi một ảnh]${msg.caption ? " " + msg.caption : ""}`, reply);
  // Remember it so "đây là mẫu…" can save it afterwards
  await db.setLastMedia(env, chatId, { url: msg.photo_url, mediaType: "image", name: "", docId: null });
}

// Files, stickers, voice… (Zalo marks most of these "unsupported")
async function handleOther(env, ctx, update, msg, isGroup, addressed) {
  const { chatId } = ctx;
  const event = String(update.event_name || "");
  if (event.includes("sticker")) return;
  await db.logEvent(env, event || "unknown", JSON.stringify(update));
  const file = findFile(msg);
  const lower = String(msg.caption || msg.text || "").toLowerCase().normalize("NFC");
  if (file) {
    if (isGroup && !addressed(lower)) return;
    const kind = isTemplate(lower) || /^mẫu/i.test(file.name.normalize("NFC")) ? "mau" : "doc";
    await sendText(env, chatId, `Đã nhận file${file.name ? ` "${file.name}"` : ""}, mình đang đọc và nạp vào kho tài liệu…`);
    try {
      const r = await ingestFile(env, chatId, file, kind);
      await sendText(
        env,
        chatId,
        `Đã nạp ${kind === "mau" ? "mẫu" : "tài liệu"} #${r.docId}: ${r.name}.` + (kind === "mau" ? "" : `\nNếu đây là văn bản mẫu, nhắn "đây là mẫu".`)
      );
    } catch (e) {
      trace("intake.error", { message: String(e && e.message) });
      await sendText(env, chatId, `Mình chưa đọc được file này (${String(e && e.message)}). Bạn thử gửi ảnh chụp từng trang, hoặc tải lên ở trang kho tài liệu (nhắn "tài liệu" để lấy link).`);
    }
    return;
  }
  if (isGroup) return;
  await sendText(
    env,
    chatId,
    "Zalo chưa chuyển nội dung tin này cho bot (bot đọc được chữ và ảnh; file, tin thoại thì Zalo hiện chưa hỗ trợ).\n" +
      'Muốn nạp tài liệu/mẫu: gửi ảnh chụp từng trang kèm chú thích "mẫu …", dán nội dung sau lệnh "lưu mẫu: <tên>", hoặc nhắn "tài liệu" để lấy link trang tải file.'
  );
}

async function handleUpdate(env, update, origin) {
  const msg = update?.message || update?.data?.message;
  if (!msg) return trace("skip", { reason: "no message field", keys: Object.keys(update || {}) });
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const isGroup = String(msg.chat?.chat_type || "").toUpperCase() === "GROUP";
  if (!chatId || msg.from?.is_bot) return trace("skip", { reason: "no chat id or from bot" });

  if (!allowedIds(env).includes(String(userId))) {
    if (isGroup) {
      // Only answer strangers in a group when they call the bot, so family members can get their ID
      const t = String(msg.text || msg.caption || "");
      if (!(t.includes("@") || t.startsWith("/") || norm(t).startsWith("bot"))) return trace("skip", { reason: "group sender not allowed", userId });
      const who = msg.from?.display_name || msg.from?.name || "bạn";
      await sendText(env, chatId, `${who} chưa có trong danh sách dùng bot. ID Zalo của ${who} là: ${userId}\nNhờ anh Nhân thêm ID này vào là dùng được nhé.`);
      return;
    }
    await sendText(
      env,
      chatId,
      `Xin chào! Bot này là trợ lý riêng của gia đình. ID Zalo của bạn là: ${userId}\nHãy gửi ID này cho anh Nhân để được thêm vào.`
    );
    return;
  }
  const who = msg.from?.display_name || msg.from?.name || "";
  const botName = env.BOT_NAME || "Bot Dr Tâm Phúc";
  // Called by: @mention, /command, "bot ...", or by the bot's own name / "trợ lý" (no tag needed)
  const addressed = (s) => {
    const t = String(s || "");
    return t.includes("@") || t.startsWith("/") || norm(t).startsWith("bot") || wakeMatch(t, botName) !== null;
  };
  const clean = (s) => {
    let t = String(s || "").split(`@${botName}`).join(" ").replace(/^bot[\s,:]*/i, "");
    const w = wakeMatch(t, botName);
    if (w !== null && !t.includes("@")) t = w;
    return t.replace(/\s+/g, " ").trim();
  };
  const ctx = { chatId, userId, who, origin };

  // Images
  if (msg.photo_url || update.event_name === "message.image.received") {
    const session = await db.getSession(env, chatId);
    if (isGroup && !session && !addressed(msg.caption)) return trace("skip", { reason: "group image not addressed to bot" });
    if (!msg.photo_url) return sendText(env, chatId, "Mình chưa nhận được ảnh, bạn gửi lại giúp mình nhé.");
    return handleImage(env, ctx, { ...msg, caption: isGroup ? clean(msg.caption) : msg.caption }, session);
  }

  if (typeof msg.text !== "string" || !msg.text.trim()) {
    return handleOther(env, ctx, update, msg, isGroup, addressed);
  }

  let text = msg.text.trim();
  let chatty = false; // group listening mode: answered without being called
  if (isGroup) {
    // In a group: answer when addressed (@, /command, "bot", or the bot's name), or when listening mode is on and it's a question
    if (!addressed(text)) {
      if (!(await isListening(env, env.BOT_ID, chatId)) || !worthAnswering(text)) return trace("skip", { reason: "group message not addressed to bot" });
      chatty = true;
    } else {
      text = clean(text) || text;
    }
  }

  if (!chatty && (await handleListenToggle(env, { chatId, text, bot: env.BOT_ID, isGroup }, (m) => sendText(env, chatId, m)))) return;
  if (!chatty && (await handleCommand(env, { ...ctx, text }))) return;

  // Chit-chat, jokes, riddles, advice, heart-to-heart
  {
    const history0 = await db.loadHistory(env, chatId);
    let handled = false;
    try {
      handled = await handleChitchat(env, { text, who }, async (m) => { await typing(env, chatId); const o = await sendText(env, chatId, m); await db.saveTurn(env, chatId, text, m); return o; }, history0);
    } catch (e) {
      trace("ai.error", { where: "chitchat", message: String(e && e.message) });
    }
    if (handled) return;
  }

  await typing(env, chatId);

  // Weather asked in plain words ("Đà Lạt mai có mưa không")
  if (isWeatherQuestion(text)) {
    let w;
    try {
      w = await weather(env, await weatherPlace(env, text));
    } catch (e) {
      trace("weather.error", { message: String(e && e.message) });
      w = "Mình chưa lấy được thông tin thời tiết, bạn thử lại sau nhé.";
    }
    await sendText(env, chatId, w);
    await db.saveTurn(env, chatId, text, w);
    return;
  }

  // News, prices, economy: look it up instead of answering from the AI's memory
  if (needsLive(text)) {
    let live;
    try {
      live = await liveAnswer(env, text);
    } catch (e) {
      trace("live.error", { message: String(e && e.message) });
      await db.logEvent(env, "live.error", String(e && e.message));
      live = "Mình chưa tra được tin mới lúc này, bạn thử lại sau ít phút nhé.";
    }
    await sendText(env, chatId, live);
    await db.saveTurn(env, chatId, text, live);
    return;
  }

  let reply;
  const [history, notes, kb] = await Promise.all([db.loadHistory(env, chatId), db.listNotes(env), searchKb(env, text)]);
  try {
    reply = await chat(env, { history, text, who, notes, kb });
  } catch (e) {
    trace("ai.error", { where: "chat", message: String(e && e.message) });
    reply = "Mình đang gặp lỗi khi suy nghĩ (có thể hết hạn mức AI hôm nay). Bạn thử lại sau ít phút nhé.";
  }
  await sendText(env, chatId, reply);
  await db.saveTurn(env, chatId, text, reply);
}

async function runReminders(env) {
  const now = Date.now();
  const due = await db.dueReminders(env, now);
  for (const r of due) {
    const benv = botEnv(env, botById(r.bot));
    if (!benv.BOT_TOKEN) {
      await db.removeReminder(env, r.id); // that bot is no longer configured
      continue;
    }
    await sendText(benv, r.chat_id, `⏰ Nhắc việc: ${r.text}`);
    if (r.repeat === "daily" || r.repeat === "weekly") {
      const step = r.repeat === "daily" ? DAY : 7 * DAY;
      let next = r.due_at;
      while (next <= now) next += step;
      await db.rescheduleReminder(env, r.id, next);
    } else {
      await db.removeReminder(env, r.id);
    }
  }
  if (due.length) trace("cron.reminders", { sent: due.length });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/f/") && request.method === "GET") return serveFile(env, url);
    if ((url.pathname === "/alarm" || url.pathname === "/alarm.ics") && request.method === "GET") return handleAlarm(url);
    if (url.pathname === "/kb" || url.pathname.startsWith("/kb/")) return handleKb(request, env, url);

    // One-time helper: GET /setup?key=<secret>[&bot=binbo] registers this host as that bot's Zalo webhook.
    // key = the owner's WEBHOOK_SECRET, or that bot's own webhook secret.
    if (request.method === "GET" && url.pathname === "/setup") {
      const bot = botById(url.searchParams.get("bot"));
      const secret = env[bot.secretVar];
      const key = url.searchParams.get("key");
      if (!key || (key !== env.WEBHOOK_SECRET && key !== secret)) return new Response("forbidden", { status: 403 });
      const benv = botEnv(env, bot);
      if (!benv.BOT_TOKEN || !secret) return Response.json({ ok: false, bot: bot.id, missing: [!benv.BOT_TOKEN && bot.tokenVar, !secret && bot.secretVar].filter(Boolean) });
      const data = await zalo(benv, "setWebhook", { url: `${url.origin}${bot.path}`, secret_token: secret });
      const out = { bot: bot.id, name: bot.name, webhook: `${url.origin}${bot.path}`, result: data };
      if (!data?.ok) {
        const me = await zalo(benv, "getMe");
        const t = benv.BOT_TOKEN;
        out.token_check = {
          valid: !!me?.ok,
          looks_like: `${t.length} ký tự, dạng ${/^\d+:[\w-]+$/.test(t) ? "<số>:<chuỗi> (đúng dạng)" : "KHÔNG đúng dạng <số>:<chuỗi>"}`,
          hint: me?.ok ? "Token đúng, Zalo từ chối webhook" : "Zalo không nhận token này: copy lại token Bin Bơ và dán lại vào BOT_TOKEN_BINBO",
        };
      }
      return Response.json(out);
    }

    // Diagnostics: GET /debug?key=<WEBHOOK_SECRET>
    if (request.method === "GET" && url.pathname === "/debug") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const dbot = botById(url.searchParams.get("bot"));
      const denv = botEnv(env, dbot);
      const [me, hook] = await Promise.all([zalo(denv, "getMe"), zalo(denv, "getWebhookInfo")]);
      let counts = null;
      try {
        counts = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM reminders) AS reminders, (SELECT COUNT(*) FROM kb_docs) AS kb_docs"
        ).first();
      } catch (e) {
        counts = { error: String(e && e.message) };
      }
      return Response.json({
        bot: dbot.id,
        bots: Object.values(BOTS).map((b) => ({ id: b.id, name: b.name, webhook: b.path, has_token: !!env[b.tokenVar], has_secret: !!env[b.secretVar] })),
        config: {
          has_BOT_TOKEN: !!denv.BOT_TOKEN,
          has_WEBHOOK_SECRET: !!env.WEBHOOK_SECRET,
          has_AI: !!env.AI,
          has_DB: !!env.DB,
          has_FILES: !!env.FILES,
          vision: env.GEMINI_API_KEY ? "gemini" : "workers-ai",
          ALLOWED_IDS: denv.ALLOWED_IDS || "(trống)",
        },
        db: counts,
        getMe: me,
        getWebhookInfo: hook,
        events: DEBUG,
      });
    }

    const hookBot = request.method === "POST" ? botByPath(url.pathname) : null;
    if (hookBot) {
      const secret = env[hookBot.secretVar];
      const got = request.headers.get("X-Bot-Api-Secret-Token");
      const raw = await request.text();
      trace("webhook.in", { bot: hookBot.id, secret_ok: !!secret && got === secret, body: raw.slice(0, 1500) });
      // Requests without the right secret get a plain "ok" (for Zalo's probe) but are never processed.
      if (!secret || got !== secret) return new Response("ok");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("ok");
      }
      const update = body.result || body;
      ctx.waitUntil(handleUpdate(botEnv(env, hookBot), update, url.origin).catch((e) => trace("handle.error", { message: String(e && e.stack) })));
      return new Response("ok");
    }

    return new Response("Zalo agent is running.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((e) => trace("cron.error", { message: String(e && e.stack) })));
    ctx.waitUntil(runBriefs(env).catch((e) => trace("brief.error", { message: String(e && e.stack) })));
    ctx.waitUntil(runSpecialDayAlerts(env).catch((e) => trace("specialdays.error", { message: String(e && e.stack) })));
    ctx.waitUntil(runSeed(env, SEED_MAU_UBND).catch((e) => trace("seed.error", { message: String(e && e.stack) })));
  },
};
