// Observação: o pdf-lib é carregado de forma TARDIA (import dinâmico) só quando
// precisamos juntar vários blocos. Assim o backend sobe mesmo sem ele instalado.

const LABELARY_BASE = process.env.LABELARY_URL || 'http://api.labelary.com';
const LABELARY_KEY = process.env.LABELARY_API_KEY || '';

// Separa o texto em etiquetas individuais (^XA … ^XZ)
export function splitLabels(zpl) {
  const m = String(zpl || '').match(/\^XA[\s\S]*?\^XZ/g);
  if (m && m.length) return m;
  return String(zpl || '').trim() ? [String(zpl).trim()] : [];
}

export function countLabels(zpl) {
  // Conta etiquetas REAIS (considera o ^PQ), que é como a Labelary conta.
  return splitLabels(zpl).reduce((s, def) => s + labelWeight(def), 0);
}

// Quantas etiquetas uma definição gera. ^PQq,... => q cópias (q conta como q etiquetas).
function labelWeight(def) {
  const m = String(def).match(/\^PQ\s*(\d+)/i);
  const q = m ? parseInt(m[1], 10) : 1;
  return Math.max(1, q || 1);
}

// Se um único ^PQ passa do máximo por requisição, divide em várias definições menores.
function normalizeLabels(labels, maxCount) {
  const out = [];
  for (const def of labels) {
    let remaining = labelWeight(def);
    if (remaining <= maxCount || !/\^PQ\s*\d+/i.test(def)) { out.push(def); continue; }
    while (remaining > 0) {
      const take = Math.min(maxCount, remaining);
      out.push(def.replace(/\^PQ\s*\d+/i, '^PQ' + take));
      remaining -= take;
    }
  }
  return out;
}

// Agrupa definições em lotes cujo total de etiquetas (peso do ^PQ) não passa de maxCount.
function packBatches(labels, maxCount) {
  const batches = [];
  let cur = [], curW = 0;
  for (const def of labels) {
    const w = labelWeight(def);
    if (cur.length && curW + w > maxCount) { batches.push(cur); cur = []; curW = 0; }
    cur.push(def); curW += w;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renderBatch(base, batchZpl, rotation) {
  const fd = new FormData();
  fd.append('file', new Blob([batchZpl], { type: 'text/plain' }), 'labels.zpl');
  const headers = { Accept: 'application/pdf' };
  if (rotation) headers['X-Rotation'] = String(rotation);
  if (LABELARY_KEY) headers['Authorization'] = 'Token ' + LABELARY_KEY;

  let res = await fetch(base, { method: 'POST', headers, body: fd });
  let tries = 0;
  while (res.status === 429 && tries < 6) {
    const retry = Number(res.headers.get('Retry-After')) || 1;
    await sleep(retry * 1000);
    res = await fetch(base, { method: 'POST', headers, body: fd });
    tries++;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Labelary respondeu ${res.status}: ${t.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Renderiza UMA etiqueta como PNG (pré-visualização)
export async function previewZpl({ zpl, dpmm = 8, width = 4, height = 6, rotation = 0, index = 0 }) {
  const labels = splitLabels(zpl);
  if (!labels.length) throw new Error('Nenhuma etiqueta ^XA…^XZ encontrada no texto.');
  const i = Math.min(Math.max(0, Number(index) || 0), labels.length - 1);
  const url = `${LABELARY_BASE}/v1/printers/${dpmm}dpmm/labels/${width}x${height}/0/`;
  const fd = new FormData();
  fd.append('file', new Blob([labels[i]], { type: 'text/plain' }), 'label.zpl');
  const headers = { Accept: 'image/png' };
  if (rotation) headers['X-Rotation'] = String(rotation);
  if (LABELARY_KEY) headers['Authorization'] = 'Token ' + LABELARY_KEY;
  let res = await fetch(url, { method: 'POST', headers, body: fd });
  let tries = 0;
  while (res.status === 429 && tries < 6) {
    const retry = Number(res.headers.get('Retry-After')) || 1;
    await sleep(retry * 1000);
    res = await fetch(url, { method: 'POST', headers, body: fd });
    tries++;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Labelary respondeu ${res.status}: ${t.slice(0, 200)}`);
  }
  return { png: Buffer.from(await res.arrayBuffer()), total: labels.length, index: i };
}

export async function convertZplToPdf({ zpl, dpmm = 8, width = 4, height = 6, rotation = 0, batchSize = 50 }) {
  const raw = splitLabels(zpl);
  if (!raw.length) throw new Error('Nenhuma etiqueta ^XA…^XZ encontrada no texto.');

  const base = `${LABELARY_BASE}/v1/printers/${dpmm}dpmm/labels/${width}x${height}/`;

  // A Labelary limita 50 etiquetas por requisição — e conta o ^PQ. Então quebramos
  // por CONTAGEM REAL (peso do ^PQ), não por número de definições.
  const labels = normalizeLabels(raw, batchSize);
  const batches = packBatches(labels, batchSize);
  const total = labels.reduce((s, d) => s + labelWeight(d), 0);

  // Um lote só: uma requisição resolve, sem precisar do pdf-lib.
  if (batches.length === 1) {
    const pdf = await renderBatch(base, batches[0].join(''), rotation);
    return { pdf, labels: total };
  }

  // Vários lotes: renderiza cada um e junta os PDFs com o pdf-lib.
  let PDFDocument;
  try { ({ PDFDocument } = await import('pdf-lib')); }
  catch { throw new Error(`Para gerar mais de ${batchSize} etiquetas o servidor precisa do pacote "pdf-lib". Rode "npm install" no backend e publique de novo.`); }

  const out = await PDFDocument.create();
  for (let i = 0; i < batches.length; i++) {
    const buf = await renderBatch(base, batches[i].join(''), rotation);
    const doc = await PDFDocument.load(buf);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    if (i < batches.length - 1) await sleep(350); // respeita o limite de 5 req/s
  }
  return { pdf: Buffer.from(await out.save()), labels: total };
}
