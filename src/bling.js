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

export async function searchProducts(q) {
  if (!q || !q.trim()) return [];
  // Bling /produtos filtra por nome (parcial). criterio: 1=últimos,2=ativos,3=inativos,4=excluídos,5=todos
  const criterio = process.env.BLING_PRODUCT_CRITERIO || '5';
  const params = new URLSearchParams({ nome: q.trim(), criterio, pagina: '1', limite: '20' });
  const j = await blingGet('/produtos?' + params.toString());
  const arr = j && Array.isArray(j.data) ? j.data : [];
  return arr.map((p) => ({
    id: p.id,
    nome: p.nome || '',
    codigo: p.codigo || '',
    preco: Number(p.preco) || 0,
  }));
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const commaNum = (n) => String(n).replace('.', ',');

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

  return {
    id: d.id,
    nome: d.nome || '',
    codigo: d.codigo || '',
    price: precoSug > 0 ? commaNum(precoSug.toFixed(2)) : '',
    description: stripHtml(d.descricaoCurta || d.descricaoComplementar || d.descricao || ''),
    dimensions: dimStr,
    weight: peso != null ? commaNum(peso) + ' kg' : '',
  };
}
