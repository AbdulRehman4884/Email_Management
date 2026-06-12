import express from 'express';
import { recipientTable, statsTable } from '../db/schema.js';
import { persistInboundEmailReply } from '../lib/replyThreading.js';
import { db } from '../lib/db.js';
import { eq } from 'drizzle-orm';

const router = express.Router();

/** POST /api/dev/simulate-open - Dev only: mark a recipient as opened (for local testing without tracking pixel). */
router.post('/dev/simulate-open', async (req, res) => {
  const recipientId = req.body?.recipientId != null ? Number(req.body.recipientId) : NaN;
  if (!Number.isInteger(recipientId) || recipientId < 1) {
    return res.status(400).json({ error: 'Invalid or missing recipientId' });
  }

  try {
    const recipients = await db
      .select({ id: recipientTable.id, campaignId: recipientTable.campaignId, openedAt: recipientTable.openedAt })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    if (recipients.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const [row] = recipients;
    const alreadyOpened = row.openedAt != null;

    if (!alreadyOpened) {
      await db
        .update(recipientTable)
        .set({ openedAt: new Date() })
        .where(eq(recipientTable.id, recipientId));

      const stats = await db
        .select({ openedCount: statsTable.openedCount })
        .from(statsTable)
        .where(eq(statsTable.campaignId, row.campaignId))
        .limit(1);
      if (stats[0]) {
        await db
          .update(statsTable)
          .set({ openedCount: Number(stats[0].openedCount) + 1 })
          .where(eq(statsTable.campaignId, row.campaignId));
      }
    }

    res.status(200).json({ ok: true, recipientId, alreadyOpened });
  } catch (err) {
    console.error('Dev simulate-open error:', err);
    res.status(500).json({ error: 'Failed to simulate open' });
  }
});

/** POST /api/dev/simulate-inbound-reply - Dev only: add a reply and update reply count (for local testing without inbound webhook). */
router.post('/dev/simulate-inbound-reply', async (req, res) => {
  const recipientId = req.body?.recipientId != null ? Number(req.body.recipientId) : NaN;
  const from = String(req.body?.from ?? 'dev@example.com').trim();
  const subject = String(req.body?.subject ?? 'Re: Test').trim();
  const text = String(req.body?.text ?? 'Test reply body').trim();

  if (!Number.isInteger(recipientId) || recipientId < 1) {
    return res.status(400).json({ error: 'Invalid or missing recipientId' });
  }

  try {
    const recipients = await db
      .select({ id: recipientTable.id, campaignId: recipientTable.campaignId, repliedAt: recipientTable.repliedAt })
      .from(recipientTable)
      .where(eq(recipientTable.id, recipientId))
      .limit(1);

    if (recipients.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const [row] = recipients;
    const campaignId = row.campaignId;

    await persistInboundEmailReply({
      campaignId,
      recipientId,
      fromEmail: from,
      subject: subject || '(no subject)',
      bodyText: text || null,
      bodyHtml: null,
      messageId: null,
      inReplyTo: null,
      parentEmailReply: null,
    });

    if (row.repliedAt == null) {
      await db.update(recipientTable).set({ repliedAt: new Date() }).where(eq(recipientTable.id, recipientId));
      const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, campaignId)).limit(1);
      if (stat) {
        await db
          .update(statsTable)
          .set({ repliedCount: Number(stat.repliedCount) + 1 })
          .where(eq(statsTable.campaignId, campaignId));
      }
    }

    res.status(200).json({ ok: true, recipientId, campaignId });
  } catch (err) {
    console.error('Dev simulate-inbound-reply error:', err);
    res.status(500).json({ error: 'Failed to simulate reply' });
  }
});

export default router;
