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
const WORD_SYSTEM = `Bạn soạn văn bản tiếng Việt chuẩn mực để xuất ra file Word. Thời điểm hiện tại: {now}.
Trả về DUY NHẤT phần thân HTML (không có <html>, <head>, <body>, không giải thích, không dùng Markdown).
Chỉ dùng các thẻ: h1, h2, h3, p, b, i, u, ul, ol, li, table, tr, th, td, br.
Dòng đầu tiên phải là <h1> với tiêu đề văn bản. Biểu mẫu/sổ sách thì dùng <table> có hàng tiêu đề <th>, chừa ô trống để điền tay.
Văn bản hành chính trường học theo thể thức Việt Nam khi phù hợp (quốc hiệu, tên đơn vị, ngày tháng, nơi nhận, chữ ký).`;

const EXCEL_SYSTEM = `Bạn tạo bảng tính tiếng Việt. Thời điểm hiện tại: {now}.
Trả về DUY NHẤT nội dung CSV (dấu phẩy ngăn cách, mỗi dòng một hàng, ô có dấu phẩy thì đặt trong ngoặc kép), không giải thích, không Markdown.
Dòng đầu là tiêu đề cột. Nếu là sổ theo dõi/biểu mẫu, tạo sẵn các hàng mẫu hoặc hàng trống có số thứ tự để điền.`;

function wordHtml(title, inner) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${title.replace(/</g, "")}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page{size:21cm 29.7cm;margin:2cm 2cm 2cm 3cm}
body{font-family:"Times New Roman",serif;font-size:13pt;line-height:1.4}
h1{font-size:16pt;text-align:center;text-transform:uppercase}h2{font-size:14pt}h3{font-size:13pt}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #000;padding:4pt 6pt;vertical-align:top}th{background:#eee}
</style></head><body>${inner}</body></html>`;
}

export async function makeFile(env, origin, kind, request) {
  const now = nowDescription();
  if (kind === "word") {
    let html = stripFences(await complete(env, WORD_SYSTEM.replace("{now}", now), request, { max_tokens: 2500 }));
    html = html.replace(/<\/?(html|head|body)[^>]*>/gi, "");
    const title = (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || "Tài liệu").replace(/<[^>]+>/g, "").trim();
    const link = await storeFile(env, origin, {
      body: "﻿" + wordHtml(title, html),
      type: "application/msword",
      filename: `${slug(title)}.doc`,
    });
    return { title, link };
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
