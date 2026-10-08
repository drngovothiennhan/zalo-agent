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
    "INSERT INTO reminders (chat_id, text, due_at, repeat, author, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(String(chatId), text, dueAt, repeat || "none", author || "", Date.now())
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
    "SELECT id, chat_id, text, due_at, repeat FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50"
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
