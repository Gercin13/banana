// lib/store.js — Vercel Blob storage (replaces disk-based store).
// Images, videos, history records, and characters stored in Vercel Blob.
// Requires env BLOB_READ_WRITE_TOKEN (auto-set when Blob store is linked in Vercel).

import { put, del, list } from '@vercel/blob';
import crypto from 'node:crypto';

const extFor = (mime) =>
  mime?.includes("jpeg") ? "jpg" : mime?.includes("webp") ? "webp" : mime?.includes("mp4") ? "mp4" : mime?.includes("video") ? "mp4" : "png";

// Save binary (image/video) to Blob. Returns { id, url, file, mimeType }.
export async function saveImage({ dataBase64, mimeType }) {
  const id = crypto.randomUUID();
  const file = `${id}.${extFor(mimeType)}`;
  const buf = Buffer.from(dataBase64, "base64");
  const blob = await put(`images/${file}`, buf, { access: 'public', contentType: mimeType || 'image/png' });
  return { id, url: blob.url, file, mimeType: mimeType || "image/png" };
}

// Save a JSON record to Blob. Returns the record.
export async function saveRecord(rec) {
  const id = rec.id || crypto.randomUUID();
  const record = { id, createdAt: new Date().toISOString(), ...rec };
  await put(`records/${id}.json`, JSON.stringify(record), { access: 'public', contentType: 'application/json' });
  return record;
}

// List recent records, newest first.
export async function listRecords(limit = 100) {
  const { blobs } = await list({ prefix: 'records/' });
  const recs = [];
  for (const b of blobs) {
    if (!b.pathname.endsWith('.json')) continue;
    try {
      const r = await fetch(b.url);
      recs.push(await r.json());
    } catch { /* skip corrupt */ }
  }
  recs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return recs.slice(0, limit);
}

// Delete a record and its associated blobs.
export async function deleteRecord(id) {
  const recUrl = `records/${id}.json`;
  try {
    const { blobs } = await list({ prefix: recUrl });
    if (!blobs.length) return false;
    // Load record to find image URLs
    const r = await fetch(blobs[0].url);
    const rec = await r.json();
    const urlsToDelete = [blobs[0].url];
    for (const img of rec.images || []) {
      if (img.url) urlsToDelete.push(img.url);
    }
    await Promise.all(urlsToDelete.map(u => del(u).catch(() => {})));
    return true;
  } catch { return false; }
}

// --- Characters ---
export async function saveCharacter({ name, images }) {
  const id = crypto.randomUUID();
  const savedImages = [];
  for (const im of (images || [])) {
    const saved = await saveImage(im);
    savedImages.push({ url: saved.url, file: saved.file, mimeType: saved.mimeType });
  }
  const record = { id, name: String(name || "").slice(0, 100), createdAt: new Date().toISOString(), images: savedImages };
  await put(`characters/${id}.json`, JSON.stringify(record), { access: 'public', contentType: 'application/json' });
  return record;
}

export async function listCharacters() {
  const { blobs } = await list({ prefix: 'characters/' });
  const out = [];
  for (const b of blobs) {
    if (!b.pathname.endsWith('.json')) continue;
    try { const r = await fetch(b.url); out.push(await r.json()); } catch { /* skip */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export async function deleteCharacter(id) {
  try {
    const { blobs } = await list({ prefix: `characters/${id}.json` });
    if (!blobs.length) return false;
    const r = await fetch(blobs[0].url);
    const rec = await r.json();
    const urlsToDelete = [blobs[0].url];
    for (const im of rec.images || []) { if (im.url) urlsToDelete.push(im.url); }
    await Promise.all(urlsToDelete.map(u => del(u).catch(() => {})));
    return true;
  } catch { return false; }
}

export async function loadCharacterRefs(id) {
  try {
    const { blobs } = await list({ prefix: `characters/${id}.json` });
    if (!blobs.length) return [];
    const r = await fetch(blobs[0].url);
    const rec = await r.json();
    const refs = [];
    for (const im of rec.images || []) {
      try {
        const imgR = await fetch(im.url);
        const buf = Buffer.from(await imgR.arrayBuffer());
        refs.push({ mimeType: im.mimeType || "image/jpeg", dataBase64: buf.toString("base64") });
      } catch { /* skip */ }
    }
    return refs;
  } catch { return []; }
}
