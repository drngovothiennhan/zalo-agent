// Loading documents/templates into the knowledge base straight from the Zalo chat
import * as db from "./db.js";
import { createDoc, addText, getDoc, setKind, fileToText, deleteDoc } from "./kb.js";
import { transcribeImage } from "./vision.js";
import { formatLocal } from "./time.js";

const MAX_FILE_BYTES = 15 * 1024 * 1024;

// Document types that make "mẫu" mean a document template (not "mẫu thức ăn" = food sample)
export const DOC_TYPES =
  "biên bản|quyết định|kế hoạch|thông báo|báo cáo|tờ trình|công văn|giấy|đơn|hợp đồng|sổ|phiếu|bảng|danh sách|thư|chương trình|phương án|quy chế|quy trình|nội quy|văn bản|hồ sơ|bản cam kết|cam kết";
const TEMPLATE_RE = new RegExp(`(tài liệu mẫu|văn bản mẫu|biểu mẫu|mẫu\\s*:|mẫu\\s*[.!]?\\s*$|mẫu\\s+(${DOC_TYPES}))`);

export const isTemplate = (lower) => TEMPLATE_RE.test(String(lower || ""));

// Should a photo caption / message be treated as "save this document"?
export function wantsSave(lower) {
  if (!lower) return false;
  if (/[?？]\s*$/.test(lower)) return false;
  // (JS \b does not work after Vietnamese letters, so use explicit lookaheads)
  const verb = /(^|\s)(lưu|nạp|thêm|đây là|làm)(?=[\s:]|$)/.test(lower);
  return (verb && (/(tài liệu|văn bản)/.test(lower) || isTemplate(lower))) || new RegExp(`^mẫu\\s*(:|(${DOC_TYPES}))`).test(lower);
}

// Turn a caption/command into a document name
export function cleanName(s, kind) {
  let name = String(s || "")
    .split("\n")[0]
    .replace(/^(bot[\s,:]*)?/i, "")
    .replace(/^(hãy\s+|giúp\s+(mình|tôi|em)\s+)?/i, "")
    .replace(/^(đây là|lưu|nạp|thêm|ghi nhớ|làm)(\s+(lại|làm|vào|giúp))?\s*/i, "")
    .replace(/^(tài liệu|văn bản)\s*/i, "")
    .replace(/^[:\-–\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^mẫu[.!]?$/i.test(name)) name = "";
  if (!name) return "";
  name = name.charAt(0).toUpperCase() + name.slice(1);
  if (kind === "mau" && !/^mẫu/i.test(name)) name = `Mẫu: ${name}`;
  return name.slice(0, 120);
}

function nameFromText(text, kind) {
  const first = String(text || "")
    .split("\n")
    .map((l) => l.replace(/[|*#_]/g, " ").trim())
    .find((l) => l.length >= 6 && !/^(cộng hòa|độc lập|số:)/i.test(l));
  const base = (first || `Tài liệu ${formatLocal(Date.now())}`).slice(0, 80);
  return kind === "mau" ? `Mẫu: ${base}` : base;
}

// Look for a downloadable file link anywhere in a Zalo message we do not understand
export function findFile(msg) {
  let found = null;
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 4 || found) return;
    for (const [k, v] of Object.entries(o)) {
      if (found) return;
      if (typeof v === "string" && /^https?:\/\//i.test(v) && /url|link|href|file|download|src/i.test(k) && k !== "photo_url" && !/avatar/i.test(k)) {
        found = { url: v };
      } else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(msg, 0);
  if (!found) return null;
  const name = msg.file_name || msg.fileName || msg.name || msg.title || msg.document?.file_name || msg.file?.name || "";
  return { url: found.url, name: String(name) };
}

// Photo page -> text -> knowledge base. Appends to docId when given.
export async function ingestImage(env, chatId, url, { kind = "doc", name = "", docId = null } = {}) {
  const text = await transcribeImage(env, url);
  if (!text) return null;
  let id = docId;
  let docName = name;
  if (!id) {
    docName = name || nameFromText(text, kind);
    id = await createDoc(env, docName, kind);
  } else {
    docName = (await getDoc(env, id))?.name || name;
  }
  await addText(env, id, text);
  await db.setLastMedia(env, chatId, { url, mediaType: "image", name: docName, docId: id });
  return { docId: id, name: docName, chars: text.length, preview: text.slice(0, 300) };
}

// File link -> text -> knowledge base
export async function ingestFile(env, chatId, { url, name }, kind = "doc") {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tải file lỗi HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FILE_BYTES) throw new Error("file lớn hơn 15MB");
  const fileName = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "tai-lieu");
  const text = await fileToText(env, fileName, buf, res.headers.get("content-type"));
  const docName = kind === "mau" && !/^mẫu/i.test(fileName) ? `Mẫu: ${fileName}` : fileName;
  const id = await createDoc(env, docName, kind);
  const chunks = await addText(env, id, text);
  if (!chunks) {
    await deleteDoc(env, id);
    throw new Error("file không có chữ đọc được");
  }
  await db.setLastMedia(env, chatId, { url, mediaType: "file", name: docName, docId: id });
  return { docId: id, name: docName, chars: text.length };
}

// "đây là mẫu" after sending something: mark/ingest the most recent photo/file/document
export async function markLast(env, chatId, kind, name) {
  const last = await db.getLastMedia(env, chatId);
  if (!last) return { status: "none" };
  if (last.doc_id) {
    const doc = await getDoc(env, last.doc_id);
    if (!doc) return { status: "none" };
    await setKind(env, last.doc_id, kind);
    if (name) await env.DB.prepare("UPDATE kb_docs SET name = ? WHERE id = ?").bind(name, last.doc_id).run();
    return { status: "marked", docId: last.doc_id, name: name || doc.name };
  }
  if (last.media_type === "image" && last.url) {
    const r = await ingestImage(env, chatId, last.url, { kind, name });
    return r ? { status: "ingested", ...r } : { status: "notext" };
  }
  return { status: "none" };
}
