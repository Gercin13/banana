// GET /api/history — list records. DELETE /api/history?id=... — delete a record.
import { listRecords, deleteRecord } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const items = await listRecords(limit);
    return res.json({ items });
  }
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const ok = await deleteRecord(id);
    return ok ? res.json({ deleted: true }) : res.status(404).json({ error: 'Not found' });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
