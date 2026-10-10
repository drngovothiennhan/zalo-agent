// Small, pure checks on the wording of a message. No imports, testable with node.

const norm = (s) => String(s || "").toLowerCase().normalize("NFC");

// Polite lead-ins people put before a command: "hãy ghi nhớ …", "làm ơn nhắc tôi …"
const LEAD_IN = /^(hãy|hay|làm ơn|lam on|xin|giúp tôi|giúp mình)\s+/i;

// Removes a polite lead-in so the command word is first ("hãy ghi nhớ: X" -> "ghi nhớ: X")
export function stripLeadIn(text) {
  return String(text || "").trim().replace(LEAD_IN, "");
}

// The person points at a picture or file that is not in this message ("lịch thi trong hình này")
const POINTS_TO_MEDIA = /(hình|ảnh|hinh|anh|tranh|file|tài liệu|tài liệu|tệp)\s*(này|nè|đó|trên|vừa|kia|ở trên)|trong hình|trong ảnh|trong file/;

export function pointsToMissingMedia(text) {
  return POINTS_TO_MEDIA.test(norm(text));
}

// Zalo errors and rejections that mean "this provider cannot be used from here" (not a bad question)
export const LOCATION_BLOCKED = /location is not supported|FAILED_PRECONDITION/i;
