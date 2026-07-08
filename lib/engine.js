// lib/engine.js
// ---------------------------------------------------------------------------
// GenerationEngine — the single seam between the app and the image backend.
// Swap or extend this module (FLUX, local ComfyUI, etc.) without touching the
// HTTP routes or the UI. Reference images are already supported here so the
// future "consistent character" feature (identity + pose + wardrobe refs)
// plugs in with zero API changes.
// ---------------------------------------------------------------------------

const BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const API_VERSION = process.env.GEMINI_API_VERSION || "v1beta";

// Friendly tier -> concrete model id (Nano Banana family).
export const MODELS = {
  draft: process.env.GEMINI_DRAFT_MODEL || "gemini-3.1-flash-image", // Nano Banana 2 — fast & cheap
  quality: process.env.GEMINI_QUALITY_MODEL || "gemini-3-pro-image", // Nano Banana Pro — best fidelity
};

// All popular aspect ratios supported by Nano Banana.
export const ASPECT_RATIOS = [
  "1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9",
];

// Output resolutions. NB2 / Pro support 1K/2K/4K (Lite is 1K only).
export const IMAGE_SIZES = ["1K", "2K", "4K"];

export const MAX_IMAGES = 4;

function apiKey() {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!k) throw new Error("Server misconfigured: GEMINI_API_KEY is not set (see .env.example).");
  return k;
}

// Generate a single image -> { mimeType, dataBase64 }.
// `refs` is an array of { mimeType, dataBase64 } (up to 14) for future
// reference-driven / consistent-character generation.
async function generateOne({ prompt, aspectRatio, size, model, refs = [] }) {
  const parts = [{ text: prompt }];
  for (const r of refs) {
    parts.push({ inline_data: { mime_type: r.mimeType, data: r.dataBase64 } });
  }

  const body = { contents: [{ parts }] };
  // NOTE: the live v1beta API uses generationConfig.imageConfig for size/ratio
  // (the public docs' responseFormat.image path returns 400 INVALID_ARGUMENT).
  const imageCfg = {};
  if (aspectRatio) imageCfg.aspectRatio = aspectRatio;
  if (size) imageCfg.imageSize = size;
  if (Object.keys(imageCfg).length) body.generationConfig = { imageConfig: imageCfg };

  const url = `${BASE}/${API_VERSION}/models/${model}:generateContent`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let msg = await resp.text();
    try { msg = JSON.parse(msg).error?.message || msg; } catch { /* keep raw */ }
    throw new Error(`Gemini ${resp.status}: ${msg}`);
  }

  const data = await resp.json();
  const outParts = data.candidates?.[0]?.content?.parts || [];
  for (const p of outParts) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      return { mimeType: inline.mimeType || inline.mime_type || "image/png", dataBase64: inline.data };
    }
  }
  const fb = data.promptFeedback ? JSON.stringify(data.promptFeedback) : "no image part in response";
  throw new Error(`Blocked or empty result (${fb})`);
}

// Public interface. Generates `count` images in parallel.
// Returns { images: [{mimeType,dataBase64}], errors: [string], model }.
export async function generate({ prompt, aspectRatio = "1:1", size, count = 1, tier = "draft", refs = [] }) {
  const model = MODELS[tier] || MODELS.draft;
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), MAX_IMAGES);
  const safeRefs = Array.isArray(refs) ? refs.slice(0, 14) : []; // Nano Banana caps at 14 refs

  const settled = await Promise.allSettled(
    Array.from({ length: n }, () => generateOne({ prompt, aspectRatio, size, model, refs: safeRefs }))
  );

  const images = [];
  const errors = [];
  for (const s of settled) {
    if (s.status === "fulfilled") images.push(s.value);
    else errors.push(String(s.reason?.message || s.reason));
  }
  return { images, errors, model };
}
