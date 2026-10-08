// Zalo family assistant — Cloudflare Worker
// Bindings: AI (Workers AI), DB (D1)   Secrets: BOT_TOKEN, WEBHOOK_SECRET   Vars: ALLOWED_IDS, MODEL (optional)
import { DEBUG, trace, zalo, sendText, typing } from "./zalo.js";
import * as db from "./db.js";
import { chat, extractReminder } from "./brain.js";
import { parseLocal, formatLocal } from "./time.js";

const DAY = 24 * 60 * 60 * 1000;
const REPEAT_LABEL = { none: "", daily: " (lặp lại mỗi ngày)", weekly: " (lặp lại mỗi tuần)" };

const HELP = `Mình là trợ lý của gia đình. Bạn có thể:
- Hỏi bất cứ điều gì: thực đơn, sức khỏe, bài vở, soạn văn bản…
- Lưu thông tin chung: "ghi nhớ: bé An dị ứng tôm"
- Xem / xóa ghi chú: "xem ghi chú", "xóa ghi chú 3"
- Đặt nhắc việc: "nhắc tôi 7h sáng mai lấy mẫu thức ăn", "nhắc tôi 21h mỗi ngày uống thuốc"
- Xem / hủy nhắc: "xem lịch nhắc", "hủy nhắc 2"
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

// Remove the leading command words ("ghi nhớ:", "/note") from the original text
function afterCommand(original, wordCount) {
  const rest = original.trim().split(/\s+/).slice(wordCount).join(" ");
  return rest.replace(/^[:\-–\s]+/, "").trim();
}

async function handleCommand(env, { chatId, text, who }) {
  const n = norm(text);

  if (["/help", "/start", "huong dan", "tro giup", "help"].includes(n)) {
    await sendText(env, chatId, HELP);
    return true;
  }

  if (n === "/reset" || n === "xoa ngu canh") {
    await db.clearHistory(env, chatId);
    await sendText(env, chatId, "Đã xóa ngữ cảnh cuộc trò chuyện. Mình bắt đầu lại nhé!");
    return true;
  }

  // Notes
  if (/^(ghi nho|\/note)\b/.test(n)) {
    const words = n.startsWith("/note") ? 1 : 2;
    const content = afterCommand(text, words);
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

  // Reminders
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
  if (/^(nhac|\/remind)\b/.test(n) && !/^nhac lai\b/.test(n)) {
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
    if (due < now - 60 * 1000) {
      // Time already passed: move to the next occurrence
      while (due < now) due += DAY;
    }
    const id = await db.addReminder(env, { chatId, text: r.task, dueAt: due, repeat: r.repeat, author: who });
    await sendText(env, chatId, `Đã đặt nhắc #${id}: "${r.task}" lúc ${formatLocal(due)}${REPEAT_LABEL[r.repeat] || ""}.`);
    return true;
  }

  return false;
}

async function handleUpdate(env, update) {
  const msg = update?.message || update?.data?.message;
  if (!msg) return trace("skip", { reason: "no message field", keys: Object.keys(update || {}) });
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const isGroup = String(msg.chat?.chat_type || "").toUpperCase() === "GROUP";
  if (!chatId || msg.from?.is_bot) return trace("skip", { reason: "no chat id or from bot" });

  if (!allowedIds(env).includes(String(userId))) {
    if (isGroup) return trace("skip", { reason: "group sender not allowed", userId });
    await sendText(
      env,
      chatId,
      `Xin chào! Bot này là trợ lý riêng của gia đình. ID Zalo của bạn là: ${userId}\nHãy gửi ID này cho anh Nhân để được thêm vào.`
    );
    return;
  }
  const who = msg.from?.display_name || msg.from?.name || "";

  if (typeof msg.text !== "string" || !msg.text.trim()) {
    if (isGroup) return;
    await sendText(env, chatId, "Hiện mình chỉ đọc được tin nhắn chữ. Đọc ảnh sẽ có ở bản cập nhật tới.");
    return;
  }

  let text = msg.text.trim();
  if (isGroup) {
    // In a group, only answer when addressed: @mention, a /command, or starting with "bot"
    const n = norm(text);
    if (!(text.includes("@") || text.startsWith("/") || n.startsWith("bot"))) return trace("skip", { reason: "group message not addressed to bot" });
    const botName = env.BOT_NAME || "Bot Dr Tâm Phúc";
    text = text.split(`@${botName}`).join(" ").replace(/^bot[\s,:]*/i, "").replace(/\s+/g, " ").trim() || text;
  }

  if (await handleCommand(env, { chatId, text, who })) return;

  await typing(env, chatId);
  let reply;
  const [history, notes] = await Promise.all([db.loadHistory(env, chatId), db.listNotes(env)]);
  try {
    reply = await chat(env, { history, text, who, notes });
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
          "SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM reminders) AS reminders"
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
      ctx.waitUntil(handleUpdate(env, update).catch((e) => trace("handle.error", { message: String(e && e.stack) })));
      return new Response("ok");
    }

    return new Response("Zalo agent is running.");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).catch((e) => trace("cron.error", { message: String(e && e.stack) })));
  },
};
