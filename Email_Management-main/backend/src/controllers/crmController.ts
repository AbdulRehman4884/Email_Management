import type { Request, Response } from 'express';
import { relabelUnlabeledReplies } from '../lib/crm/labelReply.js';

/**
 * POST /api/crm/relabel  { batchSize?, maxReplies? }
 * Labels the user's old replies that have no label yet. Runs up to `maxReplies` (default 2000,
 * max 5000) per call in batches; call again while `remaining` > 0.
 */
export async function relabelRepliesHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const batchSize = Number(req.body?.batchSize);
    const maxReplies = Number(req.body?.maxReplies);
    const result = await relabelUnlabeledReplies(userId, {
      batchSize: Number.isFinite(batchSize) && batchSize > 0 ? Math.min(500, batchSize) : undefined,
      maxReplies: Number.isFinite(maxReplies) && maxReplies > 0 ? Math.min(5000, maxReplies) : undefined,
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('Relabel replies error:', error);
    return res.status(500).json({ error: 'Failed to relabel replies' });
  }
}
