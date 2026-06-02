import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool, mapCatalog, mapPage } from '../db.js';

const r = Router();

const DEFAULT_BRAND = {
  name: 'Boreal3DShop',
  tagline: 'Soluções e Produtos em Impressão 3D',
  headerTitle: 'Catálogo Oficial de Produtos',
  contact: 'contato@boreal3dshop.com.br · (00) 00000-0000',
  social: '@boreal3dshop',
  logo: null,
};

// GET /api/catalogs  -> lista (sem imagens das páginas)
r.get('/', async (_req, res, next) => {
  try {
    const q = await pool.query(`
      SELECT c.*, (SELECT count(*) FROM pages p WHERE p.catalog_id = c.id) AS page_count
      FROM catalogs c ORDER BY c.updated_at DESC
    `);
    res.json(q.rows.map((row) => mapCatalog(row, row.page_count)));
  } catch (e) { next(e); }
});

// POST /api/catalogs -> cria catálogo padrão
r.post('/', async (req, res, next) => {
  try {
    const id = randomUUID();
    const name = (req.body && req.body.name) ? String(req.body.name) : 'Novo catálogo';
    const brand = { ...DEFAULT_BRAND, ...(req.body && req.body.brand ? req.body.brand : {}) };
    const q = await pool.query(
      `INSERT INTO catalogs (id, name, brand) VALUES ($1,$2,$3) RETURNING *`,
      [id, name, brand]
    );
    res.status(201).json(mapCatalog(q.rows[0], 0));
  } catch (e) { next(e); }
});

// GET /api/catalogs/:id -> catálogo completo com páginas (e imagens)
r.get('/:id', async (req, res, next) => {
  try {
    const c = await pool.query(`SELECT * FROM catalogs WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'Catálogo não encontrado' });
    const p = await pool.query(`SELECT * FROM pages WHERE catalog_id=$1 ORDER BY position ASC, created_at ASC`, [req.params.id]);
    const out = mapCatalog(c.rows[0], p.rowCount);
    out.pages = p.rows.map(mapPage);
    res.json(out);
  } catch (e) { next(e); }
});

// PUT /api/catalogs/:id -> atualiza nome e/ou brand
r.put('/:id', async (req, res, next) => {
  try {
    const cur = await pool.query(`SELECT * FROM catalogs WHERE id=$1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'Catálogo não encontrado' });
    const name = req.body.name != null ? String(req.body.name) : cur.rows[0].name;
    const brand = req.body.brand != null ? { ...cur.rows[0].brand, ...req.body.brand } : cur.rows[0].brand;
    const q = await pool.query(
      `UPDATE catalogs SET name=$2, brand=$3, updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, name, brand]
    );
    res.json(mapCatalog(q.rows[0]));
  } catch (e) { next(e); }
});

// DELETE /api/catalogs/:id
r.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM catalogs WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  } catch (e) { next(e); }
});

// POST /api/catalogs/:id/duplicate
r.post('/:id/duplicate', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query(`SELECT * FROM catalogs WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Catálogo não encontrado' }); }
    const src = c.rows[0];
    const newId = randomUUID();
    await client.query(`INSERT INTO catalogs (id, name, brand) VALUES ($1,$2,$3)`,
      [newId, src.name + ' (cópia)', src.brand]);
    const pgs = await client.query(`SELECT * FROM pages WHERE catalog_id=$1 ORDER BY position ASC`, [req.params.id]);
    for (const p of pgs.rows) {
      await client.query(
        `INSERT INTO pages (id, catalog_id, position, name, price, description, material, dimensions, colors, weight, image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), newId, p.position, p.name, p.price, p.description, p.material, p.dimensions, p.colors, p.weight, p.image]
      );
    }
    await client.query('COMMIT');
    const out = mapCatalog({ ...src, id: newId, name: src.name + ' (cópia)' }, pgs.rowCount);
    res.status(201).json(out);
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

// POST /api/catalogs/:id/pages -> adiciona página no fim
r.post('/:id/pages', async (req, res, next) => {
  try {
    const c = await pool.query(`SELECT id FROM catalogs WHERE id=$1`, [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ error: 'Catálogo não encontrado' });
    const pos = await pool.query(`SELECT COALESCE(MAX(position),-1)+1 AS next FROM pages WHERE catalog_id=$1`, [req.params.id]);
    const b = req.body || {};
    const id = randomUUID();
    const q = await pool.query(
      `INSERT INTO pages (id, catalog_id, position, name, price, description, material, dimensions, colors, weight, image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, req.params.id, pos.rows[0].next, b.name || '', b.price || '', b.description || '',
       b.material || '', b.dimensions || '', b.colors || '', b.weight || '', b.image || null]
    );
    await pool.query(`UPDATE catalogs SET updated_at=now() WHERE id=$1`, [req.params.id]);
    res.status(201).json(mapPage(q.rows[0]));
  } catch (e) { next(e); }
});

// PUT /api/catalogs/:id/reorder -> body { order: [pageId, ...] }
r.put('/:id/reorder', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(`UPDATE pages SET position=$1 WHERE id=$2 AND catalog_id=$3`, [i, order[i], req.params.id]);
    }
    await client.query(`UPDATE catalogs SET updated_at=now() WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

export default r;
