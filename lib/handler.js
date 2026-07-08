// lib/handler.js
// ---------------------------------------------------------------------------
// Core request logic shared by all server routes. Validates input, calls the
// GenerationEngine, PERSISTS each image via the storage layer, and returns
// URLs (never base64 to the client — that's what keeps large 2K/4K images and
// batches robust). Multi-user seams (userId scoping, quotas) layer in here.
// ---------------------------------------------------------------------------

import { generate, MODELS, ASPECT_RATIOS, IMAGE_SIZES, MAX_IMAGES } from "./engine.js";
import { saveImage, saveRecord, listRecords, deleteRecord } from "./store.js";

const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_REFS = 14;

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

export function healthPayload() {
  return {
    ok: true,
    tiers: Object.keys(MODELS),
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    maxImages: MAX_IMAGES,
  };
}

// POST /api/generate. Returns { status, body }.
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
    if (size && !IMAGE_SIZES.includes(size)) {
      return { status: 400, body: { error: "Недопустимое разрешение." } };
    }
    if (tier && !Object.keys(MODELS).includes(tier)) {
      return { status: 400, body: { error: "Недопустимый режим качества." } };
    }
    if (faceRefs.length + otherRefs.length > MAX_REFS) {
      return { status: 400, body: { error: `Максимум ${MAX_REFS} референсов всего.` } };
    }

    const refs = [...faceRefs, ...otherRefs]; // face first (identity anchor)
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

    // Persist images to disk -> URLs (no base64 sent to the browser).
    const images = result.images.map((img) => saveImage(img));
    const record = saveRecord({
      owner: userId,
      prompt: String(prompt).trim(),
      aspectRatio: aspectRatio || "1:1",
      size: size || "1K",
      tier: tier || "draft",
      model: result.model,
      refs: { face: faceRefs.length, other: otherRefs.length },
      images: images.map(({ id, url, file, mimeType }) => ({ id, url, file, mimeType })),
    });

    return {
      status: 200,
      body: {
        id: record.id,
        createdAt: record.createdAt,
        model: result.model,
        images: record.images,
        errors: result.errors,
      },
    };
  } catch (e) {
    return { status: 500, body: { error: String(e?.message || e) } };
  }
}

// GET /api/history
export function handleHistory(limit = 100) {
  return { status: 200, body: { items: listRecords(limit) } };
}

// DELETE /api/history/:id
export function handleDelete(id) {
  return deleteRecord(id)
    ? { status: 200, body: { deleted: true } }
    : { status: 404, body: { error: "Не найдено." } };
}
