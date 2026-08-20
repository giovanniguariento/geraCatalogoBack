import { Router } from 'express';
import {
  listClientes, getCliente, criarCliente, editarCliente, removerCliente,
  adicionarCredito, registrarRetirada, removerMovimentacao,
} from '../clientes.js';

export const clientesRouter = Router();

clientesRouter.get('/', async (_req, res) => {
  try { res.json({ clientes: await listClientes() }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.get('/:id', async (req, res) => {
  try { res.json(await getCliente(Number(req.params.id))); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.post('/', async (req, res) => {
  try { res.json({ cliente: await criarCliente(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.put('/:id', async (req, res) => {
  try { res.json({ cliente: await editarCliente(Number(req.params.id), req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.delete('/:id', async (req, res) => {
  try { await removerCliente(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.post('/:id/credito', async (req, res) => {
  try { res.json(await adicionarCredito(Number(req.params.id), req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.post('/:id/retirada', async (req, res) => {
  try { res.json(await registrarRetirada(Number(req.params.id), req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

clientesRouter.post('/:id/mov/:movId/remover', async (req, res) => {
  try { res.json(await removerMovimentacao(Number(req.params.id), Number(req.params.movId))); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
