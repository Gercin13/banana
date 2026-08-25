// GET /api/health — capabilities (drives UI controls).
import { TIERS, ASPECT_RATIOS, IMAGE_SIZES, MAX_IMAGES, VIDEO_MODELS } from '../lib/engine.js';
import { atomesusAvailable } from '../lib/atomesus.js';

export default function handler(req, res) {
  res.json({
    ok: true,
    tiers: TIERS,
    aspectRatios: ASPECT_RATIOS,
    imageSizes: IMAGE_SIZES,
    maxImages: MAX_IMAGES,
    videoModels: Object.fromEntries(Object.entries(VIDEO_MODELS).map(([k, v]) => [k, {
      label: v.label, supportsResolution: v.supportsResolution, supportsLastFrame: v.supportsLastFrame,
      supportsAudio: v.supportsAudio, durationOptions: v.durationOptions,
    }])),
    atomesusEnhance: atomesusAvailable(),
  });
}
