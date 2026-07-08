// Netlify Function (v2) — GET /api/health  (via netlify.toml redirect).
import { healthPayload } from "../../lib/handler.js";

export default async () =>
  new Response(JSON.stringify(healthPayload()), {
    headers: { "Content-Type": "application/json" },
  });
