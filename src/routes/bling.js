import { Router } from 'express';
import {
  blingConfigured, isConnected, buildAuthUrl, checkState, exchangeCode,
  searchProducts, getProductDetail, rememberReturnUrl, resolveReturnUrl, warmProductCache,
} from '../bling.js';

// Páginas HTML simples (fallback quando não há frontend pra onde voltar)
function htmlPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <body style="font-family:system-ui,sans-serif;background:#f4f7fb;color:#0e1a2b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
  <div style="background:#fff;border:1px solid #dde6f0;border-radius:16px;padding:32px 36px;max-width:440px;box-shadow:0 12px 32px rgba(16,30,55,.1);text-align:center">
  ${body}</div></body>`;
}
function withParam(url, key, val) {
  return url + (url.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(val);
}

// ---- Rotas visitadas no NAVEGADOR (sem chave de API) ----
export const oauthRouter = Router();

oauthRouter.get('/connect', async (req, res) => {
  if (!blingConfigured()) {
    return res.status(200).send(htmlPage('Bling não configurado',
      `<h2 style="margin:0 0 10px">Bling ainda não configurado</h2>
       <p style="color:#5a6b81;line-height:1.5">Defina <b>BLING_CLIENT_ID</b> e <b>BLING_CLIENT_SECRET</b> nas variáveis do serviço e tente novamente.</p>`));
  }
  try {
    await rememberReturnUrl(req.query.return); // pra onde voltar depois
    const url = await buildAuthUrl();
    res.redirect(url);
  } catch (e) {
    res.status(500).send(htmlPage('Erro', `<p>Não foi possível iniciar a autorização: ${e.message}</p>`));
  }
});

oauthRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const target = await resolveReturnUrl();

  const fail = (msg) => target
    ? res.redirect(withParam(target, 'bling', 'error'))
    : res.status(400).send(htmlPage('Erro', `<h2>Não foi possível conectar</h2><p style="color:#5a6b81">${msg}</p>`));

  if (!code) return fail('Nenhum código recebido do Bling.');
  if (!(await checkState(state))) return fail('State inválido. Tente conectar novamente.');

  try {
    await exchangeCode(String(code));
    if (target) return res.redirect(withParam(target, 'bling', 'connected'));
    res.send(htmlPage('Conectado!',
      `<div style="font-size:40px">✅</div>
       <h2 style="margin:8px 0 10px">Bling conectado com sucesso</h2>
       <p style="color:#5a6b81;line-height:1.5">Já pode fechar esta aba e voltar ao Gerador de Catálogos.</p>`));
  } catch (e) {
    fail(e.message);
  }
});

// ---- Rotas chamadas pelo FRONTEND (sob /api) ----
export const dataRouter = Router();

dataRouter.get('/status', async (_req, res) => {
  const connected = await isConnected();
  if (connected) warmProductCache(); // aquece o cache em segundo plano
  res.json({ configured: blingConfigured(), connected });
});

dataRouter.get('/produtos', async (req, res) => {
  if (!(await isConnected())) return res.json({ connected: false, items: [] });
  const items = await searchProducts(String(req.query.q || ''));
  res.json({ connected: true, items });
});

dataRouter.get('/produtos/:id', async (req, res) => {
  if (!(await isConnected())) return res.json({ connected: false, produto: null });
  const produto = await getProductDetail(req.params.id);
  res.json({ connected: true, produto });
});
