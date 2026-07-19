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
  // "lite" (FLUX Schnell/WaveSpeed) removed — replaced by NVIDIA FLUX.1-dev (free).
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

// Video models.
export const VIDEO_MODELS = {
  wan22: {
    slug: "wavespeed-ai/wan-2.2/i2v-720p-ultra-fast",
    label: "WAN 2.2 Ultra Fast",
    supportsResolution: false,     // fixed 720p
    supportsLastFrame: true,
    supportsAudio: false,
    durationOptions: [5, 8],
  },
  wan25: {
    slug: "alibaba/wan-2.5/image-to-video-fast",
    label: "WAN 2.5 Fast",
    supportsResolution: true,      // 720p / 1080p
    supportsLastFrame: false,      // no last_image param
    supportsAudio: true,           // audio URL/data-URL
    durationOptions: [5, 6, 7, 8, 9, 10],
  },
};

export const ASPECT_RATIOS = [
  "1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9",
];

export const IMAGE_SIZES = ["1K", "2K"]; // mapped to resolution field
export const MAX_IMAGES = 4;

// All valid tier values (WaveSpeed tiers + the separate NVIDIA engine below).
// "nvidia" first = "Быстро"; then WaveSpeed tiers.
export const TIERS = ["nvidia", ...Object.keys(MODELS)];

// ---- NVIDIA NIM API — FLUX.1-dev (Black Forest Labs, free hosted trial) ----
// Synchronous response, artifacts[].base64 format.
// Supports: mode=base (text→image), mode=canny / depth (ControlNet with input image).
// ⚠️ Trial restriction: canny/depth input images only accept NVIDIA's pre-registered
// example_ids, NOT arbitrary base64 uploads — those 422. So mode=base is always safe;
// canny/depth from user-uploaded images will 422 on the trial tier.
// Confirmed working: FLUX.1-dev text-to-image (~8s, high quality).
export const NVIDIA_MODEL_LABEL = "FLUX.1-dev (NVIDIA, бесплатно)";

// Ratio → width/height for FLUX.1-dev (must be 1024 multiples matching the API).
// Width/height must be from: 768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344.
const FLUX1_RATIOS = {
  "1:1":  { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768  },
  "9:16": { width: 768,  height: 1344 },
  "5:4":  { width: 1088, height: 896  },
  "4:5":  { width: 896,  height: 1088 },
  "3:2":  { width: 1216, height: 832  },
  "2:3":  { width: 832,  height: 1216 },
};
export const NVIDIA_RATIOS = Object.keys(FLUX1_RATIOS); // ["1:1","16:9","9:16",...]
export const NVIDIA_MODES  = ["base", "canny", "depth"];

const NVIDIA_BASE = (process.env.NVIDIA_BASE_URL || "https://ai.api.nvidia.com/v1/genai").replace(/\/$/, "");
const NVIDIA_ENDPOINT = `${NVIDIA_BASE}/black-forest-labs/flux.1-dev`;

function nvidiaApiKey() {
  const k = process.env.NVIDIA_API_KEY;
  if (!k) throw new Error("Server misconfigured: NVIDIA_API_KEY is not set (see .env.example).");
  return k;
}

export async function generateOneNvidia({ prompt, mode = "base", ratio = "1:1", cfgScale = 3.5, steps = 50, seed = 0, inputImage = null }) {
  const dims = FLUX1_RATIOS[ratio] || FLUX1_RATIOS["1:1"];
  const body = {
    prompt,
    mode,
    cfg_scale: cfgScale,
    width: dims.width,
    height: dims.height,
    seed,
    steps,
  };
  // ControlNet modes require an input image. On the free trial only NVIDIA's
  // pre-registered example_ids work — arbitrary base64 will 422. We pass whatever
  // the caller provides; if it 422s the error message will make it clear.
  if ((mode === "canny" || mode === "depth") && inputImage) {
    body.image_b64 = inputImage.dataBase64; // may 422 on trial — caller is warned
  }
  const resp = await fetch(NVIDIA_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nvidiaApiKey()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = await resp.text();
    try { msg = JSON.parse(msg).message || msg; } catch { /* keep raw */ }
    throw new Error(`NVIDIA ${resp.status}: ${msg}`);
  }
  const data = await resp.json();
  const art = data.artifacts?.[0];
  if (!art?.base64) throw new Error("NVIDIA: no image in response");
  return { mimeType: "image/png", dataBase64: art.base64 };
}

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
export async function generate({ prompt, aspectRatio = "1:1", size, count = 1, tier = "draft", refs = [],
                                   nvidiaMode, nvidiaRatio, nvidiaCfgScale, nvidiaSteps, nvidiaSeed, nvidiaInputImage }) {
  // NVIDIA FLUX.1-dev — synchronous, single image per call.
  if (tier === "nvidia") {
    try {
      const img = await generateOneNvidia({
        prompt,
        mode:       nvidiaMode      || "base",
        ratio:      nvidiaRatio     || "1:1",
        cfgScale:   nvidiaCfgScale  ?? 3.5,
        steps:      nvidiaSteps     ?? 50,
        seed:       nvidiaSeed      ?? 0,
        inputImage: nvidiaInputImage || null,
      });
      return { images: [img], errors: [], model: NVIDIA_MODEL_LABEL };
    } catch (e) {
      return { images: [], errors: [String(e.message || e)], model: NVIDIA_MODEL_LABEL };
    }
  }

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

// ---- Upscalers (image + video) ---------------------------------------------

export const UPSCALE_MODELS = {
  image: { slug: "wavespeed-ai/seedvr2/image", label: "SeedVR2 Image Upscaler" },
  video: { slug: "wavespeed-ai/video-upscaler", label: "Standard Video Upscaler" },
};

// Upscale an image (via URL). Returns { cdnUrl }.
export async function upscaleImage({ imageUrl, targetResolution = "4k" }) {
  const body = { image: imageUrl, target_resolution: targetResolution, output_format: "png" };
  const task = await submit(UPSCALE_MODELS.image.slug, body);
  const resultUrl = task.urls?.get || `${BASE}/predictions/${task.id}/result`;
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const resp = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey()}` } });
    if (!resp.ok) throw new Error(`Upscale poll ${resp.status}`);
    const json = await resp.json();
    const status = json.data?.status;
    if (status === "completed") {
      const out = json.data?.outputs?.[0];
      if (!out) throw new Error("Upscale: no output");
      return { cdnUrl: out, model: UPSCALE_MODELS.image.label };
    }
    if (status === "failed") throw new Error(`Upscale failed: ${json.data?.error || "unknown"}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Upscale timeout");
}

// Upscale a video (via URL). Returns { cdnUrl }.
export async function upscaleVideo({ videoUrl, targetResolution = "1080p" }) {
  const body = { video: videoUrl, target_resolution: targetResolution };
  const task = await submit(UPSCALE_MODELS.video.slug, body);
  const resultUrl = task.urls?.get || `${BASE}/predictions/${task.id}/result`;
  const start = Date.now();
  const timeout = 300_000; // 5 min for video upscale
  while (Date.now() - start < timeout) {
    const resp = await fetch(resultUrl, { headers: { Authorization: `Bearer ${apiKey()}` } });
    if (!resp.ok) throw new Error(`Video upscale poll ${resp.status}`);
    const json = await resp.json();
    const status = json.data?.status;
    if (status === "completed") {
      const out = json.data?.outputs?.[0];
      if (!out) throw new Error("Video upscale: no output");
      return { cdnUrl: out, model: UPSCALE_MODELS.video.label };
    }
    if (status === "failed") throw new Error(`Video upscale failed: ${json.data?.error || "unknown"}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Video upscale timeout");
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

// Generate a video → { cdnUrl, model } or throw.
export async function generateVideo({ prompt, negativePrompt, firstFrame, lastFrame, duration, seed, videoModelKey, resolution, audio }) {
  const modelKey = videoModelKey && VIDEO_MODELS[videoModelKey] ? videoModelKey : "wan22";
  const model = VIDEO_MODELS[modelKey];

  if (!firstFrame) throw new Error("Video generation requires a first frame image.");

  const body = { prompt };
  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (duration) body.duration = Number(duration);
  // Seed: -1 = random for WAN 2.5; WAN 2.2 also accepts seed.
  if (seed !== undefined && seed !== null) body.seed = Number(seed);
  body.image = refToDataUrl(firstFrame);

  if (model.supportsLastFrame && lastFrame) {
    body.last_image = refToDataUrl(lastFrame);
  }
  if (model.supportsResolution && resolution) {
    body.resolution = resolution;
  }
  if (model.supportsAudio && audio) {
    // WaveSpeed accepts data-URLs for audio (same as images).
    body.audio = `data:${audio.mimeType};base64,${audio.dataBase64}`;
  }

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
      return { cdnUrl: outputs[0], model: model.label, modelKey };
    }
    if (status === "failed") throw new Error(`Video failed: ${json.data?.error || "unknown"}`);
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error("Video timeout: generation took too long");
}
