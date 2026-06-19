import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { initDb } from './db.js';
import catalogs from './routes/catalogs.js';
import pages from './routes/pages.js';
import { oauthRouter, dataRouter as blingData } from './routes/bling.js';
import zplRouter from './routes/zpl.js';
import { startFilaAutoSync } from './bling.js';

const app = express();
const PORT = process.env.PORT || 4000;

// CORS: por padrão libera geral. Para restringir, defina FRONTEND_URL=https://seuapp.vercel.app
const origin = process.env.FRONTEND_URL || true;
app.use(cors({ origin }));

// imagens em base64 viajam no corpo JSON -> limite maior
app.use(express.json({ limit: '25mb' }));

// Trava opcional por chave de API. Se API_KEY estiver definida no backend,
// o frontend precisa enviar o header x-api-key com o mesmo valor.
app.use('/api', (req, res, next) => {
  if (!process.env.API_KEY) return next();
  if (req.headers['x-api-key'] === process.env.API_KEY) return next();
  return res.status(401).json({ error: 'Não autorizado' });
});

app.get('/', (_req, res) => res.json({ name: 'Boreal3D Catálogos API', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// OAuth do Bling é visitado no navegador (Bling redireciona pra cá),
// então fica FORA de /api e não passa pela trava de chave de API.
app.use('/bling', oauthRouter);

app.use('/api/catalogs', catalogs);
app.use('/api/bling', blingData); // status + busca de produtos (usado pelo frontend)
app.use('/api/zpl', zplRouter); // conversor ZPL -> PDF
app.use('/api', pages); // /api/pages/:id

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno', detail: String(err.message || err) });
});

initDb()
  .then(() => app.listen(PORT, () => {
    console.log(`[api] rodando na porta ${PORT}`);
    startFilaAutoSync();
  }))
  .catch((e) => { console.error('[db] falha ao iniciar:', e); process.exit(1); });
