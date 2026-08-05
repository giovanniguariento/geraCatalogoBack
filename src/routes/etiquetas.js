import { Router } from 'express';
import { gerarEtiquetasPdf } from '../etiquetas.js';

export const etiquetasRouter = Router();

etiquetasRouter.post('/gerar', async (req, res) => {
  try {
    const itens = Array.isArray((req.body || {}).itens) ? req.body.itens : [];
    const pdf = await gerarEtiquetasPdf(itens);
    const agora = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const nome = `etiquetas_${p(agora.getDate())}${p(agora.getMonth() + 1)}${agora.getFullYear()}.pdf`;
    res.json({ pdfBase64: pdf.toString('base64'), nome, qtd: itens.length });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
