import express from 'express';
import 'dotenv/config';
import { initDb } from './db.js';
import catalogs from './routes/catalogs.js';
import pages from './routes/pages.js';
import { oauthRouter, dataRouter as blingData } from './routes/bling.js';
import { cnabRouter } from './routes/cnab.js';
import zplRouter from './routes/zpl.js';
import { startFilaAutoSync } from './bling.js';

const app = express();
const PORT = process.env.PORT || 4000;

// CORS manual e à prova de falhas: garante os headers em TODA resposta,
// inclusive no preflight (OPTIONS), refletindo a origem que chamou.
// Para restringir, defina FRONTEND_URL e troque a linha do Allow-Origin.
app.use((req, res, next) => {
  const allow = process.env.FRONTEND_URL || req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', allow);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, x-api-key');
  res.header('Access-Control-Expose-Headers', 'X-Label-Count, X-Label-Total, X-Label-Index, Content-Disposition');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
app.get('/health', (_req, res) => res.json({ ok: true, build: 'cnab-itau-gnre', ts: '2026-06-22b' }));

// OAuth do Bling é visitado no navegador (Bling redireciona pra cá),
// então fica FORA de /api e não passa pela trava de chave de API.
app.use('/bling', oauthRouter);

app.use('/api/catalogs', catalogs);
app.use('/api/bling', blingData); // status + busca de produtos (usado pelo frontend)
app.use('/api/zpl', zplRouter); // conversor ZPL -> PDF
app.use('/api/cnab', cnabRouter); // guias -> CNAB 240 Itaú
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
