import { Router } from 'express';
import { pool, mapPage } from '../db.js';

const r = Router();

// PUT /api/pages/:id
r.put('/pages/:id', async (req, res, next) => {
  try {
    const cur = await pool.query(`SELECT * FROM pages WHERE id=$1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Página não encontrada' });
    const p = cur.rows[0];
    const b = req.body || {};
    const v = (k) => (b[k] != null ? b[k] : p[k]);
    const image = b.image !== undefined ? b.image : p.image; // permite limpar com null
    const q = await pool.query(
      `UPDATE pages SET name=$2, price=$3, description=$4, material=$5, dimensions=$6, colors=$7, weight=$8, image=$9
       WHERE id=$1 RETURNING *`,
      [req.params.id, v('name'), v('price'), v('description'), v('material'), v('dimensions'), v('colors'), v('weight'), image]
    );
    await pool.query(`UPDATE catalogs SET updated_at=now() WHERE id=$1`, [p.catalog_id]);
    res.json(mapPage(q.rows[0]));
  } catch (e) { next(e); }
});

// DELETE /api/pages/:id
r.delete('/pages/:id', async (req, res, next) => {
  try {
    const cur = await pool.query(`SELECT catalog_id FROM pages WHERE id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM pages WHERE id=$1`, [req.params.id]);
    if (cur.rowCount) await pool.query(`UPDATE catalogs SET updated_at=now() WHERE id=$1`, [cur.rows[0].catalog_id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

export default r;
