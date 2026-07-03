import { Router } from 'express';
import {
  blingConfigured, isConnected, buildAuthUrl, checkState, exchangeCode,
  searchProducts, getProductDetail, getProductBySku, rememberReturnUrl, resolveReturnUrl, warmProductCache,
  discoverySample, blingDiagnostics, startWeightReportJob, getReportJob,
  getFila, syncFila, getLastSync, addManualFila, setFilaPrinted, concluirFila, removeFilaItem, importFila,
  getEstoque, setEstoque, removeEstoque,
  listDepositos, getDefaultDepositoId, setDepositoId,
  filamentosComSaldo, addFilamento, removeFilamento, entradaFilamento, balancoFilamento,
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

// TEMPORÁRIO: diagnóstico, aberto no navegador.
oauthRouter.get('/debug/diagnostico', async (_req, res) => {
  if (!blingConfigured()) return res.status(400).json({ error: 'Bling não configurado (faltam BLING_CLIENT_ID/SECRET)' });
  try {
    const data = await blingDiagnostics();
    res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// TEMPORÁRIO: amostra de descoberta, aberta no navegador.
oauthRouter.get('/debug/amostra', async (_req, res) => {
  if (!blingConfigured()) return res.status(400).json({ error: 'Bling não configurado' });
  if (!(await isConnected())) return res.status(400).json({ error: 'Bling não conectado' });
  try {
    const data = await discoverySample();
    res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

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

dataRouter.get('/produto-por-sku', async (req, res) => {
  if (!(await isConnected())) return res.json({ connected: false, found: false, produto: null });
  try {
    const r = await getProductBySku(String(req.query.sku || ''));
    res.json({ connected: true, ...r });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Relatório: peso líquido vendido por fornecedor, no mês (em segundo plano)
dataRouter.get('/relatorio/peso-fornecedor/iniciar', async (req, res) => {
  if (!(await isConnected())) return res.status(400).json({ error: 'Bling não conectado' });
  const { ano, mes, fornecedor } = req.query;
  if (!ano || !mes || !fornecedor) {
    return res.status(400).json({ error: 'Informe ano, mes e fornecedor' });
  }
  const jobId = startWeightReportJob({ ano, mes, fornecedor: String(fornecedor) });
  res.json({ jobId });
});

dataRouter.get('/relatorio/peso-fornecedor/status', (req, res) => {
  const job = getReportJob(String(req.query.jobId || ''));
  if (!job) return res.status(404).json({ error: 'Job não encontrado (pode ter expirado). Recalcule.' });
  res.json({ status: job.status, progress: job.progress, result: job.result, error: job.error });
});

// ---- Fila de impressão ----
dataRouter.get('/fila', async (_req, res) => {
  try { res.json({ fila: await getFila(), lastSync: await getLastSync() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/atualizar', async (_req, res) => {
  if (!(await isConnected())) return res.status(400).json({ error: 'Bling não conectado' });
  try { res.json(await syncFila()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/manual', async (req, res) => {
  try { res.json({ fila: await addManualFila(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/impresso', async (req, res) => {
  const { sku, printed } = req.body || {};
  try { res.json({ fila: await setFilaPrinted(sku, printed) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/concluir', async (req, res) => {
  const { sku } = req.body || {};
  try { res.json(await concluirFila(sku)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.get('/estoque', async (_req, res) => {
  try { res.json({ estoque: await getEstoque() }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/estoque', async (req, res) => {
  try { res.json({ estoque: await setEstoque(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/estoque/remover', async (req, res) => {
  const { sku } = req.body || {};
  try { res.json({ estoque: await removeEstoque(sku) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/remover', async (req, res) => {
  const { sku } = req.body || {};
  try { res.json({ fila: await removeFilaItem(sku) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/fila/importar', async (req, res) => {
  try { res.json(await importFila(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---- Estoque de filamentos ----
dataRouter.get('/depositos', async (_req, res) => {
  try { res.json({ depositos: await listDepositos(), atual: await getDefaultDepositoId() }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/deposito', async (req, res) => {
  try { res.json({ atual: await setDepositoId((req.body || {}).id) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.get('/filamentos', async (_req, res) => {
  try { res.json(await filamentosComSaldo()); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/filamentos', async (req, res) => {
  try { res.json(await addFilamento((req.body || {}).id)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/filamentos/remover', async (req, res) => {
  try { res.json(await removeFilamento((req.body || {}).id)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/filamentos/entrada', async (req, res) => {
  try { res.json(await entradaFilamento(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

dataRouter.post('/filamentos/balanco', async (req, res) => {
  try { res.json(await balancoFilamento(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
