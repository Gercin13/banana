// GET /api/characters — list. POST — save. DELETE?id=... — delete.
import { listCharacters, saveCharacter, deleteCharacter } from '../lib/store.js';

const REF_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
function cleanRefs(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(r => r && typeof r.dataBase64 === "string" && REF_MIME.has(r.mimeType));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const items = await listCharacters();
    return res.json({ items: items.map(c => ({ id: c.id, name: c.name, createdAt: c.createdAt, images: (c.images || []).map(i => ({ url: i.url })) })) });
  }
  if (req.method === 'POST') {
    const { name } = req.body || {};
    const faceRefs = cleanRefs(req.body?.faceRefs);
    if (!name) return res.status(400).json({ error: "Укажите имя." });
    if (!faceRefs.length) return res.status(400).json({ error: "Добавьте фото." });
    const rec = await saveCharacter({ name, images: faceRefs });
    return res.status(201).json({ id: rec.id, name: rec.name, images: rec.images.map(i => ({ url: i.url })) });
  }
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const ok = await deleteCharacter(id);
    return ok ? res.json({ deleted: true }) : res.status(404).json({ error: 'Not found' });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
