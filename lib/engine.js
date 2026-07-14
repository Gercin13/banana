// lib/engine.js
// ---------------------------------------------------------------------------
// GenerationEngine — WaveSpeed AI backend.
//
// WaveSpeed is an async API: submit a task → get a task ID → poll until
// completed → receive CDN URL(s) of the generated image(s).
//
// Model lineup (via one API key):
//   lite   → FLUX Schnell         (cheapest, text-only, no references)
//   draft  → Seedream 5.0 Pro Edit (references, 1K)
//   quality→ Seedream 5.0 Pro Edit (references, 2K)
//
// Swap or extend this module without touching server.js or the UI.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.WAVESPEED_BASE_URL || "https://api.wavespeed.ai/api/v3").replace(/\/$/, "");
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000; // 2 min max wait per image

// Model tier → { slug, slug_norefs (text-only fallback), supportsRefs, resolution }.
export const MODELS = {
  lite: {
    slug: "wavespeed-ai/flux-schnell",
    label: "FLUX Schnell",
    supportsRefs: false,
    resolution: null, // Schnell doesn't use resolution tiers
  },
  draft: {
    slug: "bytedance/seedream-v5.0-pro/edit",
    slugNoRefs: "bytedance/seedream-v5.0-pro", // text-to-image (no images field)
    label: "Seedream 5.0 Pro",
    supportsRefs: true,
    resolution: "1k",
  },
  quality: {
    slug: "bytedance/seedream-v5.0-pro/edit",
    slugNoRefs: "bytedance/seedream-v5.0-pro",
    label: "Seedream 5.0 Pro 2K",
    supportsRefs: true,
    resolution: "2k",
  },
};

// Video model(s).
export const VIDEO_MODELS = {
  default: {
    slug: "wavespeed-ai/wan-2.2/i2v-720p-ultra-fast",
    label: "WAN 2.2 I2V 720p Ultra Fast",
  },
};

export const ASPECT_RATIOS = [
  "1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9",
];

export const IMAGE_SIZES = ["1K", "2K"]; // mapped to resolution field
export const MAX_IMAGES = 4;

function apiKey() {
  const k = process.env.WAVESPEED_API_KEY;
  if (!k) throw new Error("Server misconfigured: WAVESPEED_API_KEY is not set (see .env.example).");
  return k;
}

function headers() {
  return { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" };
}

// Convert a local file ref { mimeType, dataBase64 } to a data-URL string
// (WaveSpeed accepts both URLs and Base64 data-URLs in the `images` array).
function refToDataUrl(ref) {
  return `data:${ref.mimeType};base64,${ref.dataBase64}`;
}

// Submit a task and return the prediction data ({ id, urls.get }).
async function submit(modelSlug, body) {
  const url = `${BASE}/${modelSlug}`;
  const resp = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (!resp.ok) {
    let msg = await resp.text();
    try { msg = JSON.parse(msg).message || msg; } catch { /* keep raw */ }
    throw new Error(`WaveSpeed ${resp.status}: ${msg}`);
  }
  const json = await resp.json();
  if (json.code !== 200 && json.code !== 201) {
    throw new Error(`WaveSpeed submit error: ${json.message || JSON.stringify(json)}`);
  }
  return json.data; // { id, status, urls: { get: "..." } }
}

// Poll until completed or failed. Returns the final data object.
async function poll(resultUrl) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const resp = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey()}` } });
    if (!resp.ok) throw new Error(`WaveSpeed poll ${resp.status}`);
    const json = await resp.json();
    const status = json.data?.status;
    if (status === "completed") return json.data;
    if (status === "failed") throw new Error(`WaveSpeed failed: ${json.data?.error || "unknown error"}`);
    // pending / processing → wait and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("WaveSpeed timeout: generation took too long");
}

// Download a CDN image URL → { mimeType, dataBase64 }.
async function downloadImage(cdnUrl) {
  const resp = await fetch(cdnUrl);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get("content-type") || "image/png";
  return { mimeType: ct.split(";")[0], dataBase64: buf.toString("base64") };
}

// Generate a single image → { mimeType, dataBase64 }.
async function generateOne({ prompt, aspectRatio, tier, refs = [] }) {
  const model = MODELS[tier] || MODELS.draft;
  const hasRefs = refs.length > 0 && model.supportsRefs;
  const slug = hasRefs ? model.slug : (model.slugNoRefs || model.slug);

  const body = { prompt };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (model.resolution) body.resolution = model.resolution;
  body.output_format = "png";

  // Seedream Edit: pass reference images as data-URLs in the `images` array.
  if (hasRefs) {
    body.images = refs.map(refToDataUrl);
  }

  const task = await submit(slug, body);
  const resultUrl = task.urls?.get || `${BASE}/predictions/${task.id}/result`;
  const result = await poll(resultUrl);

  if (!result.outputs?.length) throw new Error("No output images in WaveSpeed response");

  // Download the first output from CDN → base64 (for our disk store).
  return downloadImage(result.outputs[0]);
}

// Public interface. Generates `count` images in parallel.
// Returns { images: [{mimeType,dataBase64}], errors: [string], model }.
export async function generate({ prompt, aspectRatio = "1:1", size, count = 1, tier = "draft", refs = [] }) {
  const model = MODELS[tier] || MODELS.draft;
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), MAX_IMAGES);
  const safeRefs = Array.isArray(refs) ? refs.slice(0, 10) : []; // Seedream caps at 10 refs

  // If tier is "lite" (Schnell) and user supplied refs, silently ignore them
  // (Schnell is text-only; refs are not passed to avoid API errors).
  const effectiveRefs = model.supportsRefs ? safeRefs : [];

  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => generateOne({ prompt, aspectRatio, tier, refs: effectiveRefs }))
  );

  const images = [];
  const errors = [];
  for (const s of settled) {
    if (s.status === "fulfilled") images.push(s.value);
    else errors.push(String(s.reason?.message || s.reason));
  }
  return { images, errors, model: model.label };
}

// ---- Video generation (image-to-video) ------------------------------------

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_TIMEOUT_MS = 300_000; // 5 min (video takes longer)

// Download a video from CDN → { mimeType, dataBase64 } (kept as file ref).
async function downloadVideo(cdnUrl) {
  const resp = await fetch(cdnUrl);
  if (!resp.ok) throw new Error(`Failed to download video: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get("content-type") || "video/mp4";
  return { mimeType: ct.split(";")[0], dataBase64: buf.toString("base64") };
}

// Generate a video → { mimeType, dataBase64 } or throw.
export async function generateVideo({ prompt, negativePrompt, firstFrame, lastFrame, duration }) {
  const model = VIDEO_MODELS.default;

  if (!firstFrame) throw new Error("Video generation requires a first frame image.");

  const body = { prompt };
  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (duration) body.duration = duration; // 5 or 8 (seconds)
  body.image = refToDataUrl(firstFrame);
  if (lastFrame) body.last_image = refToDataUrl(lastFrame);

  const task = await submit(model.slug, body);
  const resultUrl = task.urls?.get || `${BASE}/predictions/${task.id}/result`;

  // Poll with longer interval + timeout (video takes 30s–3min).
  const start = Date.now();
  while (Date.now() - start < VIDEO_POLL_TIMEOUT_MS) {
    const resp = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey()}` } });
    if (!resp.ok) throw new Error(`WaveSpeed poll ${resp.status}`);
    const json = await resp.json();
    const status = json.data?.status;
    if (status === "completed") {
      const outputs = json.data?.outputs || [];
      if (!outputs.length) throw new Error("No output video in WaveSpeed response");
      return { cdnUrl: outputs[0], model: model.label };
    }
    if (status === "failed") throw new Error(`Video failed: ${json.data?.error || "unknown"}`);
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error("Video timeout: generation took too long");
}
