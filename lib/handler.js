// lib/handler.js
// ---------------------------------------------------------------------------
// Core request logic shared by all server routes. Validates input, composes a
// role-aware instruction (Face / Pose / Clothing), calls the GenerationEngine,
// persists images, and returns URLs (never base64).
//
// Modes (auto-selected by whether the prompt is empty):
//   • auto   — empty prompt + references → build the instruction from roles.
//   • manual — prompt typed → use it, prefixed with role anchors.
// Saved characters: a generation may reference a saved character; its face
// images are loaded server-side and prepended to the face references.
// ---------------------------------------------------------------------------

import { generate, generateVideo, generateOneNvidia, upscaleImage, upscaleVideo, MODELS, TIERS, VIDEO_MODELS, ASPECT_RATIOS, IMAGE_SIZES, MAX_IMAGES, NVIDIA_RATIOS, NVIDIA_MODES, NVIDIA_MODEL_LABEL } from "./engine.js";
import {
  saveImage, saveRecord, listRecords, deleteRecord,
  saveCharacter, listCharacters, deleteCharacter, loadCharacterRefs,
} from "./store.js";
import { enhancePrompt, atomesusAvailable } from "./atomesus.js";

const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_REFS = 10; // Seedream 5.0 Pro supports up to 10 reference images

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
    tiers: TIERS,
    nvidiaRatios: NVIDIA_RATIOS,
    nvidiaModes: NVIDIA_MODES,
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    maxImages: MAX_IMAGES,
    atomesusEnhance: atomesusAvailable(),
  };
}

export async function handleGenerate(body = {}, userId = "local") {
  try {
    const { prompt, aspectRatio, size, count, tier, enhance, characterId,
            nvidiaMode, nvidiaRatio, nvidiaCfgScale, nvidiaSteps, nvidiaSeed } = body;
    const editImage = cleanRefs(body.editImage ? [body.editImage] : []);

    // Face refs = saved character (if chosen) + any manually uploaded face refs.
    const charRefs = characterId ? loadCharacterRefs(characterId) : [];
    const faceRefs = [...charRefs, ...cleanRefs(body.faceRefs)];
    const poseRefs = cleanRefs(body.poseRefs);
    const garmentRefs = cleanRefs(body.garmentRefs);
    const productRefs = cleanRefs(body.productRefs);
    const backgroundRefs = cleanRefs(body.backgroundRefs);

    const userText = prompt ? String(prompt).trim() : "";
    const totalRefs = faceRefs.length + poseRefs.length + garmentRefs.length + productRefs.length + backgroundRefs.length;

    // Edit mode: image attached via 📎. The 5 ref zones ALSO apply when populated.
    const isEditMode = editImage.length > 0;

    if (!userText && totalRefs === 0 && !isEditMode) {
      return { status: 400, body: { error: "Введите промпт, добавьте референс или выберите персонажа." } };
    }
    if (isEditMode && !userText) {
      return { status: 400, body: { error: "Опишите, что изменить на изображении." } };
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
    if (tier && !TIERS.includes(tier)) {
      return { status: 400, body: { error: "Недопустимый режим качества." } };
    }
    // Edit mode: edit image FIRST (what to edit), then any role zone refs
    // (what to apply). Normal mode: face -> pose -> garment -> product -> bg.
    const refs = isEditMode
      ? [...editImage, ...faceRefs, ...poseRefs, ...garmentRefs, ...productRefs, ...backgroundRefs].slice(0, MAX_REFS)
      : [...faceRefs, ...poseRefs, ...garmentRefs, ...productRefs, ...backgroundRefs].slice(0, MAX_REFS);

    // Role anchors apply in BOTH edit and normal modes when zones are populated.
    const anchors = [];
    if (faceRefs.length) anchors.push("keep the person's facial identity from the face reference image(s)");
    if (poseRefs.length) anchors.push("match the body pose and framing from the pose reference image(s)");
    if (garmentRefs.length) anchors.push("dress the person in the clothing from the wardrobe reference image(s)");
    if (productRefs.length) anchors.push("include the exact product from the product reference image(s), preserving its shape, colors and any branding/labels");
    if (backgroundRefs.length) anchors.push("set the scene in the environment from the background reference image, matching its setting, lighting and perspective");
    const anchorText = anchors.join("; ");

    const mode = userText ? "manual" : "auto";

    // ---- Atomesus block (OPTIONAL, easy to remove) -----------------------
    let core = userText;
    let enhanced = false;
    if (mode === "manual" && enhance && atomesusAvailable()) {
      const roles = [
        ...(faceRefs.length ? ["face/identity"] : []),
        ...(poseRefs.length ? ["pose"] : []),
        ...(garmentRefs.length ? ["clothing"] : []),
        ...(productRefs.length ? ["product"] : []),
        ...(backgroundRefs.length ? ["background/environment"] : []),
      ];
      try {
        const better = await enhancePrompt(userText, roles);
        if (better) { core = better; enhanced = true; }
      } catch { /* fall back to userText */ }
    }
    // ---- end Atomesus block ---------------------------------------------

    let finalPrompt;
    if (isEditMode) {
      // Edit mode: user's instruction + any role anchors from populated zones.
      finalPrompt = anchorText
        ? `Edit the first image. ${capitalize(anchorText)}. ${core}`
        : `Edit the first image. ${core}`;
    } else if (mode === "auto") {
      finalPrompt =
        "Create one cohesive, photorealistic image" +
        (anchorText ? `. ${capitalize(anchorText)}` : "") +
        ". Natural consistent lighting, realistic high detail.";
    } else {
      finalPrompt = anchorText ? `${capitalize(anchorText)}. ${core}` : core;
    }

    // Background default (normal mode only): with no background reference,
    // keep a plain white background unless the prompt describes a specific setting.
    if (!isEditMode && !backgroundRefs.length) {
      finalPrompt += mode === "auto"
        ? " Plain, pure white background."
        : " If no specific background or setting is described, use a plain, pure white background.";
    }

    // Edit mode: use draft or quality (both go to Seedream Edit).
    const effTier = isEditMode && (tier === "nvidia") ? "draft" : (tier || "draft");
    const effSize = size || "1K";
    // NVIDIA generates one image per call (synchronous); edit mode → 1.
    const effCount = (isEditMode || effTier === "nvidia") ? 1 : count;
    // For NVIDIA mode also pass the ControlNet input image if mode ≠ base.
    const nvidiaInputImage = (effTier === "nvidia" && nvidiaMode && nvidiaMode !== "base" && editImage.length)
      ? editImage[0] : null;

    const result = await generate({
      prompt: finalPrompt,
      aspectRatio: aspectRatio || "1:1",
      size: effSize,
      count: effCount,
      tier: effTier,
      refs,
      // NVIDIA-specific params (ignored by WaveSpeed branch)
      nvidiaMode,
      nvidiaRatio: nvidiaRatio || aspectRatio || "1:1",
      nvidiaCfgScale: nvidiaCfgScale !== undefined ? Number(nvidiaCfgScale) : 3.5,
      nvidiaSteps: nvidiaSteps !== undefined ? Number(nvidiaSteps) : 50,
      nvidiaSeed: nvidiaSeed !== undefined ? Number(nvidiaSeed) : 0,
      nvidiaInputImage,
    });

    if (!result.images.length) {
      return { status: 502, body: { error: result.errors[0] || "Не удалось сгенерировать.", errors: result.errors } };
    }

    const images = result.images.map((img) => saveImage(img));
    const record = saveRecord({
      owner: userId,
      prompt: userText || "(авто из референсов)",
      mode: isEditMode ? "edit" : mode,
      enhanced,
      characterId: characterId || null,
      refs: { face: faceRefs.length, pose: poseRefs.length, garment: garmentRefs.length, product: productRefs.length, background: backgroundRefs.length },
      aspectRatio: aspectRatio || "1:1",
      size: effSize,
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

// ---- Video generation handler ---------------------------------------------

export async function handleGenerateVideo(body = {}, userId = "local") {
  try {
    const { prompt, negativePrompt, duration } = body;
    const firstFrame = cleanRefs(body.firstFrame ? [body.firstFrame] : []);
    const lastFrame = cleanRefs(body.lastFrame ? [body.lastFrame] : []);
    const userText = prompt ? String(prompt).trim() : "";
    const negText = negativePrompt ? String(negativePrompt).trim() : "";
    const dur = [5, 8].includes(Number(duration)) ? Number(duration) : 5;

    if (!firstFrame.length) {
      return { status: 400, body: { error: "Добавьте изображение первого кадра для генерации видео." } };
    }
    if (!userText) {
      return { status: 400, body: { error: "Опишите, что должно происходить в видео." } };
    }
    if (userText.length > 4000) {
      return { status: 400, body: { error: "Промпт слишком длинный (макс. 4000 символов)." } };
    }

    const result = await generateVideo({
      prompt: userText,
      negativePrompt: negText || undefined,
      firstFrame: firstFrame[0],
      lastFrame: lastFrame.length ? lastFrame[0] : null,
      duration: dur,
    });

    // Download video from CDN to disk.
    const resp = await fetch(result.cdnUrl);
    if (!resp.ok) throw new Error(`Failed to download video: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const videoData = { mimeType: "video/mp4", dataBase64: buf.toString("base64") };
    const saved = saveImage(videoData); // reuses image store (handles mp4 ext)

    const record = saveRecord({
      owner: userId,
      prompt: userText,
      mode: "video",
      model: result.model,
      images: [{ id: saved.id, url: saved.url, file: saved.file, mimeType: saved.mimeType }],
    });

    return {
      status: 200,
      body: {
        id: record.id, createdAt: record.createdAt, model: result.model,
        mode: "video",
        images: record.images,
        errors: [],
      },
    };
  } catch (e) {
    return { status: 500, body: { error: String(e?.message || e) } };
  }
}

// ---- Upscale handler -------------------------------------------------------
export async function handleUpscale(body = {}, userId = "local") {
  try {
    let { imageUrl, videoUrl, targetResolution } = body;
    if (!imageUrl && !videoUrl) {
      return { status: 400, body: { error: "Нужен URL изображения или видео для апскейла." } };
    }

    // Local /images/xxx paths → convert to data-URL (WaveSpeed needs a real URL or data-URL,
    // not a relative path on our server). We read from disk and encode.
    const localUrl = imageUrl || videoUrl;
    if (localUrl && localUrl.startsWith("/images/")) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { IMAGES_DIR } = await import("./store.js");
      const fname = path.default.basename(localUrl);
      const filePath = path.default.join(IMAGES_DIR, fname);
      if (!fs.default.existsSync(filePath)) {
        return { status: 404, body: { error: "Файл не найден на сервере." } };
      }
      const buf = fs.default.readFileSync(filePath);
      const mime = fname.endsWith(".mp4") ? "video/mp4" : fname.endsWith(".jpg") ? "image/jpeg" : "image/png";
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      if (imageUrl) imageUrl = dataUrl;
      else videoUrl = dataUrl;
    }

    const isVideo = Boolean(videoUrl);
    const result = isVideo
      ? await upscaleVideo({ videoUrl, targetResolution: targetResolution || "1080p" })
      : await upscaleImage({ imageUrl, targetResolution: targetResolution || "4k" });

    // Download upscaled file from CDN to local disk.
    const resp = await fetch(result.cdnUrl);
    if (!resp.ok) throw new Error(`Download upscaled file failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = isVideo ? "video/mp4" : "image/png";
    const saved = saveImage({ mimeType: mime, dataBase64: buf.toString("base64") });

    const record = saveRecord({
      owner: userId,
      prompt: `(апскейл ${isVideo ? "видео" : "изображения"} → ${targetResolution || (isVideo ? "1080p" : "4k")})`,
      mode: "upscale",
      model: result.model,
      images: [{ id: saved.id, url: saved.url, file: saved.file, mimeType: saved.mimeType }],
    });

    return {
      status: 200,
      body: { id: record.id, mode: "upscale", model: result.model, images: record.images, errors: [] },
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

// --- Saved characters ------------------------------------------------------

export function handleListCharacters() {
  const items = listCharacters().map((c) => ({
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    images: (c.images || []).map((i) => ({ url: i.url })),
  }));
  return { status: 200, body: { items } };
}

export function handleSaveCharacter(body = {}) {
  const name = body.name ? String(body.name).trim() : "";
  const faceRefs = cleanRefs(body.faceRefs);
  if (!name) return { status: 400, body: { error: "Укажите имя персонажа." } };
  if (!faceRefs.length) return { status: 400, body: { error: "Добавьте хотя бы одно фото лица." } };
  if (faceRefs.length > MAX_REFS) return { status: 400, body: { error: `Максимум ${MAX_REFS} фото.` } };
  const rec = saveCharacter({ name, images: faceRefs });
  return { status: 201, body: { id: rec.id, name: rec.name, images: rec.images.map((i) => ({ url: i.url })) } };
}

export function handleDeleteCharacter(id) {
  return deleteCharacter(id)
    ? { status: 200, body: { deleted: true } }
    : { status: 404, body: { error: "Не найдено." } };
}
