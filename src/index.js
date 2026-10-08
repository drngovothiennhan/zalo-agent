// Zalo family assistant — Cloudflare Worker
// Bindings: AI (Workers AI), DB (D1), FILES (R2)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET, GEMINI_API_KEY (optional)   Vars: ALLOWED_IDS, MODEL, WEATHER_CITY, BOT_NAME (optional)
import { DEBUG, trace, zalo, sendText, typing } from "./zalo.js";
import * as db from "./db.js";
import { chat, extractReminder } from "./brain.js";
import { parseLocal, formatLocal } from "./time.js";
import { describeImage } from "./vision.js";
import { searchKb, listDocs, handleKb } from "./kb.js";
import { makeFile, serveFile, weather, draw } from "./tools.js";

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
- Kho tài liệu bot tra cứu: "tài liệu"
- Bắt đầu cuộc trò chuyện mới: "/reset"`;

// Lowercase, strip Vietnamese diacritics, collapse spaces — for command matching only
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
    try {
      const f = await makeFile(env, origin, kind, request);
      await sendText(
        env,
        chatId,
        `Đã tạo xong: ${f.title}\nTải về: ${f.link}\n` +
          (kind === "word" ? "(Mở bằng Word/WPS; muốn sửa thì sửa thoải mái rồi lưu lại.)" : "(File CSV mở trực tiếp bằng Excel/Google Sheets.)")
      );
      await db.saveTurn(env, chatId, text, `[Đã tạo file ${kind}: ${f.title}]`);
    } catch (e) {
      trace("file.error", { message: String(e && e.message) });
      await sendText(env, chatId, "Mình chưa tạo được file, bạn thử lại sau ít phút nhé.");
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

  // ----- Knowledge base -----
  if (["tai lieu", "kho tai lieu", "xem tai lieu", "/kb", "/docs"].includes(n)) {
    const docs = await listDocs(env);
    const list = docs.length ? docs.map((d) => `- ${d.name} (${d.chunks} đoạn)`).join("\n") : "(chưa có tài liệu nào)";
    let msg = `Tài liệu bot đang tra cứu:\n${list}`;
    if (String(userId) === allowedIds(env)[0]) {
      msg += `\n\nThêm/xóa tài liệu tại (chỉ gửi cho bạn, đừng chia sẻ link này):\n${origin}/kb?key=${env.WEBHOOK_SECRET}`;
    }
    await sendText(env, chatId, msg);
    return true;
  }

  return false;
}

async function handleImage(env, ctx, msg) {
  const { chatId, who } = ctx;
  await typing(env, chatId);
  let reply;
  try {
    reply = await describeImage(env, { url: msg.photo_url, caption: msg.caption });
  } catch (e) {
    trace("vision.error", { message: String(e && e.message) });
    reply = "Mình chưa đọc được ảnh này (có thể đã hết hạn mức AI hôm nay). Bạn thử lại sau nhé.";
  }
  await sendText(env, chatId, reply);
  await db.saveTurn(env, chatId, `[${who || "Người dùng"} gửi một ảnh]${msg.caption ? " " + msg.caption : ""}`, reply);
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
    if (isGroup && !addressed(msg.caption)) return trace("skip", { reason: "group image not addressed to bot" });
    if (!msg.photo_url) return sendText(env, chatId, "Mình chưa nhận được ảnh, bạn gửi lại giúp mình nhé.");
    return handleImage(env, ctx, { ...msg, caption: isGroup ? clean(msg.caption) : msg.caption });
  }

  if (typeof msg.text !== "string" || !msg.text.trim()) {
    if (isGroup) return;
    await sendText(env, chatId, "Mình đọc được tin nhắn chữ và ảnh. Sticker, tin thoại, file thì chưa hỗ trợ.");
    return;
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
  },
};
