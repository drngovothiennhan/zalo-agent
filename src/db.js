// D1 data access: chat history, family notes, reminders
const HISTORY_LIMIT = 20; // messages loaded as context (10 turns)
const HISTORY_KEEP = 60; // messages kept per chat

export async function loadHistory(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
  )
    .bind(String(chatId), HISTORY_LIMIT)
    .all();
  return results.reverse();
}

export async function saveTurn(env, chatId, userText, reply) {
  const now = Date.now();
  const id = String(chatId);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)").bind(id, userText, now),
    env.DB.prepare("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").bind(id, reply, now),
    env.DB.prepare(
      "DELETE FROM messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)"
    ).bind(id, id, HISTORY_KEEP),
  ]);
}

export async function clearHistory(env, chatId) {
  await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(String(chatId)).run();
}

export async function addNote(env, text, author) {
  const r = await env.DB.prepare("INSERT INTO notes (text, author, created_at) VALUES (?, ?, ?)")
    .bind(text, author || "", Date.now())
    .run();
  return r.meta.last_row_id;
}

export async function listNotes(env) {
  const { results } = await env.DB.prepare("SELECT id, text, author FROM notes ORDER BY id DESC LIMIT 200").all();
  return results;
}

export async function deleteNote(env, id) {
  const r = await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(Number(id)).run();
  return r.meta.changes > 0;
}

export async function addReminder(env, { chatId, text, dueAt, repeat, author }) {
  const r = await env.DB.prepare(
    "INSERT INTO reminders (chat_id, text, due_at, repeat, author, created_at, bot) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(String(chatId), text, dueAt, repeat || "none", author || "", Date.now(), env.BOT_ID || "main")
    .run();
  return r.meta.last_row_id;
}

export async function listReminders(env, chatId) {
  const { results } = await env.DB.prepare(
    "SELECT id, text, due_at, repeat FROM reminders WHERE chat_id = ? ORDER BY due_at LIMIT 50"
  )
    .bind(String(chatId))
    .all();
  return results;
}

export async function deleteReminder(env, chatId, id) {
  const r = await env.DB.prepare("DELETE FROM reminders WHERE id = ? AND chat_id = ?").bind(Number(id), String(chatId)).run();
  return r.meta.changes > 0;
}

export async function dueReminders(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT id, chat_id, text, due_at, repeat, bot FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50"
  )
    .bind(now)
    .all();
  return results;
}

export async function rescheduleReminder(env, id, dueAt) {
  await env.DB.prepare("UPDATE reminders SET due_at = ? WHERE id = ?").bind(dueAt, Number(id)).run();
}

export async function removeReminder(env, id) {
  await env.DB.prepare("DELETE FROM reminders WHERE id = ?").bind(Number(id)).run();
}

// ----- Template/document intake state -----
const SESSION_MS = 20 * 60 * 1000;

export async function startSession(env, chatId, docId, kind) {
  await env.DB.prepare("INSERT OR REPLACE INTO sessions (chat_id, doc_id, kind, expires_at) VALUES (?, ?, ?, ?)")
    .bind(String(chatId), Number(docId), kind, Date.now() + SESSION_MS)
    .run();
}

export async function getSession(env, chatId) {
  const s = await env.DB.prepare("SELECT doc_id, kind, expires_at FROM sessions WHERE chat_id = ?").bind(String(chatId)).first();
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}

export async function touchSession(env, chatId) {
  await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE chat_id = ?").bind(Date.now() + SESSION_MS, String(chatId)).run();
}

export async function endSession(env, chatId) {
  await env.DB.prepare("DELETE FROM sessions WHERE chat_id = ?").bind(String(chatId)).run();
}

export async function setLastMedia(env, chatId, { url, mediaType, name, docId }) {
  await env.DB.prepare("INSERT OR REPLACE INTO last_media (chat_id, url, media_type, name, doc_id, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(String(chatId), url || null, mediaType || null, name || null, docId ?? null, Date.now())
    .run();
}

// Most recent photo/file/document from this chat, if within 30 minutes
export async function getLastMedia(env, chatId) {
  const m = await env.DB.prepare("SELECT url, media_type, name, doc_id, at FROM last_media WHERE chat_id = ?").bind(String(chatId)).first();
  if (!m || Date.now() - m.at > 30 * 60 * 1000) return null;
  return m;
}

// Raw copy of events the bot does not understand yet (for diagnosis), keeps the last 50
export async function logEvent(env, kind, body) {
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO event_log (kind, body, created_at) VALUES (?, ?, ?)").bind(kind, String(body).slice(0, 4000), Date.now()),
      env.DB.prepare("DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT 50)"),
    ]);
  } catch {
    /* diagnostics only */
  }
}
