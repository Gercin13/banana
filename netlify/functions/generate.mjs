// Netlify Function (v2) — POST /api/generate  (via netlify.toml redirect).
// Reuses the shared handler; GEMINI_API_KEY comes from the site's env vars.
import { handleGenerate } from "../../lib/handler.js";

export default async (req) => {
  let body = {};
  try {
    body = await req.json();
  } catch {
    /* empty or invalid JSON body -> handler returns a 400 */
  }
  const { status, body: out } = await handleGenerate(body);
  return new Response(JSON.stringify(out), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};
