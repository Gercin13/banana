// POST /api/generate — submit a generation task.
// For NVIDIA (synchronous, <10s): returns { completed: true, images: [...] }.
// For WaveSpeed (async): returns { completed: false, taskId, resultUrl, provider: "wavespeed", meta: {...} }.
// The client polls /api/poll for WaveSpeed tasks.

import { submitWavespeed, MODELS, TIERS, VIDEO_MODELS } from '../lib/engine.js';
import { saveImage, saveRecord, loadCharacterRefs } from '../lib/store.js';
import { enhancePrompt, atomesusAvailable } from '../lib/atomesus.js';

const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_REFS = 10;

function cleanRefs(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(r => r && typeof r.dataBase64 === "string" && REF_MIME.has(r.mimeType))
    .map(r => ({ mimeType: r.mimeType, dataBase64: r.dataBase64 }));
}

function refToDataUrl(ref) {
  return `data:${ref.mimeType};base64,${ref.dataBase64}`;
}

const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const genMode = body.genMode || "image"; // "image" or "video"

    // ---- VIDEO ----
    if (genMode === "video") {
      const { prompt, negativePrompt, duration, videoModelKey, resolution, seed } = body;
      const firstFrame = cleanRefs(body.firstFrame ? [body.firstFrame] : []);
      const audioRef = body.audio && body.audio.dataBase64 ? body.audio : null;
      const userText = prompt ? String(prompt).trim() : "";
      if (!firstFrame.length) return res.status(400).json({ error: "Добавьте первый кадр." });
      if (!userText) return res.status(400).json({ error: "Опишите, что в видео." });

      const modelKey = videoModelKey && VIDEO_MODELS[videoModelKey] ? videoModelKey : "wan22";
      const model = VIDEO_MODELS[modelKey];
      const vBody = { prompt: userText };
      if (negativePrompt) vBody.negative_prompt = String(negativePrompt).trim();
      if (duration) vBody.duration = Number(duration);
      if (seed !== undefined) vBody.seed = Number(seed);
      vBody.image = refToDataUrl(firstFrame[0]);
      if (model.supportsLastFrame && body.lastFrame) {
        const lf = cleanRefs([body.lastFrame]);
        if (lf.length) vBody.last_image = refToDataUrl(lf[0]);
      }
      if (model.supportsResolution && resolution) vBody.resolution = resolution;
      if (model.supportsAudio && audioRef) vBody.audio = `data:${audioRef.mimeType};base64,${audioRef.dataBase64}`;

      const task = await submitWavespeed(model.slug, vBody);
      return res.json({ completed: false, taskId: task.taskId, resultUrl: task.resultUrl, provider: "wavespeed",
        meta: { prompt: userText, mode: "video", model: model.label } });
    }

    // ---- IMAGE ----
    const { prompt, aspectRatio, size, count, tier, enhance, characterId } = body;
    const editImages = cleanRefs(Array.isArray(body.editImages) ? body.editImages : (body.editImage ? [body.editImage] : []));
    const charRefs = characterId ? await loadCharacterRefs(characterId) : [];
    const faceRefs = [...charRefs, ...cleanRefs(body.faceRefs)];
    const poseRefs = cleanRefs(body.poseRefs);
    const garmentRefs = cleanRefs(body.garmentRefs);
    const productRefs = cleanRefs(body.productRefs);
    const backgroundRefs = cleanRefs(body.backgroundRefs);

    const userText = prompt ? String(prompt).trim() : "";
    const totalRefs = faceRefs.length + poseRefs.length + garmentRefs.length + productRefs.length + backgroundRefs.length;
    const isEditMode = editImages.length > 0;
    const effTier = tier || "draft";

    if (!userText && totalRefs === 0 && !isEditMode) return res.status(400).json({ error: "Введите промпт или добавьте референс." });
    if (isEditMode && !userText) return res.status(400).json({ error: "Опишите задачу." });
    if (effTier !== "nvidia" && !TIERS.includes(effTier)) return res.status(400).json({ error: "Недопустимый режим." });

    // Build refs array
    const refs = isEditMode
      ? [...editImages, ...faceRefs, ...poseRefs, ...garmentRefs, ...productRefs, ...backgroundRefs].slice(0, MAX_REFS)
      : [...faceRefs, ...poseRefs, ...garmentRefs, ...productRefs, ...backgroundRefs].slice(0, MAX_REFS);

    // Build anchors
    const anchors = [];
    if (faceRefs.length) anchors.push("keep the person's facial identity from the face reference image(s)");
    if (poseRefs.length) anchors.push("match the body pose from the pose reference image(s)");
    if (garmentRefs.length) anchors.push("dress the person in the clothing from the wardrobe reference image(s)");
    if (productRefs.length) anchors.push("include the exact product from the product reference image(s)");
    if (backgroundRefs.length) anchors.push("set the scene in the background reference image");
    const anchorText = anchors.join("; ");

    // Atomesus enhance
    let core = userText;
    if (userText && enhance && atomesusAvailable()) {
      try { const better = await enhancePrompt(userText, []); if (better) core = better; } catch {}
    }

    // Build final prompt
    let finalPrompt;
    if (isEditMode) {
      const refNote = editImages.length > 1
        ? `Use the ${editImages.length} provided reference images to generate a maximally consistent depiction.`
        : "Use the provided reference image.";
      finalPrompt = anchorText ? `${refNote} ${capitalize(anchorText)}. ${core}` : `${refNote} ${core}`;
    } else if (!userText) {
      finalPrompt = "Create one cohesive, photorealistic image" + (anchorText ? `. ${capitalize(anchorText)}` : "") + ". Natural consistent lighting.";
    } else {
      finalPrompt = anchorText ? `${capitalize(anchorText)}. ${core}` : core;
    }
    if (!isEditMode && !backgroundRefs.length) {
      finalPrompt += !userText ? " Plain, pure white background." : " If no specific background is described, use a plain white background.";
    }

    // ---- WaveSpeed (async — client polls) ----
    const model = MODELS[effTier] || MODELS.draft;
    const hasRefs = refs.length > 0 && model.supportsRefs;
    const slug = hasRefs ? model.slug : (model.slugNoRefs || model.slug);

    const wsBody = { prompt: finalPrompt };
    if (aspectRatio) wsBody.aspect_ratio = aspectRatio;
    if (model.resolution) wsBody.resolution = model.resolution;
    wsBody.output_format = "png";
    if (hasRefs) wsBody.images = refs.map(refToDataUrl);

    const task = await submitWavespeed(slug, wsBody);
    return res.json({ completed: false, taskId: task.taskId, resultUrl: task.resultUrl, provider: "wavespeed",
      meta: { prompt: userText || "(авто)", mode: isEditMode ? "edit" : (userText ? "manual" : "auto"), model: model.label, count: Math.min(count || 1, 4) } });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// submitWavespeed is already imported at the top from engine.js.
