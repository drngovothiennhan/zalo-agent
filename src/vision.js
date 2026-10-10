// Read images sent on Zalo: Gemini (if GEMINI_API_KEY is set) or Workers AI vision models
import { Buffer } from "node:buffer";
import { trace } from "./zalo.js";
import { logEvent } from "./db.js";
import { nowDescription } from "./time.js";
import { sniffImage, headHex } from "./imagecheck.js";
import { LOCATION_BLOCKED } from "./intent.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const VISION_PROMPT = `Bạn là trợ lý gia đình trên Zalo, đang xem một bức ảnh người dùng gửi. Thời điểm hiện tại: ${"{now}"}.
Trả lời bằng tiếng Việt, ngắn gọn, rõ ý, gạch đầu dòng khi liệt kê, không dùng bảng.
- Nếu ảnh có chữ (giấy tờ, sổ sách, đơn thuốc, bài tập, nhãn sản phẩm): chép lại phần chữ quan trọng rồi tóm tắt/giải thích.
- Nếu là bài tập của trẻ: hướng dẫn cách làm từng bước, khuyến khích trẻ tự làm.
- Nếu là món ăn/thực phẩm: nhận diện và nhận xét an toàn thực phẩm, dinh dưỡng khi phù hợp.
- Thông tin y khoa (đơn thuốc, kết quả xét nghiệm, da, vết thương…) chỉ mang tính tham khảo, không thay thế bác sĩ; dấu hiệu nguy hiểm thì khuyên đi khám ngay hoặc gọi 115.
- Chỗ nào nhìn không rõ thì nói rõ là không đọc được, không đoán bừa.`;

async function fetchImage(env, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tải ảnh lỗi HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("ảnh quá lớn");
  // Judge the file by its bytes, not by the header: a page or error body under the URL is not a picture
  const type = sniffImage(buf);
  if (!type) {
    const shown = (res.headers.get("content-type") || "không rõ").split(";")[0];
    await logEvent(env, "vision.not_image", JSON.stringify({ contentType: shown, bytes: buf.byteLength, head: headHex(buf) }));
    throw new Error("tệp tải về không phải ảnh JPEG/PNG/GIF/WebP");
  }
  return { buf, type };
}

async function geminiCall(env, model, system, question, img) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [
        {
          role: "user",
          parts: [{ inline_data: { mime_type: img.type, data: Buffer.from(img.buf).toString("base64") } }, { text: question }],
        },
      ],
      generationConfig: { maxOutputTokens: 1500 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function viaGemini(env, system, question, img) {
  let model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  let r = await geminiCall(env, model, system, question, img);
  // Retired model: Google names the replacement in the error ("use models/<name>"), retry once with it
  const suggested = !r.ok && /use models\/([\w.-]+)/.exec(JSON.stringify(r.data))?.[1];
  if (suggested && suggested !== model) {
    model = suggested;
    r = await geminiCall(env, model, system, question, img);
  }
  if (!r.ok) throw new Error(`Gemini ${r.status} (${model}): ${JSON.stringify(r.data).slice(0, 200)}`);
  const u = r.data.usageMetadata || {};
  await logEvent(env, "vision.usage", JSON.stringify({ via: "gemini", model, input: u.promptTokenCount, output: u.candidatesTokenCount, total: u.totalTokenCount }));
  return (r.data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

async function viaWorkersAI(env, system, question, img) {
  const model = env.VISION_MODEL || DEFAULT_VISION_MODEL;
  if (model.includes("llama-3.2")) {
    try {
      await env.AI.run(model, { prompt: "agree" }); // one-time license agreement
    } catch {
      /* already agreed */
    }
  }
  const out = await env.AI.run(model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    image: [...new Uint8Array(img.buf)],
    max_tokens: 1200,
  });
  const u = out?.usage || {};
  await logEvent(env, "vision.usage", JSON.stringify({ via: "workers-ai", model, input: u.prompt_tokens, output: u.completion_tokens, total: u.total_tokens }));
  return String(out?.response || out?.description || "").trim();
}

// Google refuses this Worker's region; once seen, skip Gemini for a while instead of failing every photo
let geminiSkipUntil = 0;

async function askImage(env, url, system, question) {
  const img = await fetchImage(env, url);
  if (env.GEMINI_API_KEY && Date.now() > geminiSkipUntil) {
    try {
      const text = await viaGemini(env, system, question, img);
      if (text) return text;
      throw new Error("Gemini trả về rỗng");
    } catch (e) {
      // Gemini quota/key/model problem: fall back to Workers AI instead of failing the photo
      const msg = String((e && e.message) || e);
      if (LOCATION_BLOCKED.test(msg)) geminiSkipUntil = Date.now() + 15 * 60 * 1000;
      trace("vision.gemini.error", { message: msg.slice(0, 300) });
      await logEvent(env, "vision.gemini.error", msg);
    }
  }
  try {
    return await viaWorkersAI(env, system, question, img);
  } catch (e) {
    await logEvent(env, "vision.workersai.error", String(e && e.message));
    throw e;
  }
}

export async function describeImage(env, { url, caption }) {
  const system = VISION_PROMPT.replace("{now}", nowDescription());
  const question = caption?.trim() || "Bạn xem giúp ảnh này có gì, và nếu có chữ thì đọc giúp nội dung chính.";
  const answer = await askImage(env, url, system, question);
  return answer || "Mình chưa đọc được ảnh này. Bạn thử chụp lại rõ hơn, đủ sáng và thẳng góc nhé.";
}

const TRANSCRIBE_PROMPT = `Bạn là công cụ chép văn bản từ ảnh chụp giấy tờ tiếng Việt.
Chép lại NGUYÊN VĂN toàn bộ chữ trong ảnh, đúng thứ tự từ trên xuống, xuống dòng theo bố cục của văn bản.
- Phần đầu văn bản có hai cột (tên cơ quan bên trái, quốc hiệu bên phải): chép cột trái trước rồi đến cột phải.
- Chỗ trống, dòng chấm để điền: ghi "…".
- Bảng: mỗi hàng một dòng, các ô ngăn cách bằng " | ".
- Không thêm lời bình, không sửa chính tả, không tóm tắt.
- Chữ nào không đọc được thì ghi [không rõ].
Nếu ảnh không có chữ, chỉ trả về: KHÔNG CÓ CHỮ`;

// Verbatim text of a photographed document page ("" if the photo has no text)
export async function transcribeImage(env, url) {
  const text = String((await askImage(env, url, TRANSCRIBE_PROMPT, "Chép lại toàn bộ chữ trong ảnh này.")) || "").trim();
  return /^KHÔNG CÓ CHỮ\.?$/i.test(text) ? "" : text;
}
