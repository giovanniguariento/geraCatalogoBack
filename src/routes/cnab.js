import { Router } from 'express';
import { decodeGuia, gerarRemessa, getPagador, setPagador } from '../cnab.js';

export const cnabRouter = Router();

cnabRouter.get('/pagador', async (_req, res) => {
  try { res.json({ pagador: await getPagador() }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

cnabRouter.post('/pagador', async (req, res) => {
  try { res.json({ pagador: await setPagador(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Decodifica uma lista de linhas digitáveis para a tabela de conferência.
cnabRouter.post('/decodificar', async (req, res) => {
  try {
    const linhas = Array.isArray((req.body || {}).linhas) ? req.body.linhas : [];
    const itens = linhas.map((raw) => {
      const entrada = String(raw || '').trim();
      if (!entrada) return null;
      const d = decodeGuia(entrada);
      return { entrada, ...d };
    }).filter(Boolean);
    res.json({ itens });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Gera o arquivo .REM a partir das guias confirmadas.
cnabRouter.post('/gerar', async (req, res) => {
  try {
    const pag = await getPagador();
    const itens = Array.isArray((req.body || {}).itens) ? req.body.itens : [];
    const validos = itens.filter((i) => i && i.rep48 && (Number(i.valor) > 0));
    if (!validos.length) throw new Error('Nenhuma guia válida para gerar.');
    const arquivo = gerarRemessa(pag, validos);
    const agora = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const nome = `PAGAMENTO_${p(agora.getDate())}${p(agora.getMonth() + 1)}${agora.getFullYear()}_${p(agora.getHours())}${p(agora.getMinutes())}.REM`;
    const total = validos.reduce((s, i) => s + (Number(i.valor) || 0), 0);
    res.json({ arquivo, nome, qtd: validos.length, total });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
