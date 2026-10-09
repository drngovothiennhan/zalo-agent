// Vietnamese folk almanac (for reference and fun): good/bad days, auspicious hours, I Ching coin oracle, age reading.
// Uses the lunar calendar in lunar.js. Rules follow common lịch vạn niên tables:
//  - day Can Chi from the Julian day number; 12 "đạo" stars (Thanh Long… Câu Trận) by lunar month and day branch
//  - giờ hoàng đạo: "Dần Thân gia Tý, Mão Dậu gia Dần, Thìn Tuất tầm Thìn, Tỵ Hợi Ngọ thượng, Tý Ngọ lâm Thân, Sửu Mùi Tuất"
//  - Tam nương (3, 7, 13, 18, 22, 27) and Nguyệt kỵ (5, 14, 23) lunar days
//  - nạp âm of the 60-year cycle, tam hợp / lục hợp / lục xung / lục hại / tứ hành xung, tam tai, kim lâu
import { jdFromDate, jdToDate, solarToLunar } from "./lunar.js";
import { localParts } from "./time.js";
import { runText } from "./llm.js";

export const CAN = ["Giáp", "Ất", "Bính", "Đinh", "Mậu", "Kỷ", "Canh", "Tân", "Nhâm", "Quý"];
export const CHI = ["Tý", "Sửu", "Dần", "Mão", "Thìn", "Tỵ", "Ngọ", "Mùi", "Thân", "Dậu", "Tuất", "Hợi"];
const ANIMAL = ["Chuột", "Trâu", "Hổ", "Mèo", "Rồng", "Rắn", "Ngựa", "Dê", "Khỉ", "Gà", "Chó", "Lợn"];
const HOURS = ["23h–1h", "1h–3h", "3h–5h", "5h–7h", "7h–9h", "9h–11h", "11h–13h", "13h–15h", "15h–17h", "17h–19h", "19h–21h", "21h–23h"];
const STARS = [
  ["Thanh Long", true],
  ["Minh Đường", true],
  ["Thiên Hình", false],
  ["Chu Tước", false],
  ["Kim Quỹ", true],
  ["Thiên Đức (Bảo Quang)", true],
  ["Bạch Hổ", false],
  ["Ngọc Đường", true],
  ["Thiên Lao", false],
  ["Huyền Vũ", false],
  ["Tư Mệnh", true],
  ["Câu Trận", false],
];
// Branch where Thanh Long starts: by lunar month for days, by day branch for hours
const DAY_START = { 1: 0, 7: 0, 2: 2, 8: 2, 3: 4, 9: 4, 4: 6, 10: 6, 5: 8, 11: 8, 6: 10, 12: 10 };
const HOUR_START = { 2: 0, 8: 0, 3: 2, 9: 2, 4: 4, 10: 4, 5: 6, 11: 6, 0: 8, 6: 8, 1: 10, 7: 10 };
const TAM_NUONG = [3, 7, 13, 18, 22, 27];
const NGUYET_KY = [5, 14, 23];
const NAP_AM = [
  "Hải Trung Kim", "Lư Trung Hỏa", "Đại Lâm Mộc", "Lộ Bàng Thổ", "Kiếm Phong Kim", "Sơn Đầu Hỏa",
  "Giản Hạ Thủy", "Thành Đầu Thổ", "Bạch Lạp Kim", "Dương Liễu Mộc", "Tuyền Trung Thủy", "Ốc Thượng Thổ",
  "Tích Lịch Hỏa", "Tùng Bách Mộc", "Trường Lưu Thủy", "Sa Trung Kim", "Sơn Hạ Hỏa", "Bình Địa Mộc",
  "Bích Thượng Thổ", "Kim Bạch Kim", "Phú Đăng Hỏa", "Thiên Hà Thủy", "Đại Trạch Thổ", "Thoa Xuyến Kim",
  "Tang Đố Mộc", "Đại Khê Thủy", "Sa Trung Thổ", "Thiên Thượng Hỏa", "Thạch Lựu Mộc", "Đại Hải Thủy",
];
const ELEMENT_OF = (napAm) => napAm.split(" ").pop(); // Kim, Mộc, Thủy, Hỏa, Thổ
const SINH = { Kim: "Thủy", Thủy: "Mộc", Mộc: "Hỏa", Hỏa: "Thổ", Thổ: "Kim" };
const KHAC = { Kim: "Mộc", Mộc: "Thổ", Thổ: "Thủy", Thủy: "Hỏa", Hỏa: "Kim" };
// Tam tai years by tam hợp group (keyed by branch % 4)
const TAM_TAI = { 0: [2, 3, 4], 2: [8, 9, 10], 3: [5, 6, 7], 1: [11, 0, 1] };

export const NOTE = "(Theo lịch vạn niên dân gian, chỉ để tham khảo cho vui, không thay cho quyết định của bạn.)";

// ---------- days ----------
export function dayInfo(d, m, y) {
  const jd = jdFromDate(d, m, y);
  const can = (jd + 9) % 10;
  const chi = (jd + 1) % 12;
  const lunar = solarToLunar(d, m, y);
  const star = STARS[(chi - DAY_START[lunar.month] + 12) % 12];
  const hStart = HOUR_START[chi];
  const goodHours = [];
  for (let h = 0; h < 12; h++) if (STARS[(h - hStart + 12) % 12][1]) goodHours.push(h);
  const monthCan = (lunar.year * 12 + lunar.month + 3) % 10;
  const monthChi = (lunar.month + 1) % 12;
  return {
    d, m, y, jd, can, chi, lunar,
    dayName: `${CAN[can]} ${CHI[chi]}`,
    monthName: `${CAN[monthCan]} ${CHI[monthChi]}`,
    yearName: `${CAN[(lunar.year + 6) % 10]} ${CHI[(lunar.year + 8) % 12]}`,
    star: star[0],
    good: star[1],
    tamNuong: TAM_NUONG.includes(lunar.day),
    nguyetKy: NGUYET_KY.includes(lunar.day),
    goodHours,
    clashChi: (chi + 6) % 12,
    clashCan: can < 4 ? (can + 6) % 10 : can >= 6 ? can - 6 : null, // Giáp–Canh, Ất–Tân, Bính–Nhâm, Đinh–Quý
  };
}

export function dayShort(info) {
  return `Ngày ${info.dayName} — ${info.good ? "hoàng đạo" : "hắc đạo"} (${info.star}). Giờ tốt: ${info.goodHours.map((h) => CHI[h]).join(", ")}.`;
}

function relation(a, b) {
  if (a === b) return "cùng chi";
  if ((a + b) % 12 === 1) return "lục hợp";
  if (a % 4 === b % 4) return "tam hợp";
  if ((a - b + 12) % 12 === 6) return "lục xung";
  if ((a + b) % 12 === 7) return "lục hại";
  if (a % 3 === b % 3) return "tứ hành xung";
  return "bình thường";
}
const GOOD_REL = ["lục hợp", "tam hợp"];
const BAD_REL = ["lục xung", "lục hại", "tứ hành xung"];

export function dayText(info, birthYear = null) {
  const l = info.lunar;
  const warn = [];
  if (info.tamNuong) warn.push("ngày Tam nương (dân gian kiêng việc lớn)");
  if (info.nguyetKy) warn.push("ngày Nguyệt kỵ (dân gian kiêng đi xa, khởi sự)");
  const verdict = info.good && !warn.length ? "Ngày tốt" : info.good ? "Ngày hoàng đạo nhưng có điều kiêng" : "Ngày xấu (hắc đạo), việc lớn nên chọn ngày khác";
  const lines = [
    `📆 ${pad(info.d)}/${pad(info.m)}/${info.y} — âm lịch ${l.day}/${l.month}${l.leap ? " (nhuận)" : ""} năm ${info.yearName}`,
    `Ngày ${info.dayName}, tháng ${info.monthName}`,
    `${info.good ? "✅" : "⚠️"} ${info.good ? "Hoàng đạo" : "Hắc đạo"}: sao ${info.star}. ${verdict}.`,
    ...(warn.length ? [`Lưu ý: ${warn.join("; ")}.`] : []),
    `🕐 Giờ hoàng đạo: ${info.goodHours.map((h) => `${CHI[h]} (${HOURS[h]})`).join(", ")}`,
    `Tuổi xung với ngày: tuổi ${CHI[info.clashChi]}${info.clashCan !== null ? ` (nhất là ${CAN[info.clashCan]} ${CHI[info.clashChi]})` : ""}.`,
  ];
  if (birthYear) {
    const bc = (birthYear + 8) % 12;
    const rel = relation(bc, info.chi);
    const tag = GOOD_REL.includes(rel) ? "hợp, thuận lợi" : BAD_REL.includes(rel) ? "không hợp, việc lớn nên tránh" : "bình thường";
    lines.push(`Với tuổi ${CAN[(birthYear + 6) % 10]} ${CHI[bc]} (${birthYear}): ${rel} với ngày → ${tag}.`);
  }
  lines.push(NOTE);
  return lines.join("\n");
}

const pad = (n) => String(n).padStart(2, "0");

// Good days in a window: hoàng đạo, not Tam nương / Nguyệt kỵ, not clashing with the given age
export function goodDays(startJd, count, birthYear = null) {
  const out = [];
  const bc = birthYear ? (birthYear + 8) % 12 : null;
  for (let i = 0; i < count; i++) {
    const [d, m, y] = jdToDate(startJd + i);
    const info = dayInfo(d, m, y);
    if (!info.good || info.tamNuong || info.nguyetKy) continue;
    if (bc !== null && BAD_REL.includes(relation(bc, info.chi))) continue;
    out.push(info);
  }
  return out;
}

// ---------- ages ----------
export function ageInfo(y) {
  const can = (y + 6) % 10;
  const chi = (y + 8) % 12;
  const napAm = NAP_AM[Math.floor((((y - 4) % 60) + 60) % 60 / 2)];
  return { y, can, chi, name: `${CAN[can]} ${CHI[chi]}`, animal: ANIMAL[chi], napAm, element: ELEMENT_OF(napAm) };
}

export function ageText(y, now = Date.now()) {
  const a = ageInfo(y);
  const p = localParts(now);
  const ly = solarToLunar(p.d, p.mo, p.y).year;
  const cur = ageInfo(ly);
  const tuoiMu = ly - y + 1;
  const group = [0, 1, 2, 3].map((k) => (a.chi % 4) + 4 * k).filter((c) => c < 12 && c !== a.chi);
  const hop = CHI[(13 - a.chi) % 12];
  const xung = [0, 1, 2, 3].map((k) => (a.chi % 3) + 3 * k).filter((c) => c !== a.chi);
  const tamTai = TAM_TAI[a.chi % 4].includes(cur.chi);
  const kimLau = [1, 3, 6, 8].includes(tuoiMu % 9);
  const thaiTue = cur.chi === a.chi ? "phạm Thái tuế (năm tuổi)" : (cur.chi - a.chi + 12) % 12 === 6 ? "xung Thái tuế" : "";
  return [
    `🐾 Sinh năm ${y}: tuổi ${a.name} (con ${a.animal}), mệnh ${a.napAm} (hành ${a.element}).`,
    `- Tam hợp: ${group.map((c) => CHI[c]).join(", ")} · Lục hợp: ${hop}`,
    `- Tứ hành xung: ${xung.map((c) => CHI[c]).join(", ")} · Lục xung: ${CHI[(a.chi + 6) % 12]}`,
    `- Mệnh ${a.element} được ${Object.keys(SINH).find((k) => SINH[k] === a.element)} sinh, sinh ra ${SINH[a.element]}; khắc ${KHAC[a.element]}, bị ${Object.keys(KHAC).find((k) => KHAC[k] === a.element)} khắc.`,
    `Năm ${cur.name} (${ly}): tuổi mụ ${tuoiMu}.${tamTai ? " Gặp hạn Tam tai." : ""}${kimLau ? " Phạm Kim lâu (dân gian kiêng cưới hỏi, làm nhà)." : ""}${thaiTue ? ` ${thaiTue[0].toUpperCase() + thaiTue.slice(1)}.` : ""}${!tamTai && !kimLau && !thaiTue ? " Không phạm Tam tai, Kim lâu hay Thái tuế." : ""}`,
    NOTE,
  ].join("\n");
}

export function matchText(y1, y2) {
  const a = ageInfo(y1);
  const b = ageInfo(y2);
  let score = 0;
  const notes = [];
  const rel = relation(a.chi, b.chi);
  if (GOOD_REL.includes(rel)) score += 2;
  if (BAD_REL.includes(rel)) score -= 2;
  notes.push(`- Địa chi ${CHI[a.chi]} – ${CHI[b.chi]}: ${rel}`);
  let el = "bình hòa (cùng hành)";
  if (SINH[a.element] === b.element || SINH[b.element] === a.element) {
    el = "tương sinh";
    score += 2;
  } else if (KHAC[a.element] === b.element || KHAC[b.element] === a.element) {
    el = "tương khắc";
    score -= 2;
  } else if (a.element !== b.element) el = "bình thường";
  notes.push(`- Mệnh ${a.element} (${a.napAm}) – ${b.element} (${b.napAm}): ${el}`);
  const dc = Math.abs(a.can - b.can);
  let can = "bình thường";
  if (dc === 5) {
    can = "tương hợp";
    score += 1;
  } else if (dc === 6 && Math.min(a.can, b.can) < 4) {
    can = "tương xung";
    score -= 1;
  }
  notes.push(`- Thiên can ${CAN[a.can]} – ${CAN[b.can]}: ${can}`);
  const verdict = score >= 3 ? "Rất hợp 💞" : score >= 1 ? "Khá hợp" : score >= -1 ? "Bình thường, hợp hay không do cách sống với nhau" : "Không hợp lắm theo sách, cần nhường nhịn nhau";
  return [`💑 ${y1} (${a.name}) và ${y2} (${b.name}): ${verdict}`, ...notes, NOTE].join("\n");
}

// ---------- I Ching ----------
// King Wen order: [name, "upper lower" trigrams (Thiên, Địa, Lôi, Phong, Thủy, Hỏa, Sơn, Trạch), tag, meaning]
const TRIGRAM_LINES = { Thiên: "111", Trạch: "110", Hỏa: "101", Lôi: "100", Phong: "011", Thủy: "010", Sơn: "001", Địa: "000" }; // bottom → top
const HEX = [
  ["Thuần Càn", "Thiên Thiên", "cát", "Cương kiện, hanh thông. Chủ động tiến lên, nhưng tránh kiêu ngạo."],
  ["Thuần Khôn", "Địa Địa", "cát", "Nhu thuận, bao dung. Kiên nhẫn, đi theo người dẫn đường thì thuận lợi."],
  ["Thủy Lôi Truân", "Thủy Lôi", "hung", "Gian nan buổi đầu. Đừng vội, cần tìm người giúp sức."],
  ["Sơn Thủy Mông", "Sơn Thủy", "bình", "Còn mờ tối, non nớt. Nên học hỏi, hỏi ý người hiểu biết."],
  ["Thủy Thiên Nhu", "Thủy Thiên", "bình", "Chờ đợi. Thời cơ chưa tới, kiên nhẫn thì được việc."],
  ["Thiên Thủy Tụng", "Thiên Thủy", "hung", "Tranh chấp. Nên hòa giải, nhường một bước, tránh kiện tụng."],
  ["Địa Thủy Sư", "Địa Thủy", "bình", "Tập hợp lực lượng. Cần kỷ luật và người dẫn dắt chính đáng."],
  ["Thủy Địa Tỷ", "Thủy Địa", "cát", "Thân cận, hợp tác. Tốt cho gắn kết, tìm người đồng lòng."],
  ["Phong Thiên Tiểu Súc", "Phong Thiên", "bình", "Tích lũy từng chút. Kiềm chế, chưa phải lúc làm việc lớn."],
  ["Thiên Trạch Lý", "Thiên Trạch", "bình", "Đi đúng lễ. Thận trọng, giữ phép tắc thì bình an."],
  ["Địa Thiên Thái", "Địa Thiên", "cát", "Thông suốt, hanh thông. Trên dưới hòa hợp, mọi việc thuận."],
  ["Thiên Địa Bĩ", "Thiên Địa", "hung", "Bế tắc. Tạm lùi, giữ mình, chờ thời."],
  ["Thiên Hỏa Đồng Nhân", "Thiên Hỏa", "cát", "Đồng lòng với người. Tốt cho hợp tác, việc chung."],
  ["Hỏa Thiên Đại Hữu", "Hỏa Thiên", "cát", "Có nhiều, sung túc. Thành công, nên giữ khiêm tốn."],
  ["Địa Sơn Khiêm", "Địa Sơn", "cát", "Khiêm tốn. Càng nhún nhường càng thuận lợi."],
  ["Lôi Địa Dự", "Lôi Địa", "cát", "Vui vẻ, sẵn sàng. Thuận lợi, nhưng đừng ham vui quá đà."],
  ["Trạch Lôi Tùy", "Trạch Lôi", "cát", "Thuận theo. Theo thời thế và người đúng thì tốt."],
  ["Sơn Phong Cổ", "Sơn Phong", "bình", "Sửa chữa đổ nát. Có việc cũ cần chấn chỉnh, bắt tay sửa thì nên."],
  ["Địa Trạch Lâm", "Địa Trạch", "cát", "Tiến tới. Thời vận đang lên, nên hành động."],
  ["Phong Địa Quán", "Phong Địa", "bình", "Quan sát. Xem xét kỹ trước khi làm."],
  ["Hỏa Lôi Phệ Hạp", "Hỏa Lôi", "bình", "Cắn hợp, phân xử. Có trở ngại, cần dứt khoát giải quyết."],
  ["Sơn Hỏa Bí", "Sơn Hỏa", "bình", "Trang sức, vẻ ngoài. Chăm hình thức nhưng đừng quên thực chất."],
  ["Sơn Địa Bác", "Sơn Địa", "hung", "Suy tàn, bóc mòn. Không nên tiến, lo giữ gìn."],
  ["Địa Lôi Phục", "Địa Lôi", "cát", "Trở lại. Khởi đầu mới, phục hồi dần dần."],
  ["Thiên Lôi Vô Vọng", "Thiên Lôi", "bình", "Không càn bậy. Thành thật, làm đúng thì tốt; mưu mẹo thì hỏng."],
  ["Sơn Thiên Đại Súc", "Sơn Thiên", "cát", "Tích lớn. Tích đủ lực, có thể làm việc lớn."],
  ["Sơn Lôi Di", "Sơn Lôi", "bình", "Nuôi dưỡng. Giữ gìn ăn uống, lời nói, chăm lo bản thân."],
  ["Trạch Phong Đại Quá", "Trạch Phong", "hung", "Quá mức. Gánh nặng quá sức, cần điều chỉnh."],
  ["Thuần Khảm", "Thủy Thủy", "hung", "Hiểm trở chồng chất. Giữ lòng thành và bình tĩnh để vượt qua."],
  ["Thuần Ly", "Hỏa Hỏa", "cát", "Sáng sủa, nương tựa. Dựa vào điều chính đáng thì sáng tỏ."],
  ["Trạch Sơn Hàm", "Trạch Sơn", "cát", "Cảm ứng. Tốt cho tình cảm, hôn nhân, giao hảo."],
  ["Lôi Phong Hằng", "Lôi Phong", "cát", "Bền lâu. Kiên trì, giữ nếp lâu dài thì tốt."],
  ["Thiên Sơn Độn", "Thiên Sơn", "bình", "Lui ẩn. Nên lùi một bước để giữ mình."],
  ["Lôi Thiên Đại Tráng", "Lôi Thiên", "cát", "Mạnh mẽ. Có sức, nhưng tránh nóng vội, hung hăng."],
  ["Hỏa Địa Tấn", "Hỏa Địa", "cát", "Tiến lên. Thăng tiến, được trọng dụng."],
  ["Địa Hỏa Minh Di", "Địa Hỏa", "hung", "Ánh sáng bị che. Gặp tiểu nhân, nên kín đáo, nhẫn nại."],
  ["Phong Hỏa Gia Nhân", "Phong Hỏa", "cát", "Người nhà. Chăm lo gia đạo, trong ấm ngoài êm."],
  ["Hỏa Trạch Khuê", "Hỏa Trạch", "hung", "Trái ý, chia lìa. Bất đồng; việc nhỏ thì còn được."],
  ["Thủy Sơn Kiển", "Thủy Sơn", "hung", "Gian nan. Gặp trở ngại, nên tự xét mình và tìm người giúp."],
  ["Lôi Thủy Giải", "Lôi Thủy", "cát", "Cởi bỏ. Khó khăn được tháo gỡ, nên hành động sớm."],
  ["Sơn Trạch Tổn", "Sơn Trạch", "bình", "Bớt đi. Chịu thiệt trước, được lợi sau."],
  ["Phong Lôi Ích", "Phong Lôi", "cát", "Tăng thêm. Có lợi, nên tiến hành việc lớn."],
  ["Trạch Thiên Quải", "Trạch Thiên", "bình", "Quyết đoán. Dứt khoát loại bỏ điều xấu."],
  ["Thiên Phong Cấu", "Thiên Phong", "bình", "Gặp gỡ bất ngờ. Cẩn thận với người mới quen."],
  ["Trạch Địa Tụy", "Trạch Địa", "cát", "Tụ họp. Tốt cho gặp mặt, tập hợp mọi người."],
  ["Địa Phong Thăng", "Địa Phong", "cát", "Đi lên. Thăng tiến từ từ, thuận lợi."],
  ["Trạch Thủy Khốn", "Trạch Thủy", "hung", "Khốn đốn. Giữ vững ý chí rồi sẽ qua."],
  ["Thủy Phong Tỉnh", "Thủy Phong", "bình", "Cái giếng. Ổn định, lo sửa sang nền tảng."],
  ["Trạch Hỏa Cách", "Trạch Hỏa", "cát", "Thay đổi. Đúng lúc cải cách, làm mới."],
  ["Hỏa Phong Đỉnh", "Hỏa Phong", "cát", "Cái vạc. Thành tựu, ổn định, đổi mới tốt."],
  ["Thuần Chấn", "Lôi Lôi", "bình", "Sấm động. Có việc bất ngờ, giữ bình tĩnh thì qua."],
  ["Thuần Cấn", "Sơn Sơn", "bình", "Dừng lại. Biết dừng đúng lúc là khôn."],
  ["Phong Sơn Tiệm", "Phong Sơn", "cát", "Tiến dần. Từ từ mà tiến, tốt cho hôn nhân."],
  ["Lôi Trạch Quy Muội", "Lôi Trạch", "hung", "Việc không đúng danh phận dễ hỏng. Thận trọng."],
  ["Lôi Hỏa Phong", "Lôi Hỏa", "cát", "Thịnh vượng. Đang lúc thịnh, lo giữ được lâu."],
  ["Hỏa Sơn Lữ", "Hỏa Sơn", "bình", "Lữ khách. Đi xa; việc nhỏ thì tốt, nên khiêm nhường."],
  ["Thuần Tốn", "Phong Phong", "bình", "Gió, thuận nhập. Mềm mỏng, khéo léo thì có lợi."],
  ["Thuần Đoài", "Trạch Trạch", "cát", "Vui đẹp. Vui vẻ, giao tiếp thuận lợi."],
  ["Phong Thủy Hoán", "Phong Thủy", "bình", "Ly tán. Cần gắn kết mọi người lại."],
  ["Thủy Trạch Tiết", "Thủy Trạch", "bình", "Tiết chế. Biết giới hạn, chi tiêu có chừng mực."],
  ["Phong Trạch Trung Phu", "Phong Trạch", "cát", "Thành tín. Giữ chữ tín thì mọi việc tốt."],
  ["Lôi Sơn Tiểu Quá", "Lôi Sơn", "bình", "Hơi quá. Việc nhỏ được, việc lớn chưa nên."],
  ["Thủy Hỏa Ký Tế", "Thủy Hỏa", "cát", "Đã xong. Việc đã thành, đề phòng về sau."],
  ["Hỏa Thủy Vị Tế", "Hỏa Thủy", "bình", "Chưa xong. Sắp thành, cẩn thận đến phút cuối."],
];
const HEX_BY_LINES = {};
HEX.forEach((h, i) => {
  const [upper, lower] = h[1].split(" ");
  HEX_BY_LINES[TRIGRAM_LINES[lower] + TRIGRAM_LINES[upper]] = i;
});

const coin = () => (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 3 : 2);

// Three-coin method: 6 = old yin (moving), 7 = young yang, 8 = young yin, 9 = old yang (moving)
export function castHexagram(rand = coin) {
  const throws = Array.from({ length: 6 }, () => rand() + rand() + rand());
  const lines = throws.map((t) => (t === 7 || t === 9 ? "1" : "0")).join("");
  const moving = throws.map((t, i) => (t === 6 || t === 9 ? i + 1 : 0)).filter(Boolean);
  const changed = throws.map((t) => (t === 9 ? "0" : t === 6 ? "1" : t === 7 ? "1" : "0")).join("");
  return { lines, moving, main: HEX_BY_LINES[lines], changed: moving.length ? HEX_BY_LINES[changed] : null };
}

const TAG = { cát: "Cát (tốt)", hung: "Hung (xấu)", bình: "Bình (trung bình)" };

export async function oracleText(env, question = "", rand = coin) {
  const c = castHexagram(rand);
  const m = HEX[c.main];
  const draw = c.lines
    .split("")
    .map((b, i) => (b === "1" ? "▅▅▅▅▅" : "▅▅  ▅▅") + (c.moving.includes(i + 1) ? " ○" : ""))
    .reverse()
    .join("\n");
  const parts = [
    `☯️ Gieo quẻ${question ? `: "${question}"` : ""}`,
    draw,
    `Quẻ ${c.main + 1}: ${m[0]} — ${TAG[m[2]]}\n${m[3]}`,
  ];
  if (c.changed !== null) {
    const b = HEX[c.changed];
    parts.push(`Hào động: ${c.moving.join(", ")} → biến sang quẻ ${c.changed + 1}: ${b[0]} — ${TAG[b[2]]}\n${b[3]}`);
  }
  if (question) {
    try {
      const reading = await runText(
        env,
        [
          {
            role: "system",
            content:
              "Bạn giải quẻ Kinh Dịch theo lối dân gian, giọng nhẹ nhàng, tích cực, 3-4 câu tiếng Việt, không Markdown. Chỉ dựa vào ý nghĩa quẻ được cho. Không phán chắc chắn tương lai; với chuyện sức khỏe, tiền bạc lớn, pháp lý thì nhắc nên hỏi người có chuyên môn.",
          },
          { role: "user", content: `Câu hỏi: ${question}\nQuẻ chủ: ${m[0]} (${m[2]}): ${m[3]}${c.changed !== null ? `\nQuẻ biến: ${HEX[c.changed][0]} (${HEX[c.changed][2]}): ${HEX[c.changed][3]}` : ""}` },
        ],
        { max_tokens: 300, temperature: 0.7, tier: "simple" }
      );
      if (reading) parts.push(`Lời giải: ${reading}`);
    } catch {
      /* the traditional meaning alone is enough */
    }
  }
  parts.push(NOTE);
  return parts.join("\n\n");
}

// ---------- command router ----------
const strip = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function todayParts(now = Date.now()) {
  const p = localParts(now);
  return [p.d, p.mo, p.y];
}

// "hôm nay" / "mai" / "ngày kia" / "20/10" / "20/10/2026" -> [d, m, y]
function pickDate(arg, now = Date.now()) {
  const [d0, m0, y0] = todayParts(now);
  const jd0 = jdFromDate(d0, m0, y0);
  if (/ngay kia|mot/.test(arg)) return jdToDate(jd0 + 2);
  if (/\bmai\b/.test(arg)) return jdToDate(jd0 + 1);
  const m = /(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{4}))?/.exec(arg);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : y0;
    if (!m[3] && jdFromDate(d, mo, y) < jd0 - 1) y += 1; // "20/1" in October means next January
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return [d, mo, y];
  }
  return [d0, m0, y0];
}

const birthYearIn = (s) => {
  const m = /(?:tuoi|sinh nam|nam sinh|cho)\s*(19\d{2}|20\d{2})|\b(19\d{2}|20\d{2})\b/.exec(s);
  const y = m ? Number(m[1] || m[2]) : null;
  return y && y >= 1900 && y <= 2100 ? y : null;
};

export async function handleFortune(env, { text }, send) {
  const n = strip(text);
  let m;

  // Matching two ages: "hợp tuổi 1990 1992", "1990 và 1993 có hợp không"
  m = /(?:hop tuoi|xem tuoi|tuoi)\D*(19\d{2}|20\d{2})\D+(19\d{2}|20\d{2})/.exec(n) || /^(19\d{2}|20\d{2})\s*(?:va|voi|-)\s*(19\d{2}|20\d{2})\s*(?:co )?hop/.exec(n);
  if (m) {
    await send(matchText(Number(m[1]), Number(m[2])));
    return true;
  }
  // One age: "xem tuổi 1990", "tuổi 1985 mệnh gì", "mệnh 1990"
  m = /^(?:xem tuoi|tuoi|xem menh|menh|tu vi|xem tu vi)\s*(?:nam\s*)?(19\d{2}|20\d{2})/.exec(n) || /^(19\d{2}|20\d{2}) (?:la )?(?:tuoi|menh) (?:gi|con gi)/.exec(n);
  if (m) {
    await send(ageText(Number(m[1])));
    return true;
  }
  // I Ching: "gieo quẻ", "xin quẻ: có nên đổi việc không"
  m = /^(?:gieo que|xin que|boc que|xem que|xin 1 que|xin mot que)\b/.exec(n);
  if (m) {
    const q = text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : text.replace(/^\s*(gieo|xin|bốc|xem)\s+(một |1 )?quẻ\s*/i, "").trim();
    await send(await oracleText(env, q.slice(0, 200)));
    return true;
  }
  // Good days in a month / next 30 days: "ngày tốt tháng này", "chọn ngày tốt tháng 11 tuổi 1990 để khai trương"
  m = /^(?:xem |chon |tim |cac |nhung )?(?:ngay tot|ngay dep|ngay hoang dao)(?!\s*xau)(.*)$/.exec(n);
  if (m) {
    const arg = m[1];
    const [d0, m0, y0] = todayParts();
    let start = jdFromDate(d0, m0, y0);
    let count = 30;
    let label = "30 ngày tới";
    const mm = /thang\s*(\d{1,2})(?:\s*[/-]\s*(\d{4}))?/.exec(arg);
    if (mm) {
      const mo = Number(mm[1]);
      const y = mm[2] ? Number(mm[2]) : mo < m0 ? y0 + 1 : y0;
      const first = jdFromDate(1, mo, y);
      const next = mo === 12 ? jdFromDate(1, 1, y + 1) : jdFromDate(1, mo + 1, y);
      start = Math.max(first, mo === m0 && y === y0 ? start : first);
      count = next - start;
      label = `tháng ${mo}/${y}`;
    } else if (/thang nay/.test(arg)) {
      const next = m0 === 12 ? jdFromDate(1, 1, y0 + 1) : jdFromDate(1, m0 + 1, y0);
      count = next - start;
      label = `tháng ${m0}/${y0}`;
    }
    const by = birthYearIn(arg);
    const days = goodDays(start, count, by);
    const wd = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
    const lines = days.slice(0, 12).map((i) => {
      const w = wd[(i.jd + 1) % 7];
      return `- ${w} ${pad(i.d)}/${pad(i.m)} (${i.lunar.day}/${i.lunar.month} âm): ${i.dayName}, ${i.star}`;
    });
    await send(
      days.length
        ? `🌟 Ngày tốt ${label}${by ? ` cho tuổi ${by}` : ""} (hoàng đạo, tránh Tam nương, Nguyệt kỵ${by ? ", ngày xung tuổi" : ""}):\n${lines.join("\n")}${days.length > 12 ? `\n… và ${days.length - 12} ngày khác` : ""}\n\nXem chi tiết một ngày: "xem ngày 20/10"${by ? "" : '\nThêm tuổi để lọc ngày xung: "ngày tốt tháng này tuổi 1990"'}\n${NOTE}`
        : `Không tìm thấy ngày tốt trong ${label}${by ? ` cho tuổi ${by}` : ""}. ${NOTE}`
    );
    return true;
  }
  // One day: "xem ngày", "xem ngày mai", "xem ngày 20/10 tuổi 1990", "hôm nay tốt hay xấu", "giờ hoàng đạo"
  m =
    /^(?:xem ngay|ngay tot xau|xem ngay tot xau|gio hoang dao|gio tot|xem gio tot|lich van nien|xem lich)(.*)$/.exec(n) ||
    /^((?:hom nay|ngay mai|mai)) (?:la )?(?:ngay )?(?:tot hay xau|tot khong|xau khong|co tot khong)/.exec(n);
  if (m) {
    const arg = m[1] || "";
    const [d, mo, y] = pickDate(arg);
    await send(dayText(dayInfo(d, mo, y), birthYearIn(arg)));
    return true;
  }
  return false;
}
