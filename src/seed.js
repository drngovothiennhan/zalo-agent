// One-time import of bundled template documents into the knowledge base.
// Runs from the cron trigger, one document per minute, so each run stays tiny (free-plan CPU limits).
import { createDoc, addChunks, deleteDoc } from "./kb.js";
import { trace } from "./zalo.js";

export async function runSeed(env, seed) {
  if (!seed?.docs?.length) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)").run();
  const key = `seed:${seed.version}`;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  const done = row ? Number(row.value) : 0;
  if (done >= seed.docs.length) return;

  const doc = seed.docs[done];
  const existing = await env.DB.prepare("SELECT id, chunks FROM kb_docs WHERE name = ?").bind(doc.name).first();
  if (existing && !existing.chunks) await deleteDoc(env, existing.id); // half-finished earlier attempt
  if (!existing || !existing.chunks) {
    const id = await createDoc(env, doc.name, "mau");
    await addChunks(env, id, doc.chunks);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, String(done + 1)).run();
  trace("seed", { version: seed.version, imported: done + 1, total: seed.docs.length, name: doc.name });
}
