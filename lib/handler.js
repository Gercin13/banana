// lib/handler.js
// ---------------------------------------------------------------------------
// Core request logic shared by all server routes. Validates input, composes a
// role-aware instruction (Face / Pose / Clothing), calls the GenerationEngine,
// persists images via the storage layer, and returns URLs (never base64).
//
// Two generation modes, chosen automatically by whether the prompt is empty:
//   • auto   — empty prompt + references → build the full instruction from the
//              reference roles present (deterministic template).
//   • manual — prompt typed → use it, prefixed with anchors for the roles that
//              have references. Optionally enhanced via Atomesus (see block).
// ---------------------------------------------------------------------------

import { generate, MODELS, ASPECT_RATIOS, IMAGE_SIZES, MAX_IMAGES } from "./engine.js";
import { saveImage, saveRecord, listRecords, deleteRecord } from "./store.js";
import { enhancePrompt, atomesusAvailable } from "./atomesus.js";

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

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function healthPayload() {
  return {
    ok: true,
    tiers: Object.keys(MODELS),
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    maxImages: MAX_IMAGES,
    atomesusEnhance: atomesusAvailable(), // UI shows the toggle only when true
  };
}

export async function handleGenerate(body = {}, userId = "local") {
  try {
    const { prompt, aspectRatio, size, count, tier, enhance } = body;
    const faceRefs = cleanRefs(body.faceRefs);
    const poseRefs = cleanRefs(body.poseRefs);
    const garmentRefs = cleanRefs(body.garmentRefs);

    const userText = prompt ? String(prompt).trim() : "";
    const totalRefs = faceRefs.length + poseRefs.length + garmentRefs.length;

    // Prompt is optional — but need at least a prompt OR one reference.
    if (!userText && totalRefs === 0) {
      return { status: 400, body: { error: "Введите промпт или добавьте хотя бы один референс." } };
    }
    if (userText.length > 4000) {
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
    if (totalRefs > MAX_REFS) {
      return { status: 400, body: { error: `Максимум ${MAX_REFS} референсов всего.` } };
    }

    // Reference order: face (identity) -> pose -> garment.
    const refs = [...faceRefs, ...poseRefs, ...garmentRefs];

    // Anchors only for roles that actually have references.
    const anchors = [];
    if (faceRefs.length) anchors.push("keep the person's facial identity from the face reference image(s)");
    if (poseRefs.length) anchors.push("match the body pose and framing from the pose reference image(s)");
    if (garmentRefs.length) anchors.push("dress the person in the clothing from the wardrobe reference image(s)");
    const anchorText = anchors.join("; ");

    const mode = userText ? "manual" : "auto";

    // ---- Atomesus block (OPTIONAL, easy to remove) -----------------------
    // Enhances the user's typed prompt. Manual mode only (cipher can't see
    // images, so it can't help the auto/template case). Fully graceful.
    let core = userText;
    let enhanced = false;
    if (mode === "manual" && enhance && atomesusAvailable()) {
      const roles = [
        ...(faceRefs.length ? ["face/identity"] : []),
        ...(poseRefs.length ? ["pose"] : []),
        ...(garmentRefs.length ? ["clothing"] : []),
      ];
      try {
        const better = await enhancePrompt(userText, roles);
        if (better) { core = better; enhanced = true; }
      } catch { /* fall back to userText */ }
    }
    // ---- end Atomesus block ---------------------------------------------

    let finalPrompt;
    if (mode === "auto") {
      finalPrompt =
        "Create one cohesive, photorealistic image" +
        (anchorText ? `. ${capitalize(anchorText)}` : "") +
        ". Natural consistent lighting, realistic high detail.";
    } else {
      finalPrompt = anchorText ? `${capitalize(anchorText)}. ${core}` : core;
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

    const images = result.images.map((img) => saveImage(img));
    const record = saveRecord({
      owner: userId,
      prompt: userText || "(авто из референсов)",
      mode,
      enhanced,
      refs: { face: faceRefs.length, pose: poseRefs.length, garment: garmentRefs.length },
      aspectRatio: aspectRatio || "1:1",
      size: size || "1K",
      tier: tier || "draft",
      model: result.model,
      images: images.map(({ id, url, file, mimeType }) => ({ id, url, file, mimeType })),
    });

    return {
      status: 200,
      body: { id: record.id, createdAt: record.createdAt, model: result.model, mode, enhanced, images: record.images, errors: result.errors },
    };
  } catch (e) {
    return { status: 500, body: { error: String(e?.message || e) } };
  }
}

export function handleHistory(limit = 100) {
  return { status: 200, body: { items: listRecords(limit) } };
}

export function handleDelete(id) {
  return deleteRecord(id)
    ? { status: 200, body: { deleted: true } }
    : { status: 404, body: { error: "Не найдено." } };
}
