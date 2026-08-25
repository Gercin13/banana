// GET /api/poll?resultUrl=...&meta=... — check WaveSpeed task status.
// When completed: downloads result to Vercel Blob, saves record, returns images.

import { checkWavespeed } from '../lib/engine.js';
import { saveImage, saveRecord } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { resultUrl, meta: metaStr } = req.query;
  if (!resultUrl) return res.status(400).json({ error: 'Missing resultUrl' });

  try {
    const result = await checkWavespeed(resultUrl);

    if (result.status === 'completed' && result.outputs?.length) {
      let meta = {};
      try { meta = JSON.parse(metaStr || '{}'); } catch { /* ignore */ }

      // Download outputs to Vercel Blob
      const images = [];
      for (const cdnUrl of result.outputs) {
        try {
          const resp = await fetch(cdnUrl);
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          const ct = resp.headers.get("content-type") || "image/png";
          const mime = ct.split(";")[0];
          const saved = await saveImage({ mimeType: mime, dataBase64: buf.toString("base64") });
          images.push(saved);
        } catch { /* skip failed download */ }
      }

      if (images.length) {
        const record = await saveRecord({
          prompt: meta.prompt || "(generation)",
          mode: meta.mode || "manual",
          model: meta.model || "unknown",
          images: images.map(({ id, url, file, mimeType }) => ({ id, url, file, mimeType })),
        });
        return res.json({ completed: true, id: record.id, model: meta.model, mode: meta.mode, images: record.images, errors: [] });
      }
      return res.json({ completed: true, images: [], errors: ['No outputs downloaded'] });
    }

    if (result.status === 'failed') {
      return res.json({ completed: true, images: [], errors: [result.error || 'Task failed'] });
    }

    // Still processing
    return res.json({ completed: false, status: result.status });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
