import { Router } from 'express';
import { convertZplToPdf, previewZpl, countLabels } from '../zpl.js';

const router = Router();

// Checagem rápida de que a rota está no ar (abra no navegador)
router.get('/ping', (_req, res) => res.json({ ok: true, modulo: 'zpl' }));

// Conta quantas etiquetas há no texto (pré-visualização rápida, sem renderizar)
router.post('/contar', (req, res) => {
  const { zpl } = req.body || {};
  res.json({ labels: countLabels(zpl) });
});

// Pré-visualização: renderiza uma etiqueta como PNG
router.post('/preview', async (req, res) => {
  const { zpl, dpmm, width, height, rotation, index } = req.body || {};
  if (!zpl || !String(zpl).trim()) return res.status(400).json({ error: 'Cole o conteúdo ZPL ou envie um arquivo.' });
  try {
    const { png, total, index: i } = await previewZpl({
      zpl, dpmm: Number(dpmm) || 8, width: Number(width) || 4,
      height: Number(height) || 6, rotation: Number(rotation) || 0, index: Number(index) || 0,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Label-Total', String(total));
    res.setHeader('X-Label-Index', String(i));
    res.send(png);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Converte ZPL -> PDF multipágina e devolve o binário
router.post('/converter', async (req, res) => {
  const { zpl, dpmm, width, height, rotation } = req.body || {};
  if (!zpl || !String(zpl).trim()) return res.status(400).json({ error: 'Cole o conteúdo ZPL ou envie um arquivo.' });
  try {
    const { pdf, labels } = await convertZplToPdf({
      zpl,
      dpmm: Number(dpmm) || 8,
      width: Number(width) || 4,
      height: Number(height) || 6,
      rotation: Number(rotation) || 0,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Label-Count', String(labels));
    res.setHeader('Content-Disposition', 'attachment; filename="etiquetas.pdf"');
    res.send(pdf);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

export default router;
