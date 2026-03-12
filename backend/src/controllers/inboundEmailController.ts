import type { Request, Response } from 'express';
import { recipientTable, statsTable, emailRepliesTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';

/** Extract message-id from In-Reply-To or References header (first id in angle brackets). */
function extractInReplyTo(payload: {
  inReplyTo?: string;
  references?: string;
  headers?: string | Record<string, string>;
}): string | null {
  let raw = payload.inReplyTo || payload.references;
  if (!raw && payload.headers) {
    const h = typeof payload.headers === 'string' ? JSON.parse(payload.headers || '{}') : payload.headers;
    raw = h['In-Reply-To'] || h['References'] || h['in-reply-to'] || h['references'];
  }
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.trim();
}

/** Parse reply+recipientId@domain to get recipientId. */
function parseReplyToRecipientId(to: string): number | null {
  if (!to) return null;
  const match = to.match(/reply\+(\d+)@/i);
  return match ? parseInt(match[1], 10) : null;
}

export async function inboundEmailHandler(req: Request, res: Response) {
  res.status(200).send('OK');
  let from = '';
  let to = '';
  let subject = '';
  let text = '';
  let html = '';
  let messageId: string | null = null;
  let inReplyTo: string | null = null;

  try {
    if (req.is('application/json')) {
      const b = req.body as Record<string, unknown>;
      from = String(b.from ?? b.sender ?? '').trim();
      to = String(b.to ?? b.recipient ?? '').trim();
      subject = String(b.subject ?? '').trim();
      text = String(b.text ?? b['body-plain'] ?? b.plain ?? '').trim();
      html = String(b.html ?? b['body-html'] ?? b['body_html'] ?? '').trim();
      inReplyTo = extractInReplyTo({
        inReplyTo: b.inReplyTo as string,
        references: b.references as string,
        headers: b.headers as string | Record<string, string>,
      });
      messageId = (b.messageId ?? b['Message-Id'] ?? b.message_id) as string | null;
    } else {
      from = String(req.body.from ?? req.body.sender ?? '').trim();
      to = String(req.body.to ?? req.body.recipient ?? '').trim();
      subject = String(req.body.subject ?? '').trim();
      text = String(req.body.text ?? req.body['body-plain'] ?? req.body.plain ?? '').trim();
      html = String(req.body.html ?? req.body['body-html'] ?? req.body['body_html'] ?? '').trim();
      inReplyTo = extractInReplyTo({
        inReplyTo: req.body.inReplyTo ?? req.body['In-Reply-To'],
        references: req.body.references ?? req.body.References,
        headers: req.body.headers,
      });
      messageId = req.body.messageId ?? req.body['Message-Id'] ?? req.body.message_id ?? null;
    }
  } catch {
    return;
  }

  void (async () => {
    try {
      let recipientId: number | null = null;
      let campaignId: number | null = null;

      const ourMessageId = inReplyTo || messageId;
      if (ourMessageId) {
        const recipients = await db
          .select({ id: recipientTable.id, campaignId: recipientTable.campaignId })
          .from(recipientTable)
          .where(eq(recipientTable.messageId, ourMessageId))
          .limit(1);
        if (recipients[0]) {
          recipientId = recipients[0].id;
          campaignId = recipients[0].campaignId;
        }
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

      await db.insert(emailRepliesTable).values({
        campaignId,
        recipientId,
        fromEmail,
        subject: subject || '(no subject)',
        bodyText: text || null,
        bodyHtml: html || null,
        messageId: messageId ?? null,
        inReplyTo,
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
