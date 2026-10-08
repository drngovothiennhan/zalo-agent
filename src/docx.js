// Minimal .docx writer (Office Open XML inside a zip). No external libraries.
const enc = new TextEncoder();

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decodeEnt = (s) =>
  s.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---------- zip (stored, no compression) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (v) => [v & 255, (v >>> 8) & 255];
const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, f.data);
    central.push({ name, crc, size, offset });
    offset += local.length + name.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const h = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset),
    ]);
    parts.push(h, c.name);
    cdSize += h.length + c.name.length;
  }
  parts.push(
    new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0),
    ])
  );
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------- WordprocessingML helpers ----------
const FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>';

function runXml(r, base = {}) {
  if (r.br) return "<w:r><w:br/></w:r>";
  const size = r.size || base.size;
  const rpr = [FONT];
  if (r.b || base.b) rpr.push("<w:b/>");
  if (r.i || base.i) rpr.push("<w:i/>");
  if (size) rpr.push(`<w:sz w:val="${size * 2}"/>`);
  if (r.u) rpr.push('<w:u w:val="single"/>');
  return `<w:r><w:rPr>${rpr.join("")}</w:rPr><w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
}

// Inline HTML (b, strong, i, em, u, br) -> runs. Other tags are dropped, their text kept.
function inlineRuns(html) {
  const runs = [];
  const st = { b: false, i: false, u: false };
  const re = /<(\/?)(b|strong|i|em|u|br)\s*\/?>|([^<]+)/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    if (m[3] !== undefined) {
      const t = decodeEnt(m[3]);
      if (t) runs.push({ text: t, ...st });
      continue;
    }
    const tag = m[2].toLowerCase();
    const on = !m[1];
    if (tag === "br") runs.push({ br: true });
    else if (tag === "b" || tag === "strong") st.b = on;
    else if (tag === "i" || tag === "em") st.i = on;
    else if (tag === "u") st.u = on;
  }
  return runs;
}

// One paragraph. opts: align (left|center|both|right), firstLine (twips), size (pt), b, i
export function para(runs, opts = {}) {
  const ppr = [`<w:spacing w:before="0" w:after="${opts.after ?? 120}" w:line="300" w:lineRule="auto"/>`];
  if (opts.firstLine) ppr.push(`<w:ind w:firstLine="${opts.firstLine}"/>`);
  if (opts.align) ppr.push(`<w:jc w:val="${opts.align}"/>`);
  const list = Array.isArray(runs) ? runs : [{ text: String(runs) }];
  const body = list.map((r) => runXml(r, opts)).join("");
  return `<w:p><w:pPr>${ppr.join("")}</w:pPr>${body}</w:p>`;
}

// Plain text that may contain literal "\n" or real newlines (AI field values)
export function textParas(s, opts = {}) {
  return String(s || "")
    .split(/\\n|\n/)
    .filter((x) => x.trim())
    .map((line) => para(inlineRuns(line.trim()), opts))
    .join("");
}

// Body HTML (p, h3, ul/li, table, br, b, i, u) -> paragraphs. Tables are flattened to lines with " | ".
export function htmlParas(html, { firstLine = 0 } = {}) {
  let s = String(html || "")
    .replace(/\r/g, "")
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n<b>$1</b>\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/(p|div|tr|li|ul|ol|table|tbody)>/gi, "\n")
    .replace(/<(p|div|tr|table|tbody|ul|ol|br)\b[^>]*>/gi, (m) => (/^<br/i.test(m) ? "<br>" : "\n"));
  s = s.replace(/<(?!\/?(b|strong|i|em|u|br)\b)[^>]+>/gi, "");
  return s
    .split("\n")
    .map((l) => l.replace(/\s*\|\s*$/, "").trim())
    .filter((l) => l)
    .map((l) => {
      const isList = l.startsWith("•") || l.includes(" | ");
      return para(inlineRuns(l), { firstLine: isList ? 0 : firstLine, align: "both" });
    })
    .join("");
}

const NONE = '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>';

// Borderless layout table: cells = [{ width, xml }]
export function layoutTable(cells) {
  const total = cells.reduce((n, c) => n + c.width, 0);
  const grid = cells.map((c) => `<w:gridCol w:w="${c.width}"/>`).join("");
  const tcs = cells
    .map((c) => `<w:tc><w:tcPr><w:tcW w:w="${c.width}" w:type="dxa"/></w:tcPr>${c.xml || para("")}</w:tc>`)
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${NONE}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid><w:tr>${tcs}</w:tr></w:tbl>`;
}

// Whole document. bodyXml: paragraphs/tables already built.
export function buildDocx(bodyXml, { title = "Văn bản" } = {}) {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    bodyXml +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="851" w:bottom="1134" w:left="1701" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${xmlEsc(title)}</dc:title></cp:coreProperties>`;
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "docProps/core.xml", data: enc.encode(core) },
    { name: "word/document.xml", data: enc.encode(document) },
  ]);
}
