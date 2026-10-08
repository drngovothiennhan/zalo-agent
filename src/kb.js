// Family knowledge base: documents converted to text, stored in D1 FTS5, searched for each question
const STOPWORDS = new Set(
  "la cua va co cho toi ban gi nao nhu the khong duoc nhung cac mot nay voi trong thi ma de den tu ra vao len xuong rang neu sao bao nhieu hay hoac cung da dang se roi nhe a oi ah u em anh chi minh ho no voi can muon giup biet lam".split(
    " "
  )
);

function plain(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

// Build a safe FTS5 query: quoted terms joined with OR
export function ftsQuery(text) {
  const terms = [...new Set(plain(text).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].slice(0, 16);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

// kind: null = all documents, "mau" = templates only, "doc" = ordinary documents only
export async function searchKb(env, text, limit = 4, kind = null) {
  const q = ftsQuery(text);
  if (!q) return [];
  try {
    const sql = kind
      ? "SELECT kb_fts.content AS content, kb_fts.doc_name AS doc_name, bm25(kb_fts) AS score FROM kb_fts JOIN kb_docs d ON d.id = CAST(kb_fts.doc_id AS INTEGER) WHERE kb_fts MATCH ? AND d.kind = ? ORDER BY score LIMIT ?"
      : "SELECT content, doc_name, bm25(kb_fts) AS score FROM kb_fts WHERE kb_fts MATCH ? ORDER BY score LIMIT ?";
    const stmt = kind ? env.DB.prepare(sql).bind(q, kind, limit) : env.DB.prepare(sql).bind(q, limit);
    const { results } = await stmt.all();
    return results;
  } catch {
    return [];
  }
}

// Document types, most specific first ("tờ trình" files often also contain a draft decision)
const DOC_TYPE_WORDS = ["tờ trình", "đề cương", "quyết định", "kế hoạch", "báo cáo", "biên bản", "thông báo", "công văn", "giấy mời"];

// Best saved template ("mẫu") for a document request: same document type, most similar wording.
// Returns [{ doc_name, content }] with the beginning of the whole template (header, legal bases, structure).
export async function findTemplate(env, request, maxChars = 2500) {
  const lower = String(request || "").toLowerCase().normalize("NFC");
  const type = DOC_TYPE_WORDS.find((t) => lower.includes(t));
  if (!type) return [];
  let docId = null;
  try {
    // Filter by name in JS: SQLite lower() does not handle Vietnamese capitals such as "Đ"
    const candidates = (await listDocs(env, "mau")).filter((d) => d.name.toLowerCase().normalize("NFC").includes(type));
    if (!candidates.length) return [];
    const q = ftsQuery(request);
    if (q) {
      const ids = candidates.map((d) => String(d.id));
      const best = await env.DB.prepare(
        `SELECT doc_id, bm25(kb_fts) AS score FROM kb_fts WHERE kb_fts MATCH ? AND doc_id IN (${ids.map(() => "?").join(",")}) ORDER BY score LIMIT 1`
      )
        .bind(q, ...ids)
        .first();
      docId = best?.doc_id ?? null;
    }
    if (!docId) docId = candidates[0].id;
  } catch {
    return [];
  }
  if (!docId) return [];
  const doc = await getDoc(env, docId);
  const text = await docText(env, docId);
  if (!doc || !text) return [];
  return [{ doc_name: doc.name, content: text.length > maxChars ? text.slice(0, maxChars) + "\n[…phần sau của mẫu được lược bớt…]" : text }];
}

export async function listDocs(env, kind = null) {
  const { results } = kind
    ? await env.DB.prepare("SELECT id, name, chunks, created_at, kind FROM kb_docs WHERE kind = ? ORDER BY id DESC").bind(kind).all()
    : await env.DB.prepare("SELECT id, name, chunks, created_at, kind FROM kb_docs ORDER BY id DESC").all();
  return results;
}

export async function getDoc(env, docId) {
  return env.DB.prepare("SELECT id, name, chunks, kind FROM kb_docs WHERE id = ?").bind(Number(docId)).first();
}

// Full text of a document (chunks in insertion order)
export async function docText(env, docId) {
  const { results } = await env.DB.prepare("SELECT content FROM kb_fts WHERE doc_id = ? ORDER BY rowid").bind(String(docId)).all();
  return results.map((r) => r.content).join("\n\n");
}

export async function setKind(env, docId, kind) {
  const r = await env.DB.prepare("UPDATE kb_docs SET kind = ? WHERE id = ?").bind(kind, Number(docId)).run();
  return r.meta.changes > 0;
}

export async function createDoc(env, name, kind = "doc") {
  const r = await env.DB.prepare("INSERT INTO kb_docs (name, chunks, created_at, kind) VALUES (?, 0, ?, ?)")
    .bind(name, Date.now(), kind === "mau" ? "mau" : "doc")
    .run();
  return r.meta.last_row_id;
}

// Split plain text into ~1200-character chunks on paragraph boundaries
export function chunkText(text) {
  const paras = String(text || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if (p.length > 1400) {
      if (cur) out.push(cur), (cur = "");
      for (let i = 0; i < p.length; i += 1200) out.push(p.slice(Math.max(0, i - 150), i + 1200));
      continue;
    }
    if (cur && (cur + "\n\n" + p).length > 1200) out.push(cur), (cur = p);
    else cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

// Convert an uploaded file (PDF, Word, Excel, HTML…) to text with Workers AI
export async function fileToText(env, name, buf, type) {
  const [res] = await env.AI.toMarkdown([{ name, blob: new Blob([buf], { type: type || "application/octet-stream" }) }]);
  if (!res || res.format === "error" || !res.data) throw new Error(res?.error || "định dạng chưa hỗ trợ");
  return res.data;
}

export async function addText(env, docId, text) {
  const chunks = chunkText(text);
  let added = 0;
  for (let i = 0; i < chunks.length; i += 50) added += await addChunks(env, docId, chunks.slice(i, i + 50));
  return added;
}

export async function addChunks(env, docId, chunks) {
  const doc = await env.DB.prepare("SELECT name FROM kb_docs WHERE id = ?").bind(Number(docId)).first();
  if (!doc) throw new Error("không tìm thấy tài liệu");
  const stmts = chunks
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) =>
      env.DB.prepare("INSERT INTO kb_fts (content, doc_id, doc_name) VALUES (?, ?, ?)").bind(c.trim().slice(0, 4000), String(docId), doc.name)
    );
  stmts.push(env.DB.prepare("UPDATE kb_docs SET chunks = chunks + ? WHERE id = ?").bind(stmts.length, Number(docId)));
  await env.DB.batch(stmts);
  return stmts.length - 1;
}

export async function deleteDoc(env, docId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_fts WHERE doc_id = ?").bind(String(docId)),
    env.DB.prepare("DELETE FROM kb_docs WHERE id = ?").bind(Number(docId)),
  ]);
}

const json = (data, status = 200) => Response.json(data, { status });

// Routes under /kb (all require ?key=<WEBHOOK_SECRET>)
export async function handleKb(request, env, url) {
  if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  const path = url.pathname;

  if (request.method === "GET" && (path === "/kb" || path === "/kb/")) {
    return new Response(KB_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (request.method === "GET" && path === "/kb/docs") return json(await listDocs(env));

  if (request.method === "POST" && path === "/kb/convert") {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "Chưa chọn file" }, 400);
    try {
      const [res] = await env.AI.toMarkdown([{ name: file.name, blob: new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }) }]);
      if (!res || res.format === "error" || !res.data) return json({ error: `Không đọc được file: ${res?.error || "định dạng chưa hỗ trợ"}` }, 422);
      return json({ name: file.name, markdown: res.data });
    } catch (e) {
      return json({ error: `Không đọc được file: ${String(e && e.message)}` }, 422);
    }
  }

  if (request.method === "POST" && path === "/kb/add") {
    const body = await request.json();
    let docId = body.doc_id;
    if (!docId) {
      const name = String(body.name || "").trim().slice(0, 200);
      if (!name) return json({ error: "Thiếu tên tài liệu" }, 400);
      docId = await createDoc(env, name, body.kind);
    }
    const chunks = Array.isArray(body.chunks) ? body.chunks.slice(0, 100) : [];
    const added = chunks.length ? await addChunks(env, docId, chunks) : 0;
    return json({ doc_id: docId, added });
  }

  if (request.method === "POST" && path === "/kb/delete") {
    const body = await request.json();
    await deleteDoc(env, body.doc_id);
    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

const KB_PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kho tài liệu của bot</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--muted:#5b6474;--line:#dfe3ea;--accent:#1f6feb;--ok:#1a7f37;--err:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--ink:#e6e9ef;--muted:#9aa3b2;--line:#2a303b;--accent:#58a6ff;--ok:#3fb950;--err:#ff7b72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:4px 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 10px}label{display:block;font-weight:600;margin:10px 0 6px}
input[type=text],textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
textarea{min-height:140px}button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;margin-top:12px}
button:disabled{opacity:.5;cursor:wait}button.del{background:transparent;color:var(--err);border:1px solid var(--line);padding:6px 10px;margin:0}
#status{margin-top:10px;color:var(--muted);white-space:pre-wrap}#status.ok{color:var(--ok)}#status.err{color:var(--err)}
ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}.meta{color:var(--muted);font-size:14px}
</style></head><body><main>
<h1>Kho tài liệu của bot</h1>
<p class="sub">Tài liệu tải lên đây sẽ được bot tra cứu khi trả lời trên Zalo (ví dụ: quy trình y tế trường, giáo trình YHCT, thông tin gia đình).</p>
<section><h2>Tải file lên</h2>
<p class="meta">Hỗ trợ PDF, Word (.docx), Excel, HTML, ảnh có chữ. PDF dạng ảnh chụp có thể không đọc được chữ.</p>
<input type="file" id="file" accept=".pdf,.docx,.xlsx,.xls,.csv,.html,.htm,.txt,.md,.odt,.ods,.jpg,.jpeg,.png,.webp">
<label style="font-weight:400"><input type="checkbox" id="fmau"> Đây là <b>tài liệu mẫu</b> (bot sẽ bám theo khi soạn văn bản)</label>
<button id="upload">Tải lên và nạp vào bot</button></section>
<section><h2>Hoặc dán nội dung</h2>
<label for="pname">Tên tài liệu</label><input type="text" id="pname" placeholder="Ví dụ: Thông tin sức khỏe cả nhà">
<label for="ptext">Nội dung</label><textarea id="ptext" placeholder="Dán văn bản vào đây"></textarea>
<label style="font-weight:400"><input type="checkbox" id="pmau"> Đây là <b>tài liệu mẫu</b></label>
<button id="paste">Nạp vào bot</button></section>
<div id="status"></div>
<section><h2>Tài liệu đã nạp</h2><ul id="docs"><li class="meta">Đang tải…</li></ul></section>
</main>
<script>
const key = new URLSearchParams(location.search).get("key") || "";
const q = (p) => p + "?key=" + encodeURIComponent(key);
const statusEl = document.getElementById("status");
function say(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ""; }
function chunkText(text) {
  const paras = text.replace(/\\r/g, "").split(/\\n\\s*\\n/).map(s => s.trim()).filter(Boolean);
  const out = []; let cur = "";
  for (const p of paras) {
    if (p.length > 1400) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < p.length; i += 1200) out.push(p.slice(Math.max(0, i - 150), i + 1200));
      continue;
    }
    if ((cur + "\\n\\n" + p).length > 1200 && cur) { out.push(cur); cur = p; } else { cur = cur ? cur + "\\n\\n" + p : p; }
  }
  if (cur) out.push(cur);
  return out;
}
async function ingest(name, text, mau) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("Không có nội dung chữ để nạp.");
  let docId = null, done = 0;
  for (let i = 0; i < chunks.length; i += 50) {
    const r = await fetch(q("/kb/add"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc_id: docId, name, kind: mau ? "mau" : "doc", chunks: chunks.slice(i, i + 50) }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || "Lỗi khi nạp");
    docId = d.doc_id; done += d.added; say("Đang nạp… " + done + "/" + chunks.length + " đoạn");
  }
  return chunks.length;
}
async function loadDocs() {
  const r = await fetch(q("/kb/docs")); const docs = await r.json(); const ul = document.getElementById("docs");
  ul.innerHTML = docs.length ? "" : '<li class="meta">Chưa có tài liệu nào.</li>';
  for (const d of docs) {
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.innerHTML = "<div></div><div class='meta'></div>";
    left.children[0].textContent = (d.kind === "mau" ? "📄 Mẫu · " : "") + d.name;
    left.children[1].textContent = d.chunks + " đoạn · " + new Date(d.created_at).toLocaleDateString("vi-VN");
    const b = document.createElement("button"); b.className = "del"; b.textContent = "Xóa";
    b.onclick = async () => { if (!confirm("Xóa tài liệu \\"" + d.name + "\\"?")) return;
      await fetch(q("/kb/delete"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc_id: d.id }) }); loadDocs(); };
    li.append(left, b); ul.append(li);
  }
}
document.getElementById("upload").onclick = async (e) => {
  const f = document.getElementById("file").files[0]; if (!f) return say("Bạn chưa chọn file.", "err");
  e.target.disabled = true; say("Đang đọc file…");
  try {
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch(q("/kb/convert"), { method: "POST", body: fd }); const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Không đọc được file");
    const n = await ingest(f.name, d.markdown, document.getElementById("fmau").checked); say("Đã nạp \\"" + f.name + "\\" (" + n + " đoạn). Bot đã có thể tra cứu.", "ok"); loadDocs();
  } catch (err) { say(err.message, "err"); } finally { e.target.disabled = false; }
};
document.getElementById("paste").onclick = async (e) => {
  const name = document.getElementById("pname").value.trim(), text = document.getElementById("ptext").value.trim();
  if (!name || !text) return say("Cần nhập cả tên và nội dung.", "err");
  e.target.disabled = true;
  try { const n = await ingest(name, text, document.getElementById("pmau").checked); say("Đã nạp \\"" + name + "\\" (" + n + " đoạn).", "ok"); document.getElementById("ptext").value = ""; loadDocs(); }
  catch (err) { say(err.message, "err"); } finally { e.target.disabled = false; }
};
loadDocs();
</script></body></html>`;
