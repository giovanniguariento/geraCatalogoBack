// Integração com a API v3 do Bling.
// TUDO aqui é opcional: se as credenciais não existirem, as funções
// retornam "não conectado" sem lançar erro — o resto do sistema segue normal.

import { getConfig, setConfig } from './db.js';

const CLIENT_ID = process.env.BLING_CLIENT_ID || '';
const CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '';

// URLs (configuráveis por env, com defaults da documentação oficial v3)
const AUTHORIZE_URL = process.env.BLING_AUTHORIZE_URL || 'https://www.bling.com.br/Api/v3/oauth/authorize';
const TOKEN_URL = process.env.BLING_TOKEN_URL || 'https://www.bling.com.br/Api/v3/oauth/token';
const API_URL = process.env.BLING_API_URL || 'https://api.bling.com.br/Api/v3';

const DISCOUNT = (() => {
  const d = parseFloat(process.env.BLING_PRICE_DISCOUNT || '0.20');
  return isNaN(d) ? 0.20 : Math.min(Math.max(d, 0), 1);
})();

const TOKENS_KEY = 'bling_tokens';
const STATE_KEY = 'bling_oauth_state';
const RETURN_KEY = 'bling_return';

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
  catch { return false; }
}

// Guarda para onde voltar após autorizar (a URL do frontend)
export async function rememberReturnUrl(url) {
  if (isHttpUrl(url)) await setConfig(RETURN_KEY, String(url));
}
// FRONTEND_URL (se definida) tem prioridade; senão usa o retorno informado pelo app
export async function resolveReturnUrl() {
  if (isHttpUrl(process.env.FRONTEND_URL)) return process.env.FRONTEND_URL;
  const r = await getConfig(RETURN_KEY);
  return isHttpUrl(r) ? r : null;
}

export function blingConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

async function loadTokens() {
  const raw = await getConfig(TOKENS_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function saveTokens(t) {
  await setConfig(TOKENS_KEY, JSON.stringify(t));
}

// ---- OAuth ----
export async function buildAuthUrl() {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  await setConfig(STATE_KEY, state);
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('state', state);
  return u.toString();
}

export async function checkState(state) {
  const saved = await getConfig(STATE_KEY);
  return !!state && !!saved && state === saved;
}

async function requestToken(bodyParams) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: new URLSearchParams(bodyParams).toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Bling token ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = await res.json();
  const tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in || 21600) * 1000) - 60000, // -60s de folga
  };
  await saveTokens(tokens);
  return tokens;
}

export async function exchangeCode(code) {
  return requestToken({ grant_type: 'authorization_code', code });
}

async function refreshTokens(refresh_token) {
  return requestToken({ grant_type: 'refresh_token', refresh_token });
}

// Retorna um access_token válido, renovando se necessário. null se indisponível.
async function getAccessToken() {
  if (!blingConfigured()) return null;
  const t = await loadTokens();
  if (!t || !t.refresh_token) return null;
  if (!t.access_token || Date.now() >= t.expires_at) {
    try { const nt = await refreshTokens(t.refresh_token); return nt.access_token || null; }
    catch (e) { console.error('[bling] refresh falhou:', e.message); return null; }
  }
  return t.access_token;
}

export async function isConnected() {
  if (!blingConfigured()) return false;
  const t = await loadTokens();
  return !!(t && t.refresh_token);
}

// ---- Produtos ----
let _lastBlingReq = 0;
const _MIN_GAP = 360; // ms entre chamadas ao Bling (~2.7/s, abaixo do limite de 3/s)
async function paceGate() {
  const wait = _lastBlingReq + _MIN_GAP - Date.now();
  if (wait > 0) await sleep(wait);
  _lastBlingReq = Date.now();
}

async function blingGet(path) {
  let at = await getAccessToken();
  if (!at) return null;
  const doFetch = async (token) => {
    await paceGate();
    return fetch(API_URL + path, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
  };
  try {
    let res = await doFetch(at);
    if (res.status === 401) {
      // token rejeitado pelo Bling: força renovação e tenta uma vez mais
      const t = await loadTokens();
      if (t && t.refresh_token) {
        try {
          const nt = await refreshTokens(t.refresh_token);
          if (nt && nt.access_token) { at = nt.access_token; res = await doFetch(at); }
        } catch (e) { console.error('[bling] refresh após 401 falhou:', e.message); }
      }
    }
    // 429 (limite de 3 req/s): espera e tenta de novo
    let tentativas = 0;
    while (res.status === 429 && tentativas < 4) {
      await sleep(1200);
      res = await doFetch(at);
      tentativas++;
    }
    if (!res.ok) { console.error('[bling] GET', path, res.status); return null; }
    return await res.json();
  } catch (e) { console.error('[bling] GET', path, e.message); return null; }
}

// ---- Busca de produtos: cache + filtro "contém" local ----
// O filtro `nome` do Bling casa pelo começo/exato, então baixamos a lista
// de produtos, guardamos em cache e filtramos por "contém" (sem acento/caixa).
const CACHE_TTL = parseInt(process.env.BLING_CACHE_TTL_MS, 10) || (10 * 60 * 1000); // 10 min
const MAX_PAGES = parseInt(process.env.BLING_MAX_PAGES, 10) || 50; // até 50 x 100 = 5000 produtos
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

let productCache = { items: [], at: 0, loading: null };

async function fetchAllProducts() {
  const criterio = process.env.BLING_PRODUCT_CRITERIO || '5';
  const all = [];
  for (let pagina = 1; pagina <= MAX_PAGES; pagina++) {
    const params = new URLSearchParams({ criterio, pagina: String(pagina), limite: '100' });
    const j = await blingGet('/produtos?' + params.toString());
    const arr = j && Array.isArray(j.data) ? j.data : [];
    if (!arr.length) break;
    for (const p of arr) all.push({ id: p.id, nome: p.nome || '', codigo: p.codigo || '', preco: Number(p.preco) || 0 });
    if (arr.length < 100) break; // última página
  }
  return all;
}

async function getProductIndex() {
  const fresh = productCache.items.length && (Date.now() - productCache.at < CACHE_TTL);
  if (fresh) return productCache.items;
  if (productCache.loading) return productCache.loading; // dedupe de chamadas concorrentes
  productCache.loading = (async () => {
    try {
      const items = await fetchAllProducts();
      if (items.length) { productCache.items = items; productCache.at = Date.now(); }
      return productCache.items;
    } finally { productCache.loading = null; }
  })();
  return productCache.loading;
}

// Aquece o cache em segundo plano (chamado quando o frontend consulta o status)
export function warmProductCache() {
  if (!blingConfigured()) return;
  getProductIndex().catch(() => {});
}

export async function searchProducts(q) {
  if (!q || !q.trim()) return [];
  const nq = norm(q);
  const index = await getProductIndex();
  const matches = index.filter((p) => norm(p.nome).includes(nq) || norm(p.codigo).includes(nq));
  return matches.slice(0, 20);
}

// Consulta um produto pelo SKU (código): casa exato e, se não achar, "contém".
export async function getProductBySku(sku) {
  const want = norm(sku);
  if (!want) return { found: false };
  const index = await getProductIndex();
  let hit = index.find((p) => norm(p.codigo) === want);
  if (!hit) hit = index.find((p) => norm(p.codigo).includes(want));
  if (!hit) return { found: false };
  const produto = await getProductDetail(hit.id);
  return { found: !!produto, produto };
}

// ---- Relatório: peso líquido vendido por fornecedor, por mês ----
const produtoInfoCache = new Map(); // pid -> { pesoLiquido, fornecedorNome, nome }

async function getProdutoInfo(pid) {
  if (produtoInfoCache.has(pid)) return produtoInfoCache.get(pid);
  const j = await blingGet('/produtos/' + pid);
  const d = j && j.data ? j.data : null;
  const info = d ? {
    pesoLiquido: Number(d.pesoLiquido) || 0,
    fornecedorNome: (d.fornecedor && d.fornecedor.contato && d.fornecedor.contato.nome) || '',
    nome: d.nome || '',
  } : { pesoLiquido: 0, fornecedorNome: '', nome: '' };
  produtoInfoCache.set(pid, info);
  return info;
}

export async function relatorioPesoFornecedor(mes, fornecedorNome, opts = {}) {
  const paceMs = opts.paceMs || 340;
  const maxPedidos = opts.maxPedidos || 3000;
  if (!/^\d{4}-\d{2}$/.test(mes || '')) throw new Error('Mês inválido. Use o formato YYYY-MM (ex.: 2026-06).');
  if (!fornecedorNome || !fornecedorNome.trim()) throw new Error('Informe o fornecedor.');

  const [ano, m] = mes.split('-').map(Number);
  const di = `${ano}-${String(m).padStart(2, '0')}-01`;
  const ultimoDia = new Date(ano, m, 0).getDate();
  const df = `${ano}-${String(m).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;

  // 1) Lista de pedidos do período (paginado)
  const pedidos = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const j = await blingGet('/pedidos/vendas?' + new URLSearchParams({ dataInicial: di, dataFinal: df, pagina: String(pagina), limite: '100' }));
    const arr = j && Array.isArray(j.data) ? j.data : [];
    pedidos.push(...arr);
    if (arr.length < 100 || pedidos.length >= maxPedidos) break;
    await sleep(paceMs);
  }

  // 2) Itens de cada pedido (detalhe)
  const itens = [];
  for (const p of pedidos) {
    const d = await blingGet('/pedidos/vendas/' + p.id);
    const lista = d && d.data && Array.isArray(d.data.itens) ? d.data.itens : [];
    for (const it of lista) {
      const pid = it.produto && it.produto.id;
      if (pid) itens.push({ produtoId: pid, quantidade: Number(it.quantidade) || 0, descricao: it.descricao || '' });
    }
    await sleep(paceMs);
  }

  // 3) Info (peso + fornecedor) dos produtos distintos vendidos
  const distintos = [...new Set(itens.map((i) => i.produtoId))];
  for (const pid of distintos) {
    if (!produtoInfoCache.has(pid)) { await getProdutoInfo(pid); await sleep(paceMs); }
  }

  // 4) Filtra pelo fornecedor e soma quantidade × pesoLiquido
  const alvo = norm(fornecedorNome);
  const agg = new Map();
  let totalKg = 0;
  for (const it of itens) {
    const info = produtoInfoCache.get(it.produtoId);
    if (!info) continue;
    const fn = norm(info.fornecedorNome);
    if (!fn || (fn !== alvo && !fn.includes(alvo))) continue;
    const pesoTotal = it.quantidade * info.pesoLiquido;
    totalKg += pesoTotal;
    const cur = agg.get(it.produtoId) || {
      produtoId: it.produtoId, descricao: info.nome || it.descricao,
      fornecedor: info.fornecedorNome, quantidade: 0, pesoUnitarioKg: info.pesoLiquido, pesoTotalKg: 0,
    };
    cur.quantidade += it.quantidade;
    cur.pesoTotalKg = Math.round((cur.pesoTotalKg + pesoTotal) * 1000) / 1000;
    agg.set(it.produtoId, cur);
  }

  const detalhe = [...agg.values()].sort((a, b) => b.pesoTotalKg - a.pesoTotalKg);
  const semPeso = detalhe.filter((d) => d.pesoUnitarioKg === 0).map((d) => d.descricao);

  return {
    mes, fornecedor: fornecedorNome,
    periodo: { dataInicial: di, dataFinal: df },
    totalPedidosNoPeriodo: pedidos.length,
    produtosDoFornecedorVendidos: detalhe.length,
    totalKg: Math.round(totalKg * 1000) / 1000,
    alertaProdutosSemPesoCadastrado: semPeso,
    detalhe,
  };
}

// ---- Relatório: peso líquido vendido por fornecedor, no mês ----
const prodInfoCache = new Map();
const PROD_INFO_TTL = 24 * 60 * 60 * 1000;

async function getProductInfo(id) {
  const c = prodInfoCache.get(id);
  if (c && Date.now() - c.at < PROD_INFO_TTL) return c.v;
  const j = await blingGet('/produtos/' + id);
  const d = j && j.data ? j.data : null;
  const v = d ? {
    nome: d.nome || '',
    codigo: d.codigo || '',
    fornecedor: (d.fornecedor && d.fornecedor.contato && d.fornecedor.contato.nome) || '',
    pesoLiquido: Number(d.pesoLiquido) || 0,
  } : null;
  if (v) prodInfoCache.set(id, { v, at: Date.now() });
  return v;
}

// Cache de itens de pedido (pedidos fechados não mudam) — acelera reexecuções.
const orderItemsCache = new Map();
const ORDER_TTL = 60 * 60 * 1000;
async function getOrderItems(id) {
  const c = orderItemsCache.get(id);
  if (c && Date.now() - c.at < ORDER_TTL) return c.itens;
  const j = await blingGet('/pedidos/vendas/' + id);
  const raw = j && j.data && Array.isArray(j.data.itens) ? j.data.itens : [];
  const itens = raw.map((it) => ({
    pid: it.produto && it.produto.id,
    qtd: Number(it.quantidade) || 0,
    codigo: String(it.codigo || '').trim(),
    descricao: it.descricao || '',
    valor: Number(it.valor) || 0,
  }));
  orderItemsCache.set(id, { itens, at: Date.now() });
  return itens;
}

export async function weightSoldBySupplier({ ano, mes, fornecedor, onProgress }) {
  const report = (p) => { if (onProgress) onProgress(p); };
  const mm = String(mes).padStart(2, '0');
  const ultimoDia = new Date(Number(ano), Number(mes), 0).getDate();
  const dataInicial = `${ano}-${mm}-01`;
  const dataFinal = `${ano}-${mm}-${String(ultimoDia).padStart(2, '0')}`;
  const alvo = norm(fornecedor);

  // 1) Coletar todos os pedidos do mês (lista paginada)
  report({ fase: 'listando', totalPedidos: 0, processados: 0 });
  const pedidos = [];
  const MAX_PAG = 80; // até 8000 pedidos
  for (let pagina = 1; pagina <= MAX_PAG; pagina++) {
    const params = new URLSearchParams({ dataInicial, dataFinal, pagina: String(pagina), limite: '100' });
    const j = await blingGet('/pedidos/vendas?' + params.toString());
    const arr = j && Array.isArray(j.data) ? j.data : [];
    if (!arr.length) break;
    for (const p of arr) pedidos.push(p.id);
    if (arr.length < 100) break;
  }

  // 2) Para cada pedido, ler itens; enriquecer produto; filtrar fornecedor; somar
  report({ fase: 'processando', totalPedidos: pedidos.length, processados: 0 });
  let totalKg = 0, totalItens = 0, itensSemPeso = 0, processados = 0;
  const porProduto = new Map();
  for (const pedidoId of pedidos) {
    const itens = await getOrderItems(pedidoId);
    for (const it of itens) {
      if (!it.pid) continue;
      const info = await getProductInfo(it.pid);
      if (!info) continue;
      if (alvo && !norm(info.fornecedor).includes(alvo)) continue; // filtra pelo fornecedor
      const kg = it.qtd * info.pesoLiquido;
      if (info.pesoLiquido === 0) itensSemPeso += 1;
      totalKg += kg; totalItens += it.qtd;
      const cur = porProduto.get(it.pid) || { nome: info.nome, codigo: info.codigo, qtd: 0, pesoUnit: info.pesoLiquido, kg: 0 };
      cur.qtd += it.qtd; cur.kg += kg;
      porProduto.set(it.pid, cur);
    }
    processados += 1;
    report({ fase: 'processando', totalPedidos: pedidos.length, processados });
  }

  const produtos = [...porProduto.values()]
    .map((p) => ({ ...p, kg: Math.round(p.kg * 1000) / 1000 }))
    .sort((a, b) => b.kg - a.kg);

  return {
    fornecedor, ano: Number(ano), mes: Number(mes), dataInicial, dataFinal,
    pedidosNoPeriodo: pedidos.length,
    itensContabilizados: totalItens,
    totalKg: Math.round(totalKg * 1000) / 1000,
    alertaItensSemPeso: itensSemPeso,
    produtos,
  };
}

// ---- Jobs em segundo plano para o relatório ----
const reportJobs = new Map();
let _jobSeq = 0;
export function startWeightReportJob({ ano, mes, fornecedor }) {
  const jobId = Date.now().toString(36) + '-' + (++_jobSeq);
  const job = { status: 'running', progress: { fase: 'iniciando', totalPedidos: 0, processados: 0 }, result: null, error: null, startedAt: Date.now() };
  reportJobs.set(jobId, job);
  // limpa jobs antigos (> 30 min)
  for (const [k, v] of reportJobs) if (Date.now() - v.startedAt > 30 * 60 * 1000) reportJobs.delete(k);
  weightSoldBySupplier({ ano, mes, fornecedor, onProgress: (p) => { job.progress = p; } })
    .then((r) => { job.result = r; job.status = 'done'; })
    .catch((e) => { job.error = String(e.message || e); job.status = 'error'; });
  return jobId;
}
export function getReportJob(jobId) {
  return reportJobs.get(jobId) || null;
}

// ---- Fila de impressão (persistida no Postgres via app_config) ----
const FILA_KEY = 'fila_queue';            // mapa { sku: item }
const FILA_PROCESSED_KEY = 'fila_processed'; // array de pedidos já concluídos
const FILA_ALTA = Number(process.env.FILA_PRECO_ALTA || 49);
const FILA_MEDIA = Number(process.env.FILA_PRECO_MEDIA || 30);
const FILA_SITUACAO = process.env.FILA_ID_SITUACAO || '6'; // 6 = Em aberto
const FILA_DIAS_JANELA = Number(process.env.FILA_DIAS_JANELA || 3); // janela de data p/ não-Meli

function filaPriority(price) {
  const p = Number(price) || 0;
  if (p >= FILA_ALTA) return 'Alta';
  if (p >= FILA_MEDIA) return 'Média';
  return 'Baixa';
}
// Filamentos ficam fora da fila. Casamos pelo PRIMEIRO segmento do SKU (antes do
// primeiro "-"): prefixos de material (PLA, PETG…) por "começa com", e códigos
// curtos (PL, PG) só quando o segmento é EXATAMENTE igual — assim "PG" (filamento)
// é excluído, mas "PGO-PAR-DEC-GOT-MM" (produto) entra normalmente.
const FILA_FILAMENTO_PREFIXOS = (process.env.FILA_FILAMENTO_PREFIXOS || 'PL')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FILA_FILAMENTO_EXATOS = (process.env.FILA_FILAMENTO_EXATOS || 'PG')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

function isExcludedSku(sku) {
  const u = String(sku || '').toUpperCase().trim();
  if (!u) return true; // SKU vazio (rolos de filamento sem SKU)
  const seg = u.split('-')[0]; // primeiro segmento
  if (FILA_FILAMENTO_EXATOS.includes(seg)) return true; // "PL" / "PG" exatos
  return FILA_FILAMENTO_PREFIXOS.some((p) => seg.startsWith(p)); // "PLA…", "PETG…"
}
function isMaskedName(name) { return typeof name === 'string' && /\*/.test(name); }

function identifyMarketplace(numeroLoja) {
  const n = String(numeroLoja || '').trim();
  if (!n) return { id: 'direct', label: 'Direto' };
  if (/^\d{3}-\d{7}-\d{7}/.test(n)) return { id: 'amazon', label: 'Amazon' };
  if (/^\d+$/.test(n)) {
    if (n.length === 16) return { id: 'meli', label: 'Mercado Livre' };
    if (n.length === 18) return { id: 'tiktok', label: 'TikTok' };
  }
  if (/^\d{6,8}[A-Z0-9]+$/i.test(n)) return { id: 'shopee', label: 'Shopee' };
  return { id: 'other', label: 'Outros' };
}
function isMercadoLivre(numeroLoja) { return identifyMarketplace(numeroLoja).id === 'meli'; }

async function readFila() {
  const raw = await getConfig(FILA_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
async function writeFila(map) { await setConfig(FILA_KEY, JSON.stringify(map)); }
async function readProcessed() {
  const raw = await getConfig(FILA_PROCESSED_KEY);
  try { return new Set(raw ? JSON.parse(raw) : []); } catch { return new Set(); }
}
async function writeProcessed(set) { await setConfig(FILA_PROCESSED_KEY, JSON.stringify([...set])); }

// ---- Registro de estoque (aba Estoque): { sku: { sku, productName, stock, updatedAt } } ----
const FILA_ESTOQUE_KEY = 'fila_estoque';
async function readEstoque() {
  const raw = await getConfig(FILA_ESTOQUE_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
async function writeEstoque(map) { await setConfig(FILA_ESTOQUE_KEY, JSON.stringify(map)); }
function estoqueList(map) {
  return Object.values(map).sort((a, b) => String(a.productName || '').localeCompare(String(b.productName || ''), 'pt-BR'));
}

export async function getEstoque() { return estoqueList(await readEstoque()); }

export async function setEstoque({ sku, productName, stock }) {
  const key = String(sku || '').trim();
  if (!key) throw new Error('SKU é obrigatório');
  const map = await readEstoque();
  const prev = map[key] || {};
  map[key] = {
    sku: key,
    productName: productName != null ? String(productName) : (prev.productName || key),
    stock: Math.max(0, Number(stock) || 0),
    updatedAt: new Date().toISOString(),
  };
  await writeEstoque(map);
  return estoqueList(map);
}

export async function removeEstoque(sku) {
  const map = await readEstoque();
  delete map[String(sku)];
  await writeEstoque(map);
  return estoqueList(map);
}

async function filaResponse(queue) { return filaList(queue, await readEstoque()); }

function getOrderIds(item) {
  if (!item || !item.orderId) return [];
  return String(item.orderId).split(',').map((s) => s.trim()).filter(Boolean);
}

// Lista pedidos em aberto (situação 6). Não-Meli: janela dos últimos N dias.
// Meli: todos em aberto (sem filtro de data). Junta sem duplicar.
async function listOpenOrders() {
  const fmt = (d) => d.toISOString().split('T')[0];
  const hoje = new Date();
  const ini = new Date(hoje); ini.setDate(hoje.getDate() - FILA_DIAS_JANELA);
  const amanha = new Date(hoje); amanha.setDate(hoje.getDate() + 1);

  async function pages(params) {
    const out = [];
    for (let pagina = 1; pagina <= 50; pagina++) {
      const p = new URLSearchParams({ ...params, pagina: String(pagina), limite: '100' });
      const j = await blingGet('/pedidos/vendas?' + p.toString());
      const arr = j && Array.isArray(j.data) ? j.data : [];
      if (!arr.length) break;
      out.push(...arr);
      if (arr.length < 100) break;
    }
    return out;
  }

  const datados = (await pages({ idsSituacoes: FILA_SITUACAO, dataInicial: fmt(ini), dataFinal: fmt(amanha) }))
    .filter((o) => !isMercadoLivre(o.numeroLoja));
  const meli = (await pages({ idsSituacoes: FILA_SITUACAO }))
    .filter((o) => isMercadoLivre(o.numeroLoja));

  const seen = new Set();
  const merged = [];
  for (const o of [...meli, ...datados]) {
    if (FILA_SITUACAO && o.situacao && String(o.situacao.id) !== String(FILA_SITUACAO)) continue;
    if (!seen.has(o.id)) { seen.add(o.id); merged.push(o); }
  }
  return merged;
}

// Monta itens agregados por SKU a partir dos pedidos (com itens já carregados)
function buildPrintingQueue(orders) {
  const grouped = new Map();
  for (const order of orders) {
    const orderId = String(order.numero || order.id || '');
    const numeroLoja = String(order.numeroLoja || '').trim();
    const contactName = (order.contato && order.contato.nome) || '';
    const marketplace = identifyMarketplace(numeroLoja);

    // Nome mascarado → ignora, exceto Mercado Livre
    if (!isMercadoLivre(numeroLoja) && isMaskedName(contactName)) continue;

    for (const it of (order.itens || [])) {
      const sku = String(it.codigo || '').trim();
      if (!sku || isExcludedSku(sku)) continue;
      const productName = it.descricao || 'Produto sem nome';
      const quantity = Number(it.qtd) || 1;
      const price = Number(it.valor) || 0;

      if (grouped.has(sku)) {
        const e = grouped.get(sku);
        e.quantity += quantity;
        if (!e.orderIds.includes(orderId)) e.orderIds.push(orderId);
        if (numeroLoja && !e.lojaIds.includes(numeroLoja)) e.lojaIds.push(numeroLoja);
        if (!e.marketplaces.some((m) => m.id === marketplace.id)) e.marketplaces.push(marketplace);
      } else {
        grouped.set(sku, {
          orderIds: [orderId], lojaIds: numeroLoja ? [numeroLoja] : [],
          marketplaces: [marketplace], productName, sku, quantity, price,
          priority: filaPriority(price),
        });
      }
    }
  }
  return [...grouped.values()].map((it) => ({
    orderId: it.orderIds.join(', '), lojaId: it.lojaIds.join(', '),
    marketplaces: it.marketplaces, productName: it.productName, sku: it.sku,
    quantity: it.quantity, price: it.price, priority: it.priority,
  }));
}

// Merge dos itens do Bling com a fila persistida (não duplica pedidos já contados/concluídos)
async function mergeWithBling(blingItems) {
  const queue = await readFila();
  const processed = await readProcessed();

  for (const item of blingItems) {
    const sku = item.sku;
    const allIds = item.orderId.split(',').map((s) => s.trim()).filter(Boolean);
    const newIds = allIds.filter((id) => !processed.has(id));
    if (allIds.length > 0 && newIds.length === 0) continue; // todos já concluídos

    const newQty = newIds.length > 0 && allIds.length > 0
      ? Math.round(item.quantity * (newIds.length / allIds.length))
      : item.quantity;

    if (queue[sku] && !queue[sku].manual) {
      const prevIds = getOrderIds(queue[sku]);
      const brandNewIds = newIds.filter((id) => !prevIds.includes(id));
      if (brandNewIds.length > 0) {
        const addQty = Math.round(item.quantity * (brandNewIds.length / allIds.length));
        queue[sku].quantity += addQty;
        queue[sku].orderId = [...new Set([...prevIds, ...brandNewIds])].join(', ');
      }
      queue[sku].productName = item.productName;
      queue[sku].price = item.price;
      queue[sku].priority = item.priority;
      queue[sku].lojaId = item.lojaId;
      queue[sku].marketplaces = item.marketplaces;
      queue[sku]._seenInBling = true;
    } else if (!queue[sku]) {
      queue[sku] = {
        productName: item.productName, sku, quantity: newQty, printed: 0, stock: 0,
        price: item.price, priority: item.priority, orderId: newIds.join(', '),
        lojaId: item.lojaId, marketplaces: item.marketplaces, manual: false, _seenInBling: true,
      };
    }
  }
  await writeFila(queue);
  return queue;
}

function filaList(map, estoque = {}) {
  return Object.values(map)
    .filter((it) => it.sku && String(it.sku).trim())
    .map((it) => {
      const quantity = Number(it.quantity) || 0;
      const printed = Number(it.printed) || 0;
      const remaining = Math.max(0, quantity - printed);
      const reg = estoque[it.sku];
      const temEstoque = !!reg;                 // está cadastrado na aba Estoque?
      const stock = temEstoque ? Math.max(0, Number(reg.stock) || 0) : null;
      let reposicao = false, semEstoque = false, deficit = remaining;
      if (temEstoque) {
        deficit = Math.max(0, remaining - stock);
        reposicao = remaining > 0 && deficit === 0;   // estoque cobre os pedidos → reposição
        semEstoque = remaining > 0 && stock === 0;    // cadastrado, mas zerado → urgente
      }
      // Só vira reposição (baixa) quando o estoque cobre. Senão, prioridade pelo valor (como antes).
      const priority = reposicao ? 'Baixa' : filaPriority(it.price);
      return {
        productName: it.productName, sku: it.sku, quantity, printed, stock,
        remaining, deficit, reposicao, semEstoque, temEstoque,
        price: it.price, priority, orderId: it.orderId, lojaId: it.lojaId,
        marketplaces: it.marketplaces || [], manual: it.manual || false,
      };
    })
    .sort((a, b) => {
      if (a.reposicao !== b.reposicao) return a.reposicao ? 1 : -1;
      return (Number(b.price) || 0) - (Number(a.price) || 0);
    });
}

export async function getFila() { return filaResponse(await readFila()); }

export async function syncFila() {
  const orders = await listOpenOrders();
  // carrega itens de cada pedido
  for (const o of orders) {
    if (!o.itens) o.itens = await getOrderItems(o.id);
  }
  const blingItems = orders.length ? buildPrintingQueue(orders) : [];
  const queue = await mergeWithBling(blingItems);
  const lastSync = new Date().toISOString();
  await setConfig(FILA_SYNC_KEY, lastSync);
  return { pedidosLidos: orders.length, fila: await filaResponse(queue), lastSync };
}

const FILA_SYNC_KEY = 'fila_last_sync';
export async function getLastSync() { return (await getConfig(FILA_SYNC_KEY)) || null; }

export async function setFilaPrinted(sku, printed) {
  const queue = await readFila();
  const key = String(sku);
  if (!queue[key]) throw new Error('Item não encontrado na fila');
  const clamped = Math.max(0, Number(printed) || 0);
  queue[key].printed = clamped;
  if (clamped >= (Number(queue[key].quantity) || 0)) {
    const processed = await readProcessed();
    for (const id of getOrderIds(queue[key])) processed.add(id);
    await writeProcessed(processed);
    delete queue[key];
  }
  await writeFila(queue);
  return filaResponse(queue);
}

export async function addManualFila({ sku, productName, quantity, price, orderId }) {
  sku = String(sku || '').trim();
  if (!sku) throw new Error('SKU é obrigatório');
  const qtd = Number(quantity) || 0;
  if (qtd <= 0) throw new Error('Quantidade deve ser maior que zero');
  const valor = Number(price) || 0;
  if (valor <= 0) throw new Error('Preço é obrigatório');
  if (!productName) throw new Error('Nome é obrigatório');
  const queue = await readFila();
  if (queue[sku]) {
    queue[sku].quantity += qtd;
    if (orderId) queue[sku].orderId = [queue[sku].orderId, orderId].filter(Boolean).join(', ');
  } else {
    queue[sku] = {
      productName, sku, quantity: qtd, printed: 0,
      price: valor, priority: filaPriority(valor),
      orderId: orderId || '', lojaId: '', marketplaces: [{ id: 'direct', label: 'Manual' }],
      manual: true, _seenInBling: false,
    };
  }
  await writeFila(queue);
  return filaResponse(queue);
}

export async function removeFilaItem(sku) {
  const queue = await readFila();
  const key = Object.keys(queue).find((k) => k === sku || k.trim() === String(sku).trim());
  if (key === undefined) throw new Error('SKU não encontrado na fila');
  delete queue[key];
  await writeFila(queue);
  return filaResponse(queue);
}

export async function importFila({ queue, processed, seen }) {
  const out = {};
  const src = queue && typeof queue === 'object' ? queue : {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const sku = String(v.sku || k || '').trim();
    if (!sku || isExcludedSku(sku)) continue; // ignora SKU vazio e filamentos
    out[sku] = {
      productName: v.productName || sku, sku,
      quantity: Number(v.quantity) || 0, printed: Number(v.printed) || 0, stock: Number(v.stock) || 0,
      price: Number(v.price) || 0, priority: v.priority || filaPriority(v.price),
      orderId: v.orderId || '', lojaId: v.lojaId || '',
      marketplaces: Array.isArray(v.marketplaces) ? v.marketplaces : [],
      manual: !!v.manual, _seenInBling: v._seenInBling !== false,
    };
  }
  await writeFila(out);
  const arr = Array.isArray(processed) ? processed : (Array.isArray(seen) ? seen : []);
  await writeProcessed(new Set(arr.map(String)));
  return { itensImportados: Object.keys(out).length, pedidosConcluidos: arr.length };
}

// Auto-refresh da fila a cada 20 min (igual ao app antigo): mantém a fila
// atualizada no servidor pra todas as telas, sem depender de clique.
let _filaAutoTimer = null;
export function startFilaAutoSync(intervalMs = (Number(process.env.FILA_AUTOSYNC_MIN) || 5) * 60 * 1000) {
  if (_filaAutoTimer) return;
  const run = async () => {
    try {
      if (blingConfigured() && (await isConnected())) {
        const r = await syncFila();
        console.log(`[fila] auto-sync: ${r.pedidosLidos} pedidos lidos`);
      }
    } catch (e) { console.error('[fila] auto-sync falhou:', e.message); }
  };
  setTimeout(run, 15000); // primeira rodada 15s após subir
  _filaAutoTimer = setInterval(run, intervalMs);
}

// TEMPORÁRIO: diagnóstico do estado da conexão (status HTTP real de cada rota).
export async function blingDiagnostics() {
  const out = { configured: blingConfigured() };
  const t = await loadTokens();
  out.temRefreshToken = !!(t && t.refresh_token);
  out.accessTokenExpiraEm = t && t.expires_at ? new Date(t.expires_at).toISOString() : null;
  let at = await getAccessToken();
  out.conseguiuAccessToken = !!at;

  async function call(path, token) {
    if (!token) return { erro: 'sem access token válido' };
    try {
      let r = await fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      let tentativas = 0;
      while (r.status === 429 && tentativas < 4) {
        await sleep(1500);
        r = await fetch(API_URL + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
        tentativas++;
      }
      const body = await r.text();
      return { status: r.status, corpo: body.slice(0, 300) };
    } catch (e) { return { erro: String(e.message || e) }; }
  }

  out.teste_produtos = await call('/produtos?limite=1', at);

  // Se deu 401, tenta renovar e re-testar (revela se basta renovar ou precisa reconectar)
  if (out.teste_produtos && out.teste_produtos.status === 401 && t && t.refresh_token) {
    try {
      const nt = await refreshTokens(t.refresh_token);
      if (nt && nt.access_token) {
        out.renovacao_apos_401 = 'sucesso';
        at = nt.access_token;
        out.teste_produtos_apos_renovar = await call('/produtos?limite=1', at);
        out.teste_pedidos_apos_renovar = await call('/pedidos/vendas?limite=1', at);
      } else {
        out.renovacao_apos_401 = 'sem token na resposta';
      }
    } catch (e) {
      out.renovacao_apos_401 = 'FALHOU: ' + String(e.message || e);
    }
  } else {
    out.teste_pedidos = await call('/pedidos/vendas?limite=1', at);
  }
  return out;
}

// TEMPORÁRIO: amostra crua pra descobrir o formato real dos dados da conta.
// Usado uma vez pra confirmar os nomes dos campos; depois pode ser removido.
export async function discoverySample() {
  const out = {};
  // 1) Pedido de venda: lista (resumida) + detalhe (com itens)
  const lista = await blingGet('/pedidos/vendas?' + new URLSearchParams({ pagina: '1', limite: '1' }));
  out.pedido_lista = lista;
  const pedidoId = lista && Array.isArray(lista.data) && lista.data[0] ? lista.data[0].id : null;
  out.pedido_detalhe = pedidoId ? await blingGet('/pedidos/vendas/' + pedidoId) : null;

  // 2) Produto detalhado (pra ver se o fornecedor vem aqui)
  const prod = await blingGet('/produtos?' + new URLSearchParams({ criterio: '5', pagina: '1', limite: '1' }));
  const prodId = prod && Array.isArray(prod.data) && prod.data[0] ? prod.data[0].id : null;
  out.produto_detalhe = prodId ? await blingGet('/produtos/' + prodId) : null;

  // 3) Recurso de produto-fornecedor (testa o caminho mais provável)
  out.produtos_fornecedores = await blingGet('/produtos/fornecedores?' + new URLSearchParams({ pagina: '1', limite: '3' }));

  return out;
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const commaNum = (n) => String(n).replace('.', ',');

// Traduz a unidade de medida das dimensões. O Bling pode mandar um código
// numérico (ex.: 1) ou um rótulo. Padrão cm (padrão do Bling), configurável.
function dimUnit(u) {
  const s = String(u == null ? '' : u).trim();
  if (/[a-zA-Z]/.test(s)) {
    const low = s.toLowerCase();
    if (low.includes('mil') || low === 'mm') return 'mm';
    if (low.includes('cent') || low === 'cm') return 'cm';
    if (low.includes('met') || low === 'm') return 'm';
    return s;
  }
  return process.env.BLING_DIM_UNIT || 'cm';
}

// Procura uma URL de imagem na estrutura do produto. Tolerante a vários formatos.
const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
function pickLink(o) {
  if (isHttp(o)) return o;
  if (o && typeof o === 'object') return o.link || o.linkMiniatura || o.url || o.imageUrl || null;
  return null;
}
function extractImageUrl(d) {
  const m = d.midia || d.midias || {};
  const imgs = m.imagens || d.imagens || {};
  const groups = [];
  if (Array.isArray(imgs)) groups.push(imgs);
  else {
    if (Array.isArray(imgs.internas)) groups.push(imgs.internas);
    if (Array.isArray(imgs.externas)) groups.push(imgs.externas);
  }
  for (const g of groups) {
    for (const item of g) {
      const link = pickLink(item);
      if (isHttp(link)) return link; // dentro de midia.imagens: aceita qualquer link http
    }
  }
  for (const k of ['imagemURL', 'imagem', 'urlImagem', 'linkImagem']) {
    if (isHttp(d[k])) return d[k];
  }
  // varredura defensiva: URL sob chaves que pareçam imagem (evita vídeo / link da loja)
  let found = null;
  const scan = (o, keyHint = '', depth = 0) => {
    if (found || depth > 5 || !o || typeof o !== 'object') return;
    for (const [key, v] of Object.entries(o)) {
      if (found) return;
      const kl = (keyHint + ' ' + key).toLowerCase();
      if (isHttp(v)) {
        const looksImg = /imag|foto|thumb|midia|media/.test(kl) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(v);
        const isOther = /video|linkexterno|loja|site/.test(kl);
        if (looksImg && !isOther) { found = v; return; }
      } else if (v && typeof v === 'object') {
        scan(v, key, depth + 1);
      }
    }
  };
  scan(d);
  return found;
}

async function fetchImageAsDataUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) { console.error('[bling] imagem HTTP', res.status, url); return null; }
    let ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return null; // ignora imagens gigantes
    if (!ct.startsWith('image/')) {
      // alguns servidores não mandam content-type de imagem; deduz pela URL
      if (/\.png(\?|$)/i.test(url)) ct = 'image/png';
      else if (/\.webp(\?|$)/i.test(url)) ct = 'image/webp';
      else if (/\.gif(\?|$)/i.test(url)) ct = 'image/gif';
      else ct = 'image/jpeg';
    }
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (e) { console.error('[bling] imagem', e.message); return null; }
}

export async function getProductDetail(id) {
  const j = await blingGet('/produtos/' + encodeURIComponent(id));
  const d = j && j.data ? j.data : null;
  if (!d) return null;

  const precoBase = Number(d.preco) || 0;
  const precoSug = precoBase > 0 ? precoBase * (1 - DISCOUNT) : 0;

  const dim = d.dimensoes || {};
  const dimParts = [dim.largura, dim.altura, dim.profundidade]
    .filter((v) => v != null && v !== '' && Number(v) !== 0)
    .map((v) => commaNum(v));
  const dimStr = dimParts.length ? dimParts.join(' × ') + ' ' + dimUnit(dim.unidadeMedida) : '';

  const peso = d.pesoBruto != null && Number(d.pesoBruto) !== 0 ? d.pesoBruto
            : (d.pesoLiquido != null && Number(d.pesoLiquido) !== 0 ? d.pesoLiquido : null);

  // Imagem: baixa no servidor (evita CORS) e devolve como data URL
  let image = null;
  const imgUrl = extractImageUrl(d);
  if (imgUrl) image = await fetchImageAsDataUrl(imgUrl);
  if (!image) {
    // diagnóstico: ajuda a descobrir onde está a imagem nesse cadastro
    console.log('[bling] sem imagem. urlEncontrada=', imgUrl,
      '| midia=', JSON.stringify(d.midia || d.midias || null),
      '| chaves=', Object.keys(d).join(','));
  }

  return {
    id: d.id,
    nome: d.nome || '',
    codigo: d.codigo || '',
    price: precoSug > 0 ? commaNum(precoSug.toFixed(2)) : '',
    description: stripHtml(d.descricaoCurta || d.descricaoComplementar || d.descricao || ''),
    dimensions: dimStr,
    weight: peso != null ? commaNum(peso) + ' kg' : '',
    image,
  };
}
