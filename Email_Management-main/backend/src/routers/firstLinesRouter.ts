/**
 * AI first lines (mounted at /api with authMiddleware):
 *   GET  /campaigns/:id/first-lines                    leads + their lines, run progress, whether the email uses {first_line}
 *   POST /campaigns/:id/first-lines                    start writing lines { overwrite? }
 *   PUT  /campaigns/:id/first-lines/:recipientId       edit one lead's line { firstLine }
 */
import { Router, type Request, type Response } from 'express';
import { firstLinesOf, setFirstLine, startFirstLines } from '../lib/firstLines/job.js';

const router = Router();

const idOf = (v: unknown) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/campaigns/:id/first-lines', async (req: Request, res: Response) => {
  const campaignId = idOf(req.params.id);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const data = await firstLinesOf(req.user!.id, campaignId);
    if (!data) return res.status(404).json({ error: 'Campaign not found' });
    return res.json(data);
  } catch (err) {
    console.error('[first-lines] load failed:', err);
    return res.status(500).json({ error: 'Could not load the first lines' });
  }
});

router.post('/campaigns/:id/first-lines', async (req: Request, res: Response) => {
  const campaignId = idOf(req.params.id);
  if (!campaignId) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const result = await startFirstLines(req.user!.id, campaignId, req.body?.overwrite === true);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(202).json({ run: result.run });
  } catch (err) {
    console.error('[first-lines] start failed:', err);
    return res.status(500).json({ error: 'Could not start writing the first lines' });
  }
});

router.put('/campaigns/:id/first-lines/:recipientId', async (req: Request, res: Response) => {
  const campaignId = idOf(req.params.id);
  const recipientId = idOf(req.params.recipientId);
  if (!campaignId || !recipientId) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await setFirstLine(req.user!.id, campaignId, recipientId, req.body?.firstLine);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.json({ lead: result.lead });
  } catch (err) {
    console.error('[first-lines] save failed:', err);
    return res.status(500).json({ error: 'Could not save the line' });
  }
});

export default router;
