// Keeps track of who said what in a shared chat (family group). Pure: no imports, testable with node.
//
// Stored history is one list per chat, so every user line carries the speaker's name ("Thiện Nhân: ...");
// otherwise the model cannot tell family members apart and may answer the wrong person.

export const UNKNOWN_SPEAKER = "Người nhà";

// "Mẹ: mai ăn gì?" — the name is kept as typed, the text is unchanged
export function tagSpeaker(who, text) {
  const name = String(who || "").trim();
  const body = String(text || "");
  if (!name) return body;
  return `${name}: ${body}`;
}

// Name used in replies when the platform gives no display name
export function speakerName(who) {
  return String(who || "").trim() || UNKNOWN_SPEAKER;
}

// Instruction added to the system prompt so replies go to the right person
export function speakerRule(who) {
  const name = speakerName(who);
  return (
    `\nLịch sử có thể gồm nhiều thành viên trong nhà. Mỗi dòng của người dùng bắt đầu bằng tên người đã nói (ví dụ "Mẹ: ..."). ` +
    `Chỉ trả lời người đang nhắn tin là ${name}, xưng hô theo tên hoặc quan hệ của họ, không trả lời thay người khác và không gộp câu hỏi của nhiều người. ` +
    `Nếu câu hỏi cần thông tin của người khác, hỏi lại họ.`
  );
}
