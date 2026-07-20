// Cálculo de preço de produto (hora-máquina) e conferência de margem.
import { getConfig, setConfig } from './db.js';

const CALC_KEY = 'calc_config';

export const CALC_PADRAO = {
  baseMes: 6000,     // faturamento/custo base do mês
  dias: 30,          // dias no mês
  horasDia: 24,      // horas de produção por dia
  descontoPct: 55,   // % descontado do preço na conferência de margem
  precoKgFilamento: 120, // R$ por kg (usado p/ custo do filamento)
  arredondaPara: 0.90,   // final desejado do preço (ex.: 72,23 -> 72,90)
};

export async function getCalcConfig() {
  const raw = await getConfig(CALC_KEY);
  try { return { ...CALC_PADRAO, ...(raw ? JSON.parse(raw) : {}) }; }
  catch { return { ...CALC_PADRAO }; }
}

export async function setCalcConfig(p) {
  const atual = await getCalcConfig();
  const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  const cfg = {
    baseMes: num(p.baseMes, atual.baseMes),
    dias: Math.max(1, num(p.dias, atual.dias)),
    horasDia: Math.max(1, num(p.horasDia, atual.horasDia)),
    descontoPct: Math.min(100, Math.max(0, num(p.descontoPct, atual.descontoPct))),
    precoKgFilamento: num(p.precoKgFilamento, atual.precoKgFilamento),
    arredondaPara: num(p.arredondaPara, atual.arredondaPara),
  };
  await setConfig(CALC_KEY, JSON.stringify(cfg));
  return cfg;
}

// Arredonda para o próximo valor terminado no final desejado (ex.: 72,23 -> 72,90).
export function arredondaPlausivel(valor, final = 0.90) {
  const v = Number(valor) || 0;
  const f = Number(final) || 0;
  const base = Math.floor(v);
  const alvo = +(base + f).toFixed(2);
  return alvo >= +v.toFixed(2) ? alvo : +(base + 1 + f).toFixed(2);
}

// horas: tempo de impressão em horas (decimal). gramas: filamento gasto na peça.
export function calcular({ horas, gramas, precoManual }, cfg) {
  const h = Math.max(0, Number(horas) || 0);
  const g = Math.max(0, Number(gramas) || 0);

  const valorDia = cfg.baseMes / cfg.dias;
  const valorHora = valorDia / cfg.horasDia;
  const precoBruto = valorHora * h;
  const precoSugerido = arredondaPlausivel(precoBruto, cfg.arredondaPara);

  // preço usado na conferência (permite testar um preço diferente do sugerido)
  const preco = precoManual != null && precoManual !== '' ? Number(precoManual) : precoSugerido;

  const valorGrama = (Number(cfg.precoKgFilamento) || 0) / 1000;
  const custoFilamento = valorGrama * g;

  const aposDesconto = preco * (1 - (cfg.descontoPct / 100)); // tira os 55%
  const sobra = aposDesconto - custoFilamento;                // desconta o filamento
  const margemPct = preco > 0 ? (sobra / preco) * 100 : 0;

  const status = margemPct < 20 ? 'ruim' : (margemPct < 30 ? 'atencao' : 'boa');

  return {
    valorDia, valorHora, precoBruto, precoSugerido, preco,
    valorGrama, custoFilamento, aposDesconto, sobra, margemPct, status,
  };
}
