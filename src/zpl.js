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

export function countLabels(zpl) { return splitLabels(zpl).length; }

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
  const labels = splitLabels(zpl);
  if (!labels.length) throw new Error('Nenhuma etiqueta ^XA…^XZ encontrada no texto.');

  const base = `${LABELARY_BASE}/v1/printers/${dpmm}dpmm/labels/${width}x${height}/`;

  // Até 50: a Labelary resolve numa requisição só (PDF com todas as etiquetas).
  if (labels.length <= batchSize) {
    const pdf = await renderBatch(base, labels.join(''), rotation);
    return { pdf, labels: labels.length };
  }

  // Mais de 50: a Labelary limita a 50 por requisição (HTTP 413). Então quebramos
  // em lotes de 50 e juntamos os PDFs com o pdf-lib.
  let PDFDocument;
  try { ({ PDFDocument } = await import('pdf-lib')); }
  catch { throw new Error(`Para gerar mais de ${batchSize} etiquetas o servidor precisa do pacote "pdf-lib". Rode "npm install" no backend e publique de novo.`); }

  const out = await PDFDocument.create();
  for (let i = 0; i < labels.length; i += batchSize) {
    const buf = await renderBatch(base, labels.slice(i, i + batchSize).join(''), rotation);
    const doc = await PDFDocument.load(buf);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    if (i + batchSize < labels.length) await sleep(350); // respeita o limite de 5 req/s
  }
  return { pdf: Buffer.from(await out.save()), labels: labels.length };
}
