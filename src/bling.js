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
async function blingGet(path) {
  const at = await getAccessToken();
  if (!at) return null;
  try {
    const res = await fetch(API_URL + path, {
      headers: { 'Authorization': 'Bearer ' + at, 'Accept': 'application/json' },
    });
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
    await sleep(250); // respeita o limite de requisições do Bling
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

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const commaNum = (n) => String(n).replace('.', ',');

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
  const unidade = dim.unidadeMedida ? ' ' + dim.unidadeMedida : '';
  const dimStr = dimParts.length ? dimParts.join(' × ') + unidade : '';

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
