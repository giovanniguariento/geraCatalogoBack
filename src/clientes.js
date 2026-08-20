// Saldo de clientes: pré-compra de kg, retiradas graduais e histórico.
import { pool } from './db.js';

export async function initClientes() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      anotacoes  TEXT NOT NULL DEFAULT '',
      saldo      NUMERIC(12,3) NOT NULL DEFAULT 0,
      total      NUMERIC(12,3) NOT NULL DEFAULT 0,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cliente_mov (
      id         SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      tipo       TEXT NOT NULL,                 -- 'credito' | 'retirada'
      kg         NUMERIC(12,3) NOT NULL,        -- positivo p/ crédito, positivo (retirado) p/ retirada
      saldo_apos NUMERIC(12,3) NOT NULL,
      obs        TEXT NOT NULL DEFAULT '',
      data       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cliente_mov ON cliente_mov(cliente_id, data DESC)`);
}

const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
};
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

function mapCliente(r) {
  return {
    id: r.id,
    nome: r.nome,
    anotacoes: r.anotacoes || '',
    saldo: Number(r.saldo),
    total: Number(r.total),
    criadoEm: r.criado_em,
  };
}
function mapMov(r) {
  return { id: r.id, tipo: r.tipo, kg: Number(r.kg), saldoApos: Number(r.saldo_apos), obs: r.obs || '', data: r.data };
}

export async function listClientes() {
  const q = await pool.query('SELECT * FROM clientes ORDER BY nome ASC');
  return q.rows.map(mapCliente);
}

export async function getCliente(id) {
  const c = await pool.query('SELECT * FROM clientes WHERE id=$1', [id]);
  if (!c.rowCount) throw new Error('Cliente não encontrado.');
  const m = await pool.query('SELECT * FROM cliente_mov WHERE cliente_id=$1 ORDER BY data DESC, id DESC', [id]);
  return { cliente: mapCliente(c.rows[0]), historico: m.rows.map(mapMov) };
}

export async function criarCliente({ nome, anotacoes }) {
  nome = String(nome || '').trim();
  if (!nome) throw new Error('Informe o nome do cliente.');
  const q = await pool.query(
    'INSERT INTO clientes (nome, anotacoes) VALUES ($1,$2) RETURNING *',
    [nome, String(anotacoes || '')]
  );
  return mapCliente(q.rows[0]);
}

export async function editarCliente(id, { nome, anotacoes }) {
  const atual = await pool.query('SELECT * FROM clientes WHERE id=$1', [id]);
  if (!atual.rowCount) throw new Error('Cliente não encontrado.');
  const q = await pool.query(
    'UPDATE clientes SET nome=$1, anotacoes=$2 WHERE id=$3 RETURNING *',
    [nome != null ? String(nome).trim() || atual.rows[0].nome : atual.rows[0].nome,
     anotacoes != null ? String(anotacoes) : atual.rows[0].anotacoes, id]
  );
  return mapCliente(q.rows[0]);
}

export async function removerCliente(id) { await pool.query('DELETE FROM clientes WHERE id=$1', [id]); return true; }

// Registra crédito (pré-compra) ou retirada. Atualiza saldo e grava no histórico (transação).
async function movimentar(id, tipo, kgInput, obs, dataInput) {
  const kg = round3(num(kgInput));
  if (!(kg > 0)) throw new Error('Informe uma quantidade em kg maior que zero.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cq = await client.query('SELECT * FROM clientes WHERE id=$1 FOR UPDATE', [id]);
    if (!cq.rowCount) throw new Error('Cliente não encontrado.');
    const c = cq.rows[0];
    const saldoAtual = Number(c.saldo);
    const saldoApos = round3(tipo === 'credito' ? saldoAtual + kg : saldoAtual - kg);
    const total = tipo === 'credito' ? round3(Number(c.total) + kg) : Number(c.total);
    await client.query('UPDATE clientes SET saldo=$1, total=$2 WHERE id=$3', [saldoApos, total, id]);
    const data = dataInput ? new Date(dataInput) : new Date();
    await client.query(
      'INSERT INTO cliente_mov (cliente_id, tipo, kg, saldo_apos, obs, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, tipo, kg, saldoApos, String(obs || ''), isNaN(data) ? new Date() : data]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getCliente(id);
}

export async function adicionarCredito(id, { kg, obs, data }) { return movimentar(id, 'credito', kg, obs, data); }
export async function registrarRetirada(id, { kg, obs, data }) { return movimentar(id, 'retirada', kg, obs, data); }

// Remove uma movimentação e recalcula o saldo do cliente.
export async function removerMovimentacao(clienteId, movId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM cliente_mov WHERE id=$1 AND cliente_id=$2', [movId, clienteId]);
    const movs = await client.query('SELECT tipo, kg FROM cliente_mov WHERE cliente_id=$1', [clienteId]);
    let saldo = 0, total = 0;
    for (const m of movs.rows) {
      const kg = Number(m.kg);
      if (m.tipo === 'credito') { saldo += kg; total += kg; } else { saldo -= kg; }
    }
    await client.query('UPDATE clientes SET saldo=$1, total=$2 WHERE id=$3', [round3(saldo), round3(total), clienteId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return getCliente(clienteId);
}
