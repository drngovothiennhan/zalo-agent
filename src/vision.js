// Read images sent on Zalo: Gemini (if GEMINI_API_KEY is set) or Workers AI vision models
import { Buffer } from "node:buffer";
import { trace } from "./zalo.js";
import { nowDescription } from "./time.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const WORKERS_VISION_MODEL = "@cf/google/gemma-3-12b-it";
const FALLBACK_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const VISION_PROMPT = `Bạn là trợ lý gia đình trên Zalo, đang xem một bức ảnh người dùng gửi. Thời điểm hiện tại: ${"{now}"}.
Trả lời bằng tiếng Việt, ngắn gọn, rõ ý, gạch đầu dòng khi liệt kê, không dùng bảng.
- Nếu ảnh có chữ (giấy tờ, sổ sách, đơn thuốc, bài tập, nhãn sản phẩm): chép lại phần chữ quan trọng rồi tóm tắt/giải thích.
- Nếu là bài tập của trẻ: hướng dẫn cách làm từng bước, khuyến khích trẻ tự làm.
- Nếu là món ăn/thực phẩm: nhận diện và nhận xét an toàn thực phẩm, dinh dưỡng khi phù hợp.
- Thông tin y khoa (đơn thuốc, kết quả xét nghiệm, da, vết thương…) chỉ mang tính tham khảo, không thay thế bác sĩ; dấu hiệu nguy hiểm thì khuyên đi khám ngay hoặc gọi 115.
- Chỗ nào nhìn không rõ thì nói rõ là không đọc được, không đoán bừa.`;

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tải ảnh lỗi HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("ảnh quá lớn");
  const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  return { buf, type: type.startsWith("image/") ? type : "image/jpeg" };
}

async function viaGemini(env, system, question, img) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
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
  const data = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
}

async function viaWorkersAI(env, system, question, img) {
  const dataUrl = `data:${img.type};base64,${Buffer.from(img.buf).toString("base64")}`;
  try {
    const out = await env.AI.run(env.VISION_MODEL || WORKERS_VISION_MODEL, {
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 1200,
    });
    const text = typeof out?.response === "string" ? out.response : out?.choices?.[0]?.message?.content || "";
    if (text.trim()) return text.trim();
    throw new Error("empty response");
  } catch (e) {
    trace("vision.fallback", { model: env.VISION_MODEL || WORKERS_VISION_MODEL, message: String(e && e.message) });
  }
  // Fallback: Llama 3.2 Vision (needs a one-time license agreement)
  try {
    await env.AI.run(FALLBACK_VISION_MODEL, { prompt: "agree" });
  } catch {
    /* already agreed or not needed */
  }
  const out = await env.AI.run(FALLBACK_VISION_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: question },
    ],
    image: [...new Uint8Array(img.buf)],
    max_tokens: 1200,
  });
  return String(out?.response || out?.description || "").trim();
}

export async function describeImage(env, { url, caption }) {
  const img = await fetchImage(url);
  const system = VISION_PROMPT.replace("{now}", nowDescription());
  const question = caption?.trim() || "Bạn xem giúp ảnh này có gì, và nếu có chữ thì đọc giúp nội dung chính.";
  const answer = env.GEMINI_API_KEY ? await viaGemini(env, system, question, img) : await viaWorkersAI(env, system, question, img);
  return answer || "Mình chưa đọc được ảnh này. Bạn thử chụp lại rõ hơn, đủ sáng và thẳng góc nhé.";
}
