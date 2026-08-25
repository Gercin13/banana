// POST /api/upscale — submit upscale task (returns taskId for polling).
import { submitWavespeed } from '../lib/engine.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { imageUrl, videoUrl, targetResolution } = req.body || {};
    if (!imageUrl && !videoUrl) return res.status(400).json({ error: "Нужен URL для апскейла." });

    const isVideo = Boolean(videoUrl);
    const sourceUrl = imageUrl || videoUrl;

    // If it's a Blob URL, download and convert to data-URL for WaveSpeed.
    let inputDataUrl = sourceUrl;
    if (sourceUrl.startsWith('http')) {
      try {
        const r = await fetch(sourceUrl);
        const buf = Buffer.from(await r.arrayBuffer());
        const ct = r.headers.get('content-type') || (isVideo ? 'video/mp4' : 'image/png');
        inputDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
      } catch (e) {
        return res.status(400).json({ error: `Cannot fetch source: ${e.message}` });
      }
    }

    const slug = isVideo ? 'wavespeed-ai/video-upscaler' : 'wavespeed-ai/seedvr2/image';
    const body = isVideo
      ? { video: inputDataUrl, target_resolution: targetResolution || '1080p' }
      : { image: inputDataUrl, target_resolution: targetResolution || '4k', output_format: 'png' };

    const task = await submitWavespeed(slug, body);
    return res.json({
      completed: false, taskId: task.taskId, resultUrl: task.resultUrl, provider: "wavespeed",
      meta: JSON.stringify({ prompt: `(апскейл → ${targetResolution || (isVideo ? '1080p' : '4k')})`, mode: 'upscale', model: isVideo ? 'Video Upscaler' : 'SeedVR2 Image' }),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
