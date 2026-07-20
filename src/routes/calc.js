import { Router } from 'express';
import { getCalcConfig, setCalcConfig, calcular } from '../calc.js';

export const calcRouter = Router();

calcRouter.get('/config', async (_req, res) => {
  try { res.json({ config: await getCalcConfig() }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

calcRouter.post('/config', async (req, res) => {
  try { res.json({ config: await setCalcConfig(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

calcRouter.post('/calcular', async (req, res) => {
  try {
    const cfg = await getCalcConfig();
    res.json({ resultado: calcular(req.body || {}, cfg), config: cfg });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
