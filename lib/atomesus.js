// lib/atomesus.js
// ---------------------------------------------------------------------------
// OPTIONAL prompt-enhancement via the Atomesus "cipher" text model.
//
// Fully isolated so it's trivial to remove if you don't like it:
//   1) Softest OFF:  remove the ATOMESUS_API_KEY env var → atomesusAvailable()
//      becomes false, the UI toggle disappears, nothing here runs.
//   2) Full removal: delete this file, delete the small "Atomesus block" in
//      lib/handler.js, and delete the toggle in public/index.html + app.js.
//
// It NEVER blocks generation: any failure/timeout returns null and the caller
// falls back to the user's original text.
// ---------------------------------------------------------------------------

const BASE = (process.env.ATOMESUS_BASE_URL || "https://api.atomesus.com").replace(/\/$/, "");
const MODEL = process.env.ATOMESUS_MODEL || "cipher";
const TIMEOUT_MS = 12000; // fail fast → graceful fallback (cipher chat can be very slow)

export function atomesusAvailable() {
  return Boolean(process.env.ATOMESUS_API_KEY);
}

// Rewrite a short idea into a richer image prompt. Returns improved text, or
// null on any problem (missing key, empty input, HTTP error, timeout).
export async function enhancePrompt(userText, roles = []) {
  const key = process.env.ATOMESUS_API_KEY;
  if (!key || !userText) return null;

  const rolesLine = roles.length
    ? ` The image will also use reference photos for: ${roles.join(", ")} — do NOT describe those; focus on scene, style, lighting, composition.`
    : "";
  // NOTE: Atomesus ignores system-role messages, so all instructions go here.
  const content =
    "Rewrite the following idea into ONE vivid, specific image-generation prompt. " +
    "Reply with ONLY the final prompt text, in the same language as the input, no quotes, no preamble." +
    rolesLine +
    `\n\nIdea: ${userText}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 300 }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let out = data?.choices?.[0]?.message?.content;
    if (!out) return null;
    out = out.trim().replace(/^["'«»\s]+|["'«»\s]+$/g, "").trim();
    return out ? out.slice(0, 4000) : null;
  } catch {
    return null; // timeout / network / parse — silently fall back
  } finally {
    clearTimeout(timer);
  }
}
