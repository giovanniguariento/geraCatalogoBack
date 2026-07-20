// Autenticação (senha com hash + JWT) e permissões por tela.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || ('dev-' + Math.random().toString(36).slice(2));
if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET não definido — defina em produção (senão os logins caem a cada restart).');

// Telas que podem ser liberadas por usuário. Admin acessa tudo + a tela de usuários.
export const PERMISSOES = ['catalogos', 'fila', 'filamentos', 'zpl', 'cnab', 'relatorios', 'calculadora'];

function mapUser(r) {
  return { id: r.id, email: r.email, nome: r.nome, role: r.role, permissoes: r.permissoes || [], ativo: r.ativo };
}

export async function initAuth() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      nome        TEXT NOT NULL DEFAULT '',
      senha_hash  TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      permissoes  JSONB NOT NULL DEFAULT '[]'::jsonb,
      ativo       BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const email = String(process.env.ADMIN_EMAIL || 'admin@boreal3d.com').trim().toLowerCase();
  const senha = process.env.ADMIN_PASSWORD || 'boreal123';
  const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (!exists.rowCount) {
    const hash = await bcrypt.hash(senha, 10);
    await pool.query(
      `INSERT INTO users (email, nome, senha_hash, role, permissoes, ativo) VALUES ($1,$2,$3,'admin','[]'::jsonb,true)`,
      [email, 'Administrador', hash]
    );
    console.log(`[auth] admin criado: ${email}${process.env.ADMIN_PASSWORD ? '' : ' — senha padrão "boreal123", TROQUE!'}`);
  }
}

export function signToken(u) {
  return jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '30d' });
}

async function rowById(id) {
  const q = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return q.rowCount ? q.rows[0] : null;
}

export async function login(email, senha) {
  email = String(email || '').trim().toLowerCase();
  const q = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (!q.rowCount) throw new Error('E-mail ou senha inválidos.');
  const u = q.rows[0];
  if (!u.ativo) throw new Error('Usuário desativado. Fale com o administrador.');
  const ok = await bcrypt.compare(String(senha || ''), u.senha_hash);
  if (!ok) throw new Error('E-mail ou senha inválidos.');
  return { token: signToken(u), user: mapUser(u) };
}

// ---------- middlewares ----------
export async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const payload = jwt.verify(token, JWT_SECRET);
    const u = await rowById(payload.id);
    if (!u || !u.ativo) return res.status(401).json({ error: 'Sessão inválida' });
    req.user = mapUser(u);
    next();
  } catch { return res.status(401).json({ error: 'Sessão inválida' }); }
}
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador' });
  next();
}
export function requirePerm(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (req.user.role === 'admin') return next();
    if ((req.user.permissoes || []).includes(key)) return next();
    return res.status(403).json({ error: 'Sem permissão para esta área' });
  };
}

// ---------- CRUD (admin) ----------
export async function listUsers() {
  const q = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
  return q.rows.map(mapUser);
}
export async function createUser({ email, nome, senha, permissoes, role }) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !senha) throw new Error('E-mail e senha são obrigatórios.');
  const perms = Array.isArray(permissoes) ? permissoes.filter((p) => PERMISSOES.includes(p)) : [];
  const hash = await bcrypt.hash(String(senha), 10);
  try {
    const q = await pool.query(
      `INSERT INTO users (email, nome, senha_hash, role, permissoes, ativo) VALUES ($1,$2,$3,$4,$5::jsonb,true) RETURNING *`,
      [email, String(nome || ''), hash, role === 'admin' ? 'admin' : 'user', JSON.stringify(perms)]
    );
    return mapUser(q.rows[0]);
  } catch (e) {
    if (e.code === '23505' || String(e.message).includes('unique')) throw new Error('Já existe um usuário com esse e-mail.');
    throw e;
  }
}
export async function updateUser(id, { nome, permissoes, role, ativo, senha }) {
  const u = await rowById(id);
  if (!u) throw new Error('Usuário não encontrado.');
  const perms = Array.isArray(permissoes) ? permissoes.filter((p) => PERMISSOES.includes(p)) : (u.permissoes || []);
  const newRole = role === 'admin' ? 'admin' : (role === 'user' ? 'user' : u.role);
  const newAtivo = typeof ativo === 'boolean' ? ativo : u.ativo;
  let hash = u.senha_hash;
  if (senha) hash = await bcrypt.hash(String(senha), 10);
  const q = await pool.query(
    `UPDATE users SET nome=$1, permissoes=$2::jsonb, role=$3, ativo=$4, senha_hash=$5 WHERE id=$6 RETURNING *`,
    [nome != null ? String(nome) : u.nome, JSON.stringify(perms), newRole, newAtivo, hash, id]
  );
  return mapUser(q.rows[0]);
}
export async function deleteUser(id) { await pool.query('DELETE FROM users WHERE id=$1', [id]); return true; }
export async function getUser(id) { const r = await rowById(id); return r ? mapUser(r) : null; }
export async function countAdmins() {
  const q = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND ativo=true`);
  return q.rows[0].n;
}
