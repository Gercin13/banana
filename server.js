// server.js
// ---------------------------------------------------------------------------
// Persistent Node/Express server. Serves the static frontend, the generated
// images, and the JSON API. The API key lives ONLY here (server env) — never
// in the browser. This runs as a normal long-lived process (Docker / VPS /
// any Node host), so there are no serverless response-size or timeout limits.
//
// Multi-user growth: replace getUserId(), then every request is scoped by it
// (store records already carry `owner`).
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  handleGenerate, handleGenerateVideo, handleUpscale, handleHistory, handleDelete, healthPayload,
  handleListCharacters, handleSaveCharacter, handleDeleteCharacter,
} from "./lib/handler.js";
import { IMAGES_DIR } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "25mb" })); // room for reference-image uploads

// --- Auth seam: single local user today; swap for real auth to go multi-user.
function getUserId(req) {
  return "local";
}

// Static frontend + generated images (served by URL, cached).
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(IMAGES_DIR, { maxAge: "1y", immutable: true }));

app.get("/api/health", (req, res) => res.json(healthPayload()));

app.post("/api/generate", async (req, res) => {
  const genMode = req.body?.genMode; // "image" (default) or "video"
  const handler = genMode === "video" ? handleGenerateVideo : handleGenerate;
  const { status, body } = await handler(req.body, getUserId(req));
  res.status(status).json(body);
});

app.post("/api/upscale", async (req, res) => {
  const { status, body } = await handleUpscale(req.body, getUserId(req));
  res.status(status).json(body);
});

app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const { status, body } = handleHistory(limit);
  res.status(status).json(body);
});

app.delete("/api/history/:id", (req, res) => {
  const { status, body } = handleDelete(req.params.id);
  res.status(status).json(body);
});

// --- Saved characters ---
app.get("/api/characters", (req, res) => {
  const { status, body } = handleListCharacters();
  res.status(status).json(body);
});

app.post("/api/characters", (req, res) => {
  const { status, body } = handleSaveCharacter(req.body);
  res.status(status).json(body);
});

app.delete("/api/characters/:id", (req, res) => {
  const { status, body } = handleDeleteCharacter(req.params.id);
  res.status(status).json(body);
});

app.listen(PORT, () => console.log(`\n  Nano Studio → http://localhost:${PORT}\n`));
