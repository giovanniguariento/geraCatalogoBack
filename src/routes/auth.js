import { Router } from 'express';
import {
  login, requireAuth, requireAdmin,
  listUsers, createUser, updateUser, deleteUser, getUser, countAdmins,
  PERMISSOES,
} from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  try { const { email, senha } = req.body || {}; res.json(await login(email, senha)); }
  catch (e) { res.status(401).json({ error: String(e.message || e) }); }
});

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user, permissoes: PERMISSOES }));

authRouter.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  try { res.json({ users: await listUsers(), permissoes: PERMISSOES }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

authRouter.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try { res.json({ user: await createUser(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

authRouter.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    // não deixar o admin se auto-rebaixar/desativar sendo o único admin
    if (id === req.user.id && (body.role === 'user' || body.ativo === false)) {
      if (await countAdmins() <= 1) throw new Error('Você é o único administrador ativo.');
    }
    res.json({ user: await updateUser(id, body) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

authRouter.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new Error('Você não pode excluir a si mesmo.');
    const alvo = await getUser(id);
    if (alvo && alvo.role === 'admin' && await countAdmins() <= 1) throw new Error('Não é possível excluir o único administrador.');
    await deleteUser(id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
