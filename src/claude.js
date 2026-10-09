// Anthropic Messages API helpers (Claude Haiku 5.5 by default). No imports, so they can be tested with node.
// Sampling temperature is deliberately not sent: the default keeps requests valid on every model version.

export const CLAUDE_DEFAULT_MODEL = "claude-haiku-5-5";

// messages: [{role: system|user|assistant, content}] -> body for POST /v1/messages
export function claudeRequestBody(messages, { max_tokens = 600, model = CLAUDE_DEFAULT_MODEL } = {}) {
  const system = messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => String(m.content))
    .join("\n\n");

  // Messages API wants user/assistant turns only, starting with a user turn, with no two in a row of the same role
  const merged = [];
  for (const m of messages) {
    if (m.role === "system" || !m.content) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content);
    const last = merged[merged.length - 1];
    if (last && last.role === role) last.content += "\n\n" + content;
    else merged.push({ role, content });
  }
  if (!merged.length || merged[0].role !== "user") merged.unshift({ role: "user", content: "Hãy trả lời theo ngữ cảnh trên." });

  const body = { model, max_tokens, messages: merged };
  if (system) body.system = system;
  return body;
}

// Response: content is a list of blocks; only text blocks are the answer
export function claudeText(data) {
  return (data?.content || [])
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();
}
