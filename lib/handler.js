// lib/handler.js
// ---------------------------------------------------------------------------
// Framework-agnostic request handlers, shared by BOTH the local Express server
// (server.js) and the Netlify Functions (netlify/functions/*). All validation
// and orchestration lives here once — no duplication between environments.
// ---------------------------------------------------------------------------

import { generate, MODELS, ASPECT_RATIOS, IMAGE_SIZES, MAX_IMAGES } from "./engine.js";

const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_REFS = 14;

// Validate + normalize an array of { mimeType, dataBase64 } reference items.
function cleanRefs(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    if (r && typeof r.dataBase64 === "string" && REF_MIME.has(r.mimeType)) {
      out.push({ mimeType: r.mimeType, dataBase64: r.dataBase64 });
    }
  }
  return out;
}

// Capabilities payload for GET /api/health (drives the UI controls).
export function healthPayload() {
  return { ok: true, tiers: Object.keys(MODELS), aspectRatios: ASPECT_RATIOS, imageSizes: IMAGE_SIZES, maxImages: MAX_IMAGES };
}

// Core generate handler. `body` is a parsed object. Returns { status, body }.
// `userId` is reserved for per-user scoping / quotas / audit when going multi-user.
export async function handleGenerate(body = {}, userId = "local") {
  try {
    const { prompt, aspectRatio, size, count, tier } = body;
    const faceRefs = cleanRefs(body.faceRefs);   // identity anchor
    const otherRefs = cleanRefs(body.otherRefs); // poses / clothing / style

    if (!prompt || !String(prompt).trim()) {
      return { status: 400, body: { error: "Введите промпт." } };
    }
    if (String(prompt).length > 4000) {
      return { status: 400, body: { error: "Промпт слишком длинный (макс. 4000 символов)." } };
    }
    if (aspectRatio && !ASPECT_RATIOS.includes(aspectRatio)) {
      return { status: 400, body: { error: "Недопустимое соотношение сторон." } };
    }
    if (tier && !Object.keys(MODELS).includes(tier)) {
      return { status: 400, body: { error: "Недопустимый режим качества." } };
    }
    if (size && !IMAGE_SIZES.includes(size)) {
      return { status: 400, body: { error: "Недопустимое разрешение." } };
    }
    if (faceRefs.length + otherRefs.length > MAX_REFS) {
      return { status: 400, body: { error: `Максимум ${MAX_REFS} референсов всего.` } };
    }

    // Face references first (identity anchor), then the rest.
    const refs = [...faceRefs, ...otherRefs];

    // A gentle identity anchor when a face is supplied (measurably improves
    // consistency). The user's prompt is preserved right after it.
    let finalPrompt = String(prompt).trim();
    if (faceRefs.length) {
      finalPrompt = `Keep the person's facial identity consistent with the provided face reference image(s). ${finalPrompt}`;
    }

    const result = await generate({
      prompt: finalPrompt,
      aspectRatio: aspectRatio || "1:1",
      size: size || "1K",
      count,
      tier: tier || "draft",
      refs,
    });

    if (!result.images.length) {
      return { status: 502, body: { error: result.errors[0] || "Не удалось сгенерировать.", errors: result.errors } };
    }
    // (Growth seam) persist result under `userId` here when adding history.
    return { status: 200, body: result };
  } catch (e) {
    return { status: 500, body: { error: String(e?.message || e) } };
  }
}
