import { Router } from 'express';
import { gerarEtiquetasPdf, gerarEtiquetasTexto } from '../etiquetas.js';

export const etiquetasRouter = Router();

etiquetasRouter.post('/gerar', async (req, res) => {
  try {
    const body = req.body || {};
    const tamanho = body.tamanho || '10x3';
    const itens = Array.isArray(body.itens) ? body.itens : [];
    const pdf = tamanho === '10x3' ? await gerarEtiquetasPdf(itens) : await gerarEtiquetasTexto(itens, tamanho);
    const agora = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const nome = `etiquetas_${tamanho}_${p(agora.getDate())}${p(agora.getMonth() + 1)}${agora.getFullYear()}.pdf`;
    res.json({ pdfBase64: pdf.toString('base64'), nome, qtd: itens.length });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
