// "Gợi ý hôm nay" for the morning brief: 0–3 short notes on what the family should watch,
// remember or set a reminder for today. Kept free of imports so it can be unit-tested with node.

export const DAILY_TIP_PROMPT = `Bạn là trợ lý gia đình, viết bằng tiếng Việt cho nhóm Zalo.
Dựa CHỈ trên thông tin hôm nay được cung cấp bên dưới, viết tối đa 3 gạch đầu dòng ngắn (mỗi dòng dưới 25 chữ) về điều cả nhà cần chú ý hoặc ghi nhớ hôm nay: ví dụ thời tiết cần mang theo đồ, ngày giỗ/sinh nhật/lễ sắp tới, việc đã có lịch nhắc, đồ cần mua.
Nếu có việc nên nhắc mà chưa có lịch nhắc, gợi ý đúng cú pháp: nhắc tôi <việc> lúc <giờ>.
Bỏ qua tin tức chung. Không bịa thông tin, không chẩn đoán hay khuyên dùng thuốc.
Nếu hôm nay không có gì đáng lưu ý, chỉ trả về đúng chữ: KHÔNG
Chỉ trả về các gạch đầu dòng hoặc chữ KHÔNG, không lời dẫn.`;

// raw: model output. Returns "" when there is nothing worth saying, otherwise a ready-to-send section.
export function formatDailyTip(raw) {
  const text = String(raw || "").trim();
  if (!text || /^KHÔNG\b/iu.test(text)) return "";
  const bullets = text
    .split("\n")
    .map((line) => line.replace(/^\s*[-•*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => `- ${line}`);
  if (!bullets.length) return "";
  return `💡 Gợi ý hôm nay:\n${bullets.join("\n")}`;
}
