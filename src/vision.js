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

async function askImage(env, url, system, question) {
  const img = await fetchImage(url);
  return env.GEMINI_API_KEY ? viaGemini(env, system, question, img) : viaWorkersAI(env, system, question, img);
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
