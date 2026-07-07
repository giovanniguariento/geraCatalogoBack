// Geração de arquivo CNAB 240 - padrão Itaú SISPAG (Pagamento de Contas e Tributos
// com código de barras - Segmento O). Baseado no manual oficial do Itaú (versão 085).
// IMPORTANTE: validar no "Validador de Layout de Arquivos" do Itaú antes de usar em produção.

import { getConfig, setConfig } from './db.js';

const PAGADOR_KEY = 'itau_pagador';

// Constantes que o validador do Itaú pode pedir ajuste (ficam aqui pra facilitar):
const VERSAO_LAYOUT_ARQUIVO = '080';
const VERSAO_LAYOUT_LOTE = '040';
const TIPO_SERVICO = '22'; // Pagamento de Tributos/Contas (compatível com formas 13 e 91)
// Forma de lançamento por tipo de guia (2º dígito do código de barras):
//  segmentos 2/3/4 = concessionárias -> 13 ; demais = tributos com código de barras -> 91
function formaPorSegmento(seg) { return ['2', '3', '4'].includes(String(seg)) ? '13' : '91'; }

// ---------------- helpers de formatação ----------------
const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const padL = (s, n, c = '0') => onlyDigits(s).padStart(n, c).slice(-n);
const numOf = (v, n) => String(Math.round(Number(v) || 0)).padStart(n, '0').slice(-n);
function alpha(s, n) {
  const up = String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return up.replace(/[^A-Z0-9 .,\-\/&]/g, ' ').padEnd(n, ' ').slice(0, n);
}
const brancos = (n) => ' '.repeat(n);
const zeros = (n) => '0'.repeat(n);

// Monta uma linha a partir de pedaços e garante 240 posições.
function linha(pedacos, ctx) {
  const s = pedacos.join('');
  if (s.length !== 240) throw new Error(`Linha CNAB com ${s.length} posições (esperado 240) em ${ctx}`);
  return s;
}

// ---------------- decodificação da guia (arrecadação) ----------------
// Converte a representação numérica (48 dígitos) no código de barras (44).
function linhaParaBarras48(entrada) {
  const d = onlyDigits(entrada);
  if (d.length === 44) return d;
  if (d.length === 48) return d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
  return null;
}
// DV de um bloco de 11 dígitos (arrecadação). mod10 (tipoValor 6/7) ou mod11 (8/9).
function dvBloco(bloco, tipoValor) {
  if (tipoValor === '8' || tipoValor === '9') { // módulo 11
    let peso = 2, soma = 0;
    for (let i = bloco.length - 1; i >= 0; i--) { soma += parseInt(bloco[i], 10) * peso; peso = peso === 9 ? 2 : peso + 1; }
    const resto = soma % 11; const dv = 11 - resto;
    if (dv === 0 || dv === 1) return 0; if (dv === 10) return 1; return dv;
  }
  // módulo 10
  let soma = 0, mult = 2;
  for (let i = bloco.length - 1; i >= 0; i--) { let p = parseInt(bloco[i], 10) * mult; if (p > 9) p -= 9; soma += p; mult = mult === 2 ? 1 : 2; }
  const resto = soma % 10; return resto === 0 ? 0 : 10 - resto;
}
// Gera a representação numérica de 48 dígitos a partir da barra de 44.
function barrasParaLinha48(b44, tipoValor) {
  const blocos = [b44.slice(0, 11), b44.slice(11, 22), b44.slice(22, 33), b44.slice(33, 44)];
  return blocos.map((bl) => bl + dvBloco(bl, tipoValor)).join('');
}

export function decodeGuia(entrada) {
  const digits = onlyDigits(entrada);
  const barras = linhaParaBarras48(entrada);
  if (!barras) return { ok: false, erro: 'Linha digitável inválida (esperado 44 ou 48 dígitos).' };
  const produto = barras[0];
  if (produto !== '8') return { ok: false, erro: 'Não é guia de arrecadação (código não começa com 8). Boletos (segmento J) ainda não são suportados.' };
  const segmento = barras[1];
  const tipoValor = barras[2];
  const valor = parseInt(barras.slice(4, 15), 10) / 100;
  // usa a representação numérica original (48 díg. com os DVs impressos na guia);
  // só recalcula se a entrada veio como código de barras de 44.
  const rep48 = digits.length === 48 ? digits : barrasParaLinha48(barras, tipoValor);
  return { ok: true, produto, segmento, tipoValor, valor, barras, rep48, forma: formaPorSegmento(segmento) };
}

// ---------------- config do pagador ----------------
export async function getPagador() {
  const raw = await getConfig(PAGADOR_KEY);
  try { return raw ? JSON.parse(raw) : { razao: '', cnpj: '', agencia: '', conta: '', dac: '' }; }
  catch { return { razao: '', cnpj: '', agencia: '', conta: '', dac: '' }; }
}
export async function setPagador(p) {
  const clean = {
    razao: String(p.razao || '').trim(),
    cnpj: onlyDigits(p.cnpj).slice(0, 14),
    agencia: onlyDigits(p.agencia).slice(0, 5),
    conta: onlyDigits(p.conta).slice(0, 12),
    dac: onlyDigits(p.dac).slice(0, 1),
  };
  await setConfig(PAGADOR_KEY, JSON.stringify(clean));
  return clean;
}

// ---------------- geração da remessa ----------------
function ddmmaaaa(v) {
  if (!v) return zeros(8);
  const d = onlyDigits(v);
  if (d.length === 8) return d; // já veio DDMMAAAA
  const dt = new Date(v);
  if (isNaN(dt)) return zeros(8);
  const p = (n) => String(n).padStart(2, '0');
  return p(dt.getDate()) + p(dt.getMonth() + 1) + dt.getFullYear();
}

function headerArquivo(pag, agora) {
  const p = (n) => String(n).padStart(2, '0');
  const data = p(agora.getDate()) + p(agora.getMonth() + 1) + agora.getFullYear();
  const hora = p(agora.getHours()) + p(agora.getMinutes()) + p(agora.getSeconds());
  return linha([
    '341', '0000', '0',
    brancos(6),
    VERSAO_LAYOUT_ARQUIVO,
    '2', padL(pag.cnpj, 14),
    brancos(20),
    padL(pag.agencia, 5), ' ', padL(pag.conta, 12), ' ', (pag.dac || '0').slice(0, 1),
    alpha(pag.razao, 30),
    alpha('BANCO ITAU SA', 30),
    brancos(10),
    '1', data, hora,
    zeros(6), zeros(3), zeros(5),
    brancos(69),
  ], 'header arquivo');
}

function headerLote(pag, lote, forma) {
  return linha([
    '341', padL(lote, 4), '1',
    'C', TIPO_SERVICO, forma, VERSAO_LAYOUT_LOTE, ' ',
    '2', padL(pag.cnpj, 14),
    brancos(20),
    padL(pag.agencia, 5), ' ', padL(pag.conta, 12), ' ', (pag.dac || '0').slice(0, 1),
    alpha(pag.razao, 30),
    brancos(40), // mensagem
    brancos(30), brancos(5), brancos(15), brancos(20), zeros(5), zeros(3), brancos(2), // endereço
    brancos(8), brancos(10),
  ], 'header lote');
}

function segmentoO(lote, seq, guia, pag) {
  const venc = ddmmaaaa(guia.vencimento);
  return linha([
    '341', padL(lote, 4), '3',
    padL(seq, 5), 'O', zeros(3),
    (guia.rep48 || '').padEnd(48, ' ').slice(0, 48),
    alpha(guia.nome || 'PAGAMENTO DE GUIA', 30),
    venc, // vencimento
    'REA', zeros(15),
    numOf(Math.round((Number(guia.valor) || 0) * 100), 15),
    venc, // data pagamento = vencimento
    zeros(15),
    brancos(3),
    zeros(9),
    brancos(3),
    alpha(guia.seuNumero || String(seq), 20),
    brancos(21),
    brancos(15),
    brancos(10),
  ], 'segmento O');
}

function trailerLote(lote, qtdRegistros, somaValor) {
  return linha([
    '341', padL(lote, 4), '5',
    brancos(9),
    padL(qtdRegistros, 6),
    numOf(Math.round(somaValor * 100), 18),
    zeros(18),
    brancos(171),
    brancos(10),
  ], 'trailer lote');
}

function trailerArquivo(qtdLotes, qtdRegistros) {
  return linha([
    '341', '9999', '9',
    brancos(9),
    padL(qtdLotes, 6), padL(qtdRegistros, 6),
    zeros(6),
    brancos(205),
  ], 'trailer arquivo');
}

// Gera o conteúdo do arquivo .REM. itens: [{ linha|rep48, valor, vencimento, nome, seuNumero, forma, segmento }]
export function gerarRemessa(pag, itens, agora = new Date()) {
  if (!pag || !pag.cnpj) throw new Error('Preencha os dados do pagador (config Pagamentos Itaú).');
  if (!itens || !itens.length) throw new Error('Nenhuma guia para gerar.');

  // agrupa por forma de pagamento (um lote por forma)
  const grupos = {};
  for (const it of itens) { const f = it.forma || '91'; (grupos[f] = grupos[f] || []).push(it); }

  const linhas = [headerArquivo(pag, agora)];
  let lote = 0;
  const formas = Object.keys(grupos);
  for (const f of formas) {
    lote += 1;
    linhas.push(headerLote(pag, lote, f));
    let seq = 0, soma = 0;
    for (const g of grupos[f]) { seq += 1; linhas.push(segmentoO(lote, seq, g, pag)); soma += Number(g.valor) || 0; }
    // trailer conta header(1) + detalhes(seq) + trailer(1)
    linhas.push(trailerLote(lote, seq + 2, soma));
  }
  // trailer arquivo conta: header arq(1) + por lote [header+detalhes+trailer] + trailer arq(1)
  const totalReg = 1 + formas.reduce((s, f) => s + grupos[f].length + 2, 0) + 1;
  linhas.push(trailerArquivo(formas.length, totalReg));

  return linhas.join('\r\n') + '\r\n';
}
