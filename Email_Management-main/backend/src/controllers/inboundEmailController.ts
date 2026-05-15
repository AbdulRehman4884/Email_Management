import type { Request, Response } from 'express';
import { recipientTable, statsTable } from '../db/schema';
import { db } from '../lib/db';
import { normalizeMessageId } from '../lib/messageId.js';
import { eq } from 'drizzle-orm';
import {
  buildInboundRefIdList,
  persistInboundEmailReply,
  resolveReplyTargetFromRefIds,
  type ParentEmailReply,
} from '../lib/replyThreading.js';

/** Parse reply+recipientId@domain to get recipientId. */
function parseReplyToRecipientId(to: string): number | null {
  if (!to) return null;
  const match = to.match(/reply\+(\d+)@/i);
  return match?.[1] != null ? parseInt(match[1], 10) : null;
}

export async function inboundEmailHandler(req: Request, res: Response) {
  res.status(200).send('OK');
  let from = '';
  let to = '';
  let subject = '';
  let text = '';
  let html = '';
  let messageId: string | null = null;
  let inReplyToHeader: string | null = null;
  let referencesHeader: string | null = null;
  let headersField: string | Record<string, string> | null = null;

  try {
    if (req.is('application/json')) {
      const b = req.body as Record<string, unknown>;
      from = String(b.from ?? b.sender ?? '').trim();
      to = String(b.to ?? b.recipient ?? '').trim();
      subject = String(b.subject ?? '').trim();
      text = String(b.text ?? b['body-plain'] ?? b.plain ?? '').trim();
      html = String(b.html ?? b['body-html'] ?? b['body_html'] ?? '').trim();
      inReplyToHeader = b.inReplyTo != null ? String(b.inReplyTo).trim() : null;
      referencesHeader = b.references != null ? String(b.references).trim() : null;
      headersField = (b.headers as string | Record<string, string>) ?? null;
      messageId = (b.messageId ?? b['Message-Id'] ?? b.message_id) as string | null;
    } else {
      from = String(req.body.from ?? req.body.sender ?? '').trim();
      to = String(req.body.to ?? req.body.recipient ?? '').trim();
      subject = String(req.body.subject ?? '').trim();
      text = String(req.body.text ?? req.body['body-plain'] ?? req.body.plain ?? '').trim();
      html = String(req.body.html ?? req.body['body-html'] ?? req.body['body_html'] ?? '').trim();
      inReplyToHeader = req.body.inReplyTo != null ? String(req.body.inReplyTo).trim() : null;
      referencesHeader = req.body.references != null ? String(req.body.references).trim() : null;
      headersField = req.body.headers ?? null;
      messageId = req.body.messageId ?? req.body['Message-Id'] ?? req.body.message_id ?? null;
    }
  } catch {
    return;
  }

  void (async () => {
    try {
      let recipientId: number | null = null;
      let campaignId: number | null = null;
      let parentEmailReply: ParentEmailReply | null = null;

      const refIds = buildInboundRefIdList({
        inReplyTo: inReplyToHeader,
        references: referencesHeader,
        messageId,
        headers: headersField,
      });

      const resolved = await resolveReplyTargetFromRefIds(refIds);
      if (resolved) {
        recipientId = resolved.recipientId;
        campaignId = resolved.campaignId;
        parentEmailReply = resolved.parentEmailReply;
      }

      if (recipientId == null && to) {
        const rid = parseReplyToRecipientId(to);
        if (rid) {
          const recipients = await db
            .select({ id: recipientTable.id, campaignId: recipientTable.campaignId })
            .from(recipientTable)
            .where(eq(recipientTable.id, rid))
            .limit(1);
          if (recipients[0]) {
            recipientId = recipients[0].id;
            campaignId = recipients[0].campaignId;
          }
        }
      }

      if (recipientId == null || campaignId == null) {
        return;
      }

      const fromEmail = from.replace(/^.*<([^>]+)>.*$/, '$1').trim() || from;
      const inReplyToStored = refIds[0] ? normalizeMessageId(refIds[0]) : null;

      await persistInboundEmailReply({
        campaignId,
        recipientId,
        fromEmail,
        subject: subject || '(no subject)',
        bodyText: text || null,
        bodyHtml: html || null,
        messageId: messageId ? normalizeMessageId(messageId) : null,
        inReplyTo: inReplyToStored,
        parentEmailReply,
      });

      const [recipient] = await db
        .select({ repliedAt: recipientTable.repliedAt })
        .from(recipientTable)
        .where(eq(recipientTable.id, recipientId))
        .limit(1);
      if (recipient && recipient.repliedAt == null) {
        await db.update(recipientTable).set({ repliedAt: new Date() }).where(eq(recipientTable.id, recipientId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, campaignId)).limit(1);
        if (stat) {
          await db
            .update(statsTable)
            .set({ repliedCount: Number(stat.repliedCount) + 1 })
            .where(eq(statsTable.campaignId, campaignId));
        }
      }
    } catch (err) {
      console.error('Inbound email processing error:', err);
    }
  })();
}
