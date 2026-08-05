// Gerador de etiquetas: folha 100x30mm com 2 etiquetas 50x30mm iguais,
// cada uma com nome do produto, código de barras (GTIN-14 / ITF-14) e o número legível.
import bwipjs from 'bwip-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const MM = 2.83465; // mm -> pt
const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

async function barcodePng(gtin14) {
  // Interleaved 2 of 5 (mesmo padrão do GTIN-14), porém SEM as bearer bars (moldura).
  return bwipjs.toBuffer({ bcid: 'interleaved2of5', text: gtin14, scale: 4, height: 11, includetext: false, paddingwidth: 0, paddingheight: 0 });
}

// Normaliza o GTIN para 14 dígitos (GTIN-13 vira GTIN-14 com zero à esquerda).
function normalizaGtin(g) {
  const d = onlyDigits(g);
  if (d.length === 14) return d;
  if (d.length === 13) return '0' + d;
  return d;
}

function ajustaFonte(font, texto, maxW, ini = 12, min = 6) {
  let s = ini;
  while (s > min && font.widthOfTextAtSize(texto, s) > maxW) s -= 0.5;
  return s;
}

function desenhaEtiqueta(page, x0, largura, item, img, fontBold, fontReg) {
  const H = page.getHeight();
  const cx = x0 + largura / 2;
  const pad = 2 * MM;

  // nome (topo, centralizado, auto-ajuste)
  const nome = String(item.nome || '').trim() || '(sem nome)';
  const nomeSize = ajustaFonte(fontBold, nome, largura - pad * 2, 12, 6);
  const nomeW = fontBold.widthOfTextAtSize(nome, nomeSize);
  page.drawText(nome, { x: cx - nomeW / 2, y: H - 3 * MM - nomeSize * 0.8, size: nomeSize, font: fontBold, color: rgb(0, 0, 0) });

  // código de barras (centro)
  const alvoW = Math.min(largura - pad * 2, 44 * MM);
  let bw = alvoW, bh = (img.height / img.width) * bw;
  const maxH = 12 * MM;
  if (bh > maxH) { bh = maxH; bw = (img.width / img.height) * bh; }
  const by = 6.5 * MM; // acima do número
  page.drawImage(img, { x: cx - bw / 2, y: by, width: bw, height: bh });

  // número legível (abaixo)
  const num = onlyDigits(item.gtin);
  const numSize = 6.5;
  const numW = fontReg.widthOfTextAtSize(num, numSize);
  page.drawText(num, { x: cx - numW / 2, y: 2.2 * MM, size: numSize, font: fontReg });
}

// ---------------- modo texto (10x5 e 10x15): texto livre, centralizado e enquadrado ----------------
const TAMANHOS = { '10x5': [100, 50], '10x15': [100, 150] };

function quebra(font, texto, size, maxW) {
  const linhas = [];
  for (const paragrafo of String(texto).split('\n')) {
    const palavras = paragrafo.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const w of palavras) {
      const t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t;
      else { linhas.push(cur); cur = w; }
    }
    linhas.push(cur);
  }
  return linhas.length ? linhas : [''];
}

function ajusta(font, texto, maxW, maxH, maxSize = 220) {
  for (let s = maxSize; s >= 6; s -= 1) {
    const linhas = quebra(font, texto, s, maxW);
    const lh = s * 1.18;
    const alturaOk = linhas.length * lh <= maxH;
    const larguraOk = linhas.every((l) => font.widthOfTextAtSize(l, s) <= maxW);
    if (alturaOk && larguraOk) return { size: s, linhas, lh };
  }
  return { size: 6, linhas: quebra(font, texto, 6, maxW), lh: 7 };
}

function desenhaTexto(page, texto, font) {
  const W = page.getWidth(), H = page.getHeight();
  const m = 4 * MM;
  page.drawRectangle({ x: m, y: m, width: W - 2 * m, height: H - 2 * m, borderColor: rgb(0, 0, 0), borderWidth: 1.2 * MM });
  const pad = 4 * MM;
  const innerW = W - 2 * m - 2 * pad, innerH = H - 2 * m - 2 * pad;
  const { size, linhas, lh } = ajusta(font, texto.trim(), innerW, innerH);
  const asc = font.heightAtSize(size, { descender: false });
  const desc = font.heightAtSize(size) - asc;
  const blocoH = (linhas.length - 1) * lh + font.heightAtSize(size);
  const topo = (H + blocoH) / 2 + desc / 2; // empurra pra cima p/ centrar visualmente
  linhas.forEach((ln, i) => {
    const w = font.widthOfTextAtSize(ln, size);
    const y = topo - asc - i * lh;
    page.drawText(ln, { x: (W - w) / 2, y, size, font, color: rgb(0, 0, 0) });
  });
}

export async function gerarEtiquetasTexto(itens, tamanho) {
  const dims = TAMANHOS[tamanho];
  if (!dims) throw new Error('Tamanho inválido para etiqueta de texto.');
  const lista = (itens || []).map((i) => String(i.texto ?? i ?? '').trim()).filter(Boolean);
  if (!lista.length) throw new Error('Escreva ao menos um texto.');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const texto of lista) {
    const page = doc.addPage([dims[0] * MM, dims[1] * MM]);
    desenhaTexto(page, texto, font);
  }
  return Buffer.from(await doc.save());
}
export async function gerarEtiquetasPdf(itens) {
  const lista = (itens || []).map((i) => ({ gtin: onlyDigits(i.gtin), nome: i.nome })).filter((i) => i.gtin);
  if (!lista.length) throw new Error('Informe pelo menos um produto com GTIN.');

  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  for (const item of lista) {
    if (!(item.gtin.length === 13 || item.gtin.length === 14)) {
      throw new Error(`GTIN inválido "${item.gtin}" (precisa ter 13 ou 14 dígitos).`);
    }
    const gtin14 = normalizaGtin(item.gtin);
    let png;
    try { png = await barcodePng(gtin14); }
    catch (e) { throw new Error(`Não foi possível gerar o código de barras de "${item.gtin}": ${e.message}`); }
    const img = await doc.embedPng(png);

    const page = doc.addPage([100 * MM, 30 * MM]);
    const it2 = { ...item, gtin: gtin14 };
    desenhaEtiqueta(page, 0, 50 * MM, it2, img, fontBold, fontReg);       // etiqueta esquerda
    desenhaEtiqueta(page, 50 * MM, 50 * MM, it2, img, fontBold, fontReg); // etiqueta direita (igual)
  }

  return Buffer.from(await doc.save());
}
