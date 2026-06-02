import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL não definida. Configure a variável de ambiente.');
}

// SSL ligado por padrão (Railway exige). Em ambiente local, defina DATABASE_SSL=false.
const useSsl = process.env.DATABASE_SSL !== 'false';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalogs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      brand       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id          TEXT PRIMARY KEY,
      catalog_id  TEXT NOT NULL REFERENCES catalogs(id) ON DELETE CASCADE,
      position    INT NOT NULL DEFAULT 0,
      name        TEXT NOT NULL DEFAULT '',
      price       TEXT DEFAULT '',
      description TEXT DEFAULT '',
      material    TEXT DEFAULT '',
      dimensions  TEXT DEFAULT '',
      colors      TEXT DEFAULT '',
      weight      TEXT DEFAULT '',
      image       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pages_catalog ON pages(catalog_id);`);
  console.log('[db] tabelas prontas.');
}

// Helpers de mapeamento (snake_case -> camelCase)
export function mapCatalog(row, pageCount) {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pageCount: pageCount != null ? Number(pageCount) : undefined,
  };
}

export function mapPage(row) {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    position: row.position,
    name: row.name,
    price: row.price,
    description: row.description,
    material: row.material,
    dimensions: row.dimensions,
    colors: row.colors,
    weight: row.weight,
    image: row.image,
  };
}
