import express from 'express';
import 'dotenv/config';
import { initDb } from './db.js';
import catalogs from './routes/catalogs.js';
import pages from './routes/pages.js';
import { oauthRouter, dataRouter as blingData } from './routes/bling.js';
import { cnabRouter } from './routes/cnab.js';
import { authRouter } from './routes/auth.js';
import { initAuth, requireAuth, requirePerm } from './auth.js';
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
  res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization, x-api-key');
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
app.get('/health', (_req, res) => res.json({ ok: true, build: 'auth-login-v1', ts: '2026-06-23' }));

// OAuth do Bling é visitado no navegador (Bling redireciona pra cá),
// então fica FORA de /api e não passa pela trava de chave de API.
app.use('/bling', oauthRouter);

// Login é público; as rotas de usuários exigem admin (checado dentro do router).
app.use('/api/auth', authRouter);

// Daqui pra baixo, tudo em /api exige estar logado.
app.use('/api', requireAuth);

app.use('/api/catalogs', requirePerm('catalogos'), catalogs);
// Router do Bling: status/busca liberado a qualquer logado; fila e filamentos por permissão.
app.use('/api/bling', (req, res, next) => {
  const p = req.path || '';
  if (p.startsWith('/fila') || p.startsWith('/estoque')) return requirePerm('fila')(req, res, next);
  if (p.startsWith('/filamentos') || p.startsWith('/deposito')) return requirePerm('filamentos')(req, res, next);
  return next();
}, blingData);
app.use('/api/zpl', requirePerm('zpl'), zplRouter); // conversor ZPL -> PDF
app.use('/api/cnab', requirePerm('cnab'), cnabRouter); // guias -> CNAB 240 Itaú
app.use('/api', requirePerm('catalogos'), pages); // /api/pages/:id (parte dos catálogos)

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno', detail: String(err.message || err) });
});

initDb()
  .then(() => initAuth())
  .then(() => app.listen(PORT, () => {
    console.log(`[api] rodando na porta ${PORT}`);
    startFilaAutoSync();
  }))
  .catch((e) => { console.error('[db] falha ao iniciar:', e); process.exit(1); });
