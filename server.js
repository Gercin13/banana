// server.js
// ---------------------------------------------------------------------------
// LOCAL development server (Express). Optional — for `npm start` on your
// machine. Production on Netlify uses netlify/functions/* instead; both share
// the exact same logic from lib/handler.js.
//
// The API key lives ONLY here / in the Netlify function env — never in the
// browser. Growth-to-multi-user seams (auth, per-user storage, quotas) are all
// centralized in lib/handler.js and the getUserId() stub below.
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { handleGenerate, healthPayload } from "./lib/handler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "25mb" })); // headroom for reference-image uploads

// --- Auth seam: single local user today; swap for real auth later. ---
function getUserId(req) {
  return "local";
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => res.json(healthPayload()));

app.post("/api/generate", async (req, res) => {
  const { status, body } = await handleGenerate(req.body, getUserId(req));
  res.status(status).json(body);
});

app.listen(PORT, () => console.log(`\n  Nano Studio (local) → http://localhost:${PORT}\n`));
