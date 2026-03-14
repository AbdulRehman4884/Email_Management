import type { Request, Response } from 'express';
import { emailRepliesTable, campaignTable, recipientTable } from '../db/schema';
import { db } from '../lib/db';
import { eq, desc, and, sql } from 'drizzle-orm';

function snippet(str: string | null, maxLen: number): string {
  if (!str) return '';
  const plain = str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length <= maxLen ? plain : plain.slice(0, maxLen) + '…';
}

export async function listRepliesHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const campaignId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : null;
    const offset = (page - 1) * limit;

    const where =
      campaignId != null && !isNaN(campaignId)
        ? and(eq(emailRepliesTable.campaignId, campaignId), eq(campaignTable.userId, userId))
        : eq(campaignTable.userId, userId);

    const replies = await db
      .select({
        id: emailRepliesTable.id,
        campaignId: emailRepliesTable.campaignId,
        recipientId: emailRepliesTable.recipientId,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
        campaignName: campaignTable.name,
        recipientEmail: recipientTable.email,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .innerJoin(recipientTable, eq(emailRepliesTable.recipientId, recipientTable.id))
      .where(where)
      .orderBy(desc(emailRepliesTable.receivedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .where(where);
    const count = countResult[0]?.count ?? 0;

    const list = replies.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      fromEmail: r.fromEmail,
      subject: r.subject,
      snippet: snippet(r.bodyText || r.bodyHtml, 200),
      receivedAt: r.receivedAt,
    }));

    res.status(200).json({ replies: list, total: count });
  } catch (error) {
    console.error('List replies error:', error);
    res.status(500).json({ error: 'Failed to list replies' });
  }
}

export async function getReplyByIdHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid reply id' });
      return;
    }
    const rows = await db
      .select({
        id: emailRepliesTable.id,
        campaignId: emailRepliesTable.campaignId,
        recipientId: emailRepliesTable.recipientId,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
        campaignName: campaignTable.name,
        recipientEmail: recipientTable.email,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .innerJoin(recipientTable, eq(emailRepliesTable.recipientId, recipientTable.id))
      .where(and(eq(emailRepliesTable.id, id), eq(campaignTable.userId, userId)))
      .limit(1);

    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: 'Reply not found' });
      return;
    }
    res.status(200).json({
      id: r.id,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      fromEmail: r.fromEmail,
      subject: r.subject,
      bodyText: r.bodyText,
      bodyHtml: r.bodyHtml,
      receivedAt: r.receivedAt,
    });
  } catch (error) {
    console.error('Get reply error:', error);
    res.status(500).json({ error: 'Failed to get reply' });
  }
}
