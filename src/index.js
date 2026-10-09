// Zalo family assistant — Cloudflare Worker
// Bindings: AI (Workers AI), DB (D1), FILES (R2)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET, GEMINI_API_KEY (optional)   Vars: ALLOWED_IDS, MODEL, WEATHER_CITY, BOT_NAME (optional)
import { DEBUG, trace, zalo, sendText, typing } from "./zalo.js";
import * as db from "./db.js";
import { chat, extractReminder } from "./brain.js";
import { parseLocal, formatLocal } from "./time.js";
import { describeImage } from "./vision.js";
import { searchKb, findTemplate, listDocs, handleKb, createDoc, addText, getDoc, docText, setKind, deleteDoc } from "./kb.js";
import { makeFile, serveFile, weather, draw } from "./tools.js";
import { isTemplate, wantsSave, cleanName, findFile, ingestImage, ingestFile, markLast, DOC_TYPES } from "./intake.js";
import { runSeed } from "./seed.js";
import SEED_MAU_UBND from "../seed/mau-ubnd-2026-10.json" with { type: "json" };

const DAY = 24 * 60 * 60 * 1000;
const REPEAT_LABEL = { none: "", daily: " (lặp lại mỗi ngày)", weekly: " (lặp lại mỗi tuần)" };

const HELP = `Mình là trợ lý của gia đình. Bạn có thể:
- Hỏi bất cứ điều gì: thực đơn, sức khỏe, bài vở, soạn văn bản…
- Gửi ảnh (kèm câu hỏi nếu muốn): đọc giấy tờ, đơn thuốc, bài tập của con, món ăn…
- Lưu thông tin chung: "ghi nhớ: bé An dị ứng tôm" · "xem ghi chú" · "xóa ghi chú 3"
- Nhắc việc: "nhắc tôi 7h sáng mai lấy mẫu thức ăn", "nhắc tôi 21h mỗi ngày uống thuốc" · "xem lịch nhắc" · "hủy nhắc 2"
- Thời tiết: "thời tiết", "thời tiết Đà Lạt"
- Tạo file: "tạo file word: biên bản kiểm tra bếp ăn tháng 10" · "tạo file excel: sổ theo dõi cân nặng 30 trẻ"
- Vẽ tranh: "vẽ chú mèo đội mũ phi hành gia"
- Nạp tài liệu/mẫu ngay trong chat:
  · Gửi ảnh chụp văn bản kèm chú thích "mẫu biên bản kiểm tra" (hoặc gửi ảnh rồi nhắn "đây là mẫu")
  · Nhiều trang: "nạp mẫu: Quyết định thành lập đoàn" → gửi lần lượt ảnh từng trang → "xong"
  · Dán chữ: "lưu mẫu: <tên>" xuống dòng rồi dán nội dung
  · "danh sách mẫu" · "xem mẫu 3" · "xóa mẫu 3" · "tài liệu" (xem tất cả, link trang tải file)
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
  if (/^(nhắc|\/remind)/.test(lower) && !/^nhắc lại\b/.test(lower)) {
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
    await sendText(env, chatId, `Đã đặt nhắc #${id}: "${r.task}" lúc ${formatLocal(due)}${REPEAT_LABEL[r.repeat] || ""}.`);
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
  const addressed = (s) => {
    const t = String(s || "");
    return t.includes("@") || t.startsWith("/") || norm(t).startsWith("bot");
  };
  const clean = (s) =>
    String(s || "")
      .split(`@${botName}`)
      .join(" ")
      .replace(/^bot[\s,:]*/i, "")
      .replace(/\s+/g, " ")
      .trim();
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
  if (isGroup) {
    // In a group, only answer when addressed: @mention, a /command, or starting with "bot"
    if (!addressed(text)) return trace("skip", { reason: "group message not addressed to bot" });
    text = clean(text) || text;
  }

  if (await handleCommand(env, { ...ctx, text })) return;

  await typing(env, chatId);
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
    await sendText(env, r.chat_id, `⏰ Nhắc việc: ${r.text}`);
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
    if (url.pathname === "/kb" || url.pathname.startsWith("/kb/")) return handleKb(request, env, url);

    // One-time helper: GET /setup?key=<WEBHOOK_SECRET> registers this host as the Zalo webhook.
    if (request.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const data = await zalo(env, "setWebhook", { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET });
      return Response.json(data);
    }

    // Diagnostics: GET /debug?key=<WEBHOOK_SECRET>
    if (request.method === "GET" && url.pathname === "/debug") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const [me, hook] = await Promise.all([zalo(env, "getMe"), zalo(env, "getWebhookInfo")]);
      let counts = null;
      try {
        counts = await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM reminders) AS reminders, (SELECT COUNT(*) FROM kb_docs) AS kb_docs"
        ).first();
      } catch (e) {
        counts = { error: String(e && e.message) };
      }
      return Response.json({
        config: {
          has_BOT_TOKEN: !!env.BOT_TOKEN,
          has_WEBHOOK_SECRET: !!env.WEBHOOK_SECRET,
          has_AI: !!env.AI,
          has_DB: !!env.DB,
          has_FILES: !!env.FILES,
          vision: env.GEMINI_API_KEY ? "gemini" : "workers-ai",
          ALLOWED_IDS: env.ALLOWED_IDS || env.OWNER_ID || "(trống)",
        },
        db: counts,
        getMe: me,
        getWebhookInfo: hook,
        events: DEBUG,
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const got = request.headers.get("X-Bot-Api-Secret-Token");
      const raw = await request.text();
      trace("webhook.in", { secret_ok: got === env.WEBHOOK_SECRET, body: raw.slice(0, 1500) });
      // Requests without the right secret get a plain "ok" (for Zalo's probe) but are never processed.
      if (got !== env.WEBHOOK_SECRET) return new Response("ok");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("ok");
      }
      const update = body.result || body;
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => trace("handle.error", { message: String(e && e.stack) })));
      return new Response("ok");
    }

    return new Response("Zalo agent is running.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((e) => trace("cron.error", { message: String(e && e.stack) })));
    ctx.waitUntil(runSeed(env, SEED_MAU_UBND).catch((e) => trace("seed.error", { message: String(e && e.stack) })));
  },
};
