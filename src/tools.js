// Extra skills: Word/Excel files, weather, drawing pictures
import { Buffer } from "node:buffer";
import { complete } from "./brain.js";
import { nowDescription } from "./time.js";

const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

function slug(s) {
  return (
    String(s || "tai-lieu")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "tai-lieu"
  );
}

function stripFences(s) {
  return String(s || "")
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

async function storeFile(env, origin, { body, type, filename }) {
  const id = randomId();
  await env.FILES.put(`f/${id}`, body, {
    httpMetadata: { contentType: type, contentDisposition: `attachment; filename="${filename}"` },
    customMetadata: { filename },
  });
  return `${origin}/f/${id}/${encodeURIComponent(filename)}`;
}

// GET /f/<id>/<name>
export async function serveFile(env, url) {
  const m = /^\/f\/([a-f0-9]{24})(?:\/|$)/.exec(url.pathname);
  if (!m) return new Response("not found", { status: 404 });
  const obj = await env.FILES.get(`f/${m[1]}`);
  if (!obj) return new Response("File không còn tồn tại.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if ((headers.get("content-type") || "").startsWith("image/")) headers.delete("content-disposition");
  headers.set("cache-control", "private, max-age=86400");
  return new Response(obj.body, { headers });
}

// ---------- Word / Excel ----------
const WORD_SYSTEM = `Bạn là chuyên viên văn thư, soạn văn bản tiếng Việt để xuất ra file Word. Thời điểm hiện tại: {now}.
Trả lời ĐÚNG theo khuôn dưới đây, mỗi trường bắt đầu bằng @@TÊN_TRƯỜNG:, không giải thích, không Markdown, không bọc trong \`\`\`.
@@HANH_CHINH: có | không   (có = văn bản hành chính: kế hoạch, quyết định, thông báo, báo cáo, tờ trình, công văn, biên bản, giấy mời…; không = tài liệu thường: thực đơn, bài viết, ghi chú…)
@@CO_QUAN_CHU_QUAN: tên cơ quan cấp trên trực tiếp, VIẾT HOA (để trống nếu không có)
@@CO_QUAN_BAN_HANH: tên cơ quan/đơn vị ban hành, VIẾT HOA
@@SO_KY_HIEU: ví dụ "Số: …/KH-UBND" hoặc "Số: …/QĐ-MN" (để dấu … cho người dùng tự điền số)
@@DIA_DANH_NGAY: ví dụ "…, ngày … tháng … năm 2026"
@@LOAI_VAN_BAN: tên loại văn bản VIẾT HOA, ví dụ KẾ HOẠCH, QUYẾT ĐỊNH, BIÊN BẢN, THÔNG BÁO (để trống với công văn)
@@TRICH_YEU: trích yếu nội dung, ví dụ "Về việc tổ chức khám sức khỏe định kỳ cho trẻ năm học 2026-2027"
@@NOI_DUNG:
(phần thân bằng HTML, chỉ dùng thẻ p, b, i, u, ul, ol, li, table, tr, th, td, br, h3. Không lặp lại phần đầu, tên loại, trích yếu hay chữ ký. Quyết định thì có phần căn cứ (in nghiêng) rồi "QUYẾT ĐỊNH:" và các Điều 1, Điều 2…; kế hoạch thì có mục đích-yêu cầu, nội dung, thời gian, kinh phí, tổ chức thực hiện; biên bản thì có thời gian, địa điểm, thành phần, nội dung, kết thúc. Biểu mẫu/sổ thì dùng table có hàng th, chừa ô trống.)
@@NOI_NHAN: các nơi nhận, ngăn cách bằng dấu ; (ví dụ: Như Điều 3; Lưu: VT)
@@CHUC_VU_KY: ví dụ "CHỦ TỊCH", "HIỆU TRƯỞNG", "KT. CHỦ TỊCH\\nPHÓ CHỦ TỊCH"
@@NGUOI_KY: họ tên người ký nếu người dùng cho biết, nếu không để trống
Quy tắc: viết đúng thể thức và văn phong hành chính Việt Nam; thông tin người dùng không cung cấp (tên cơ quan, số liệu, họ tên) thì để "…" để họ tự điền, không bịa. Căn cứ pháp lý chỉ dẫn văn bản có trong phần "Mẫu/tài liệu tham khảo" hoặc do người dùng nêu; nếu không có thì ghi "Căn cứ …" để người dùng tự điền. Nếu có mẫu tham khảo, bám sát bố cục và câu chữ của mẫu.`;

function parseFields(raw) {
  const out = {};
  const re = /@@([A-Z_]+):[ \t]*/g;
  const marks = [];
  let m;
  while ((m = re.exec(raw))) marks.push({ key: m[1], start: m.index, end: re.lastIndex });
  marks.forEach((mk, i) => {
    out[mk.key] = raw.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : raw.length).trim();
  });
  return out;
}

const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lines = (s) => esc(s).replace(/\\n|\n/g, "<br>");

// Administrative document layout (thể thức văn bản hành chính, Nghị định 30/2020/NĐ-CP)
function adminBody(f) {
  const noTable = 'style="border:none;width:100%;border-collapse:collapse"';
  const cell = (w, extra = "") => `style="border:none;width:${w};text-align:center;vertical-align:top;padding:0 4pt;${extra}"`;
  const noiNhan = String(f.NOI_NHAN || "")
    .split(/;|\n/)
    .map((s) => s.replace(/^[-–•\s]+/, "").trim())
    .filter(Boolean);
  const header = `<table ${noTable}><tr>
<td ${cell("40%")}>${f.CO_QUAN_CHU_QUAN ? `<span style="font-size:13pt">${lines(f.CO_QUAN_CHU_QUAN)}</span><br>` : ""}<b style="font-size:13pt">${lines(f.CO_QUAN_BAN_HANH || "…")}</b><br>———<br><span style="font-size:13pt">${esc(f.SO_KY_HIEU || "Số: …")}</span></td>
<td ${cell("60%")}><b style="font-size:12pt">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b style="font-size:13pt">Độc lập - Tự do - Hạnh phúc</b><br>———————<br><i style="font-size:13pt">${esc(f.DIA_DANH_NGAY || "…, ngày … tháng … năm …")}</i></td>
</tr></table>`;
  const title =
    (f.LOAI_VAN_BAN ? `<p style="text-align:center;margin:18pt 0 0"><b style="font-size:14pt">${esc(f.LOAI_VAN_BAN.toUpperCase())}</b></p>` : "") +
    (f.TRICH_YEU
      ? `<p style="text-align:center;margin:${f.LOAI_VAN_BAN ? "0" : "12pt 0 0"}"><b style="font-size:14pt">${esc(f.TRICH_YEU)}</b></p><p style="text-align:center;margin:0">———</p>`
      : "");
  const body = `<div class="nd" style="text-align:justify">${String(f.NOI_DUNG || "").replace(/<\/?(html|head|body|script|style)[^>]*>/gi, "")}</div>`;
  const footer = `<table ${noTable} style="margin-top:12pt"><tr>
<td style="border:none;width:50%;vertical-align:top;font-size:12pt">${noiNhan.length ? `<b><i>Nơi nhận:</i></b><br>${noiNhan.map((x) => `- ${esc(x)};`).join("<br>")}` : ""}</td>
<td ${cell("50%")}><b style="font-size:14pt">${lines(f.CHUC_VU_KY || "…")}</b><br><i>(Ký, ghi rõ họ tên${/biên bản/i.test(f.LOAI_VAN_BAN || "") ? "" : ", đóng dấu"})</i><br><br><br><br><b>${esc(f.NGUOI_KY || "")}</b></td>
</tr></table>`;
  return header + title + body + footer;
}

const EXCEL_SYSTEM = `Bạn tạo bảng tính tiếng Việt. Thời điểm hiện tại: {now}.
Trả về DUY NHẤT nội dung CSV (dấu phẩy ngăn cách, mỗi dòng một hàng, ô có dấu phẩy thì đặt trong ngoặc kép), không giải thích, không Markdown.
Dòng đầu là tiêu đề cột. Nếu là sổ theo dõi/biểu mẫu, tạo sẵn các hàng mẫu hoặc hàng trống có số thứ tự để điền.`;

function wordHtml(title, inner) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${title.replace(/</g, "")}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page{size:21cm 29.7cm;margin:2cm 1.5cm 2cm 3cm}
body{font-family:"Times New Roman",serif;font-size:14pt;line-height:1.3}
p{margin:0 0 6pt}
.nd p{text-indent:1cm}
h1{font-size:16pt;text-align:center;text-transform:uppercase}h2{font-size:14pt}h3{font-size:14pt}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #000;padding:4pt 6pt;vertical-align:top}th{background:#eee}
</style></head><body>${inner}</body></html>`;
}

// templates: knowledge-base snippets (e.g. uploaded "Mẫu …" documents) to follow
export async function makeFile(env, origin, kind, request, templates = []) {
  const now = nowDescription();
  if (kind === "word") {
    const ref = templates.length
      ? `\n\nMẫu/tài liệu tham khảo tìm được trong kho tài liệu (dùng nếu liên quan):\n${templates.map((t) => `--- "${t.doc_name}" ---\n${t.content}`).join("\n\n")}`
      : "";
    const raw = stripFences(await complete(env, WORD_SYSTEM.replace("{now}", now), request + ref, { max_tokens: 2000 }));
    const f = parseFields(raw);
    let inner;
    let title;
    if (f.NOI_DUNG !== undefined && /^c[oó]/i.test(f.HANH_CHINH || "")) {
      inner = adminBody(f);
      title = [f.LOAI_VAN_BAN, f.TRICH_YEU].filter(Boolean).join(" ") || "Văn bản";
    } else {
      const body = (f.NOI_DUNG !== undefined ? f.NOI_DUNG : raw).replace(/<\/?(html|head|body|script|style)[^>]*>/gi, "");
      title = f.TRICH_YEU || f.LOAI_VAN_BAN || (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1] || "").replace(/<[^>]+>/g, "").trim() || request.slice(0, 60);
      inner = (/<h1/i.test(body) ? "" : `<h1>${esc(title)}</h1>`) + body;
    }
    const link = await storeFile(env, origin, {
      body: "﻿" + wordHtml(title, inner),
      type: "application/msword",
      filename: `${slug(title)}.doc`,
    });
    return { title, link, usedTemplates: [...new Set(templates.map((t) => t.doc_name))] };
  }
  const csv = stripFences(await complete(env, EXCEL_SYSTEM.replace("{now}", now), request, { max_tokens: 2500 }));
  const firstLine = csv.split("\n")[0] || "";
  const title = request.slice(0, 60);
  const link = await storeFile(env, origin, {
    body: "﻿" + csv.replace(/\r?\n/g, "\r\n"),
    type: "text/csv; charset=utf-8",
    filename: `${slug(title)}.csv`,
  });
  return { title, link, columns: firstLine };
}

// ---------- Weather (Open-Meteo, no key needed) ----------
const WMO = {
  0: "trời quang", 1: "ít mây", 2: "có mây", 3: "nhiều mây", 45: "sương mù", 48: "sương mù đóng băng",
  51: "mưa phùn nhẹ", 53: "mưa phùn", 55: "mưa phùn dày", 61: "mưa nhỏ", 63: "mưa vừa", 65: "mưa to",
  66: "mưa lạnh", 67: "mưa lạnh to", 71: "tuyết nhẹ", 73: "tuyết", 75: "tuyết dày", 80: "mưa rào nhẹ",
  81: "mưa rào", 82: "mưa rào rất to", 95: "dông", 96: "dông kèm mưa đá", 99: "dông mạnh kèm mưa đá",
};

export async function weather(env, place) {
  const name = (place || env.WEATHER_CITY || "Hồ Chí Minh").trim();
  const g = await (
    await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=vi&format=json`)
  ).json();
  const loc = g.results?.[0];
  if (!loc) return `Mình không tìm thấy địa điểm "${name}". Bạn thử tên tỉnh/thành phố, ví dụ: "thời tiết Đà Lạt".`;
  const f = await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max` +
        `&timezone=Asia%2FHo_Chi_Minh&forecast_days=3`
    )
  ).json();
  const c = f.current;
  const d = f.daily;
  const label = ["Hôm nay", "Ngày mai", "Ngày kia"];
  const lines = [
    `Thời tiết ${loc.name}${loc.admin1 && loc.admin1 !== loc.name ? `, ${loc.admin1}` : ""}:`,
    `- Bây giờ: ${Math.round(c.temperature_2m)}°C (cảm giác ${Math.round(c.apparent_temperature)}°C), ${WMO[c.weather_code] || "—"}, độ ẩm ${c.relative_humidity_2m}%, gió ${Math.round(c.wind_speed_10m)} km/h`,
  ];
  for (let i = 0; i < (d.time || []).length; i++) {
    lines.push(
      `- ${label[i]}: ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C, ${WMO[d.weather_code[i]] || "—"}, khả năng mưa ${d.precipitation_probability_max[i] ?? "?"}%, UV ${Math.round(d.uv_index_max[i] ?? 0)}`
    );
  }
  const tips = [];
  if ((d.precipitation_probability_max?.[0] ?? 0) >= 60) tips.push("nhớ mang áo mưa cho các bé");
  if ((d.uv_index_max?.[0] ?? 0) >= 8) tips.push("UV cao, hạn chế cho trẻ chơi ngoài trời 10h–15h");
  if ((d.temperature_2m_max?.[0] ?? 0) >= 35) tips.push("trời nóng, cho trẻ uống đủ nước");
  if (tips.length) lines.push(`Lưu ý: ${tips.join("; ")}.`);
  lines.push("(Nguồn: Open-Meteo)");
  return lines.join("\n");
}

// ---------- Drawing (Workers AI FLUX) ----------
export async function draw(env, origin, request) {
  const en = await complete(
    env,
    "Translate the user's Vietnamese image request into one concise, vivid English prompt for an image generator. Family-friendly. Output only the prompt.",
    request,
    { max_tokens: 120, temperature: 0.3 }
  );
  const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: en || request, steps: 6 });
  if (!out?.image) throw new Error("không tạo được ảnh");
  const id = randomId();
  await env.FILES.put(`f/${id}`, Buffer.from(out.image, "base64"), {
    httpMetadata: { contentType: "image/jpeg" },
    customMetadata: { filename: "tranh.jpg" },
  });
  return `${origin}/f/${id}/tranh.jpg`;
}
