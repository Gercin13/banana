// lib/store.js
// ---------------------------------------------------------------------------
// Storage layer. Disk implementation: images as files + one JSON record per
// generation (no DB, no native deps — robust and simple for a personal tool).
// It's isolated behind this module so it can be swapped for S3/R2 + Postgres
// later without touching routes or the engine.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
export const IMAGES_DIR = path.join(DATA_DIR, "images");
const RECORDS_DIR = path.join(DATA_DIR, "records");

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(RECORDS_DIR, { recursive: true });

const extFor = (mime) =>
  mime?.includes("jpeg") ? "jpg" : mime?.includes("webp") ? "webp" : "png";

// Save one image (base64) to disk. Returns { id, url, mimeType, file }.
export function saveImage({ dataBase64, mimeType }) {
  const id = crypto.randomUUID();
  const file = `${id}.${extFor(mimeType)}`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), Buffer.from(dataBase64, "base64"));
  return { id, url: `/images/${file}`, mimeType: mimeType || "image/png", file };
}

// Persist a generation record (metadata + image refs). Returns the record.
export function saveRecord(rec) {
  const id = rec.id || crypto.randomUUID();
  const record = { id, createdAt: new Date().toISOString(), ...rec };
  fs.writeFileSync(path.join(RECORDS_DIR, `${id}.json`), JSON.stringify(record));
  return record;
}

// List recent records, newest first.
export function listRecords(limit = 100) {
  const recs = [];
  for (const f of fs.readdirSync(RECORDS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      recs.push(JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), "utf8")));
    } catch {
      /* skip a corrupt record rather than crash the whole history */
    }
  }
  recs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return recs.slice(0, limit);
}

// Delete a record and its image files. Returns true if it existed.
export function deleteRecord(id) {
  const recPath = path.join(RECORDS_DIR, `${path.basename(id)}.json`);
  if (!fs.existsSync(recPath)) return false;
  try {
    const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
    for (const img of rec.images || []) {
      if (!img.file) continue;
      const p = path.join(IMAGES_DIR, path.basename(img.file));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch { /* ignore parse errors, still remove the record */ }
  fs.unlinkSync(recPath);
  return true;
}
