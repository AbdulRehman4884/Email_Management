import type { Request, Response } from 'express';
import { emailRepliesTable, campaignTable, recipientTable } from '../db/schema';
import { db, dbPool } from '../lib/db';
import { eq, and, or, asc, isNull } from 'drizzle-orm';
import { sendEmail as sendViaSmtp } from '../lib/smtp.js';
import { normalizeMessageId } from '../lib/messageId.js';
import { formatMessageIdForHeader, toReplySubject } from '../lib/emailThreading.js';
import { sanitizeInboundEmailHtmlForDisplay } from '../lib/sanitizeEmailHtml.js';
import { replacePlaceholders } from '../lib/replacePlaceholders.js';

function snippet(str: string | null, maxLen: number): string {
  if (!str) return '';
  const plain = str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length <= maxLen ? plain : plain.slice(0, maxLen) + '…';
}

/** Prepend the original campaign send (recipients + campaign template) and sort all messages by time. */
function mergeCampaignOriginalSendWithMessages(input: {
  campaignSubject: string;
  campaignFromEmail: string;
  campaignEmailContent: string;
  recipientId: number;
  recipientSentAt: Date | string | null;
  recipientEmail: string;
  recipientName: string | null;
  recipientCustomFields: string | null;
  messageRows: Array<{
    id: number;
    direction: string;
    fromEmail: string;
    subject: string;
    bodyText: string | null;
    bodyHtml: string | null;
    receivedAt: Date | string;
  }>;
}): Array<{
  id: number;
  direction: string;
  fromEmail: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string;
}> {
  const toIso = (d: Date | string) => (d instanceof Date ? d.toISOString() : String(d));
  const recipientForTokens = {
    email: input.recipientEmail,
    name: input.recipientName,
    customFields: input.recipientCustomFields,
  };
  const resolvedCampaignSubject = replacePlaceholders(input.campaignSubject ?? '', recipientForTokens);
  const resolvedCampaignHtml = replacePlaceholders(input.campaignEmailContent ?? '', recipientForTokens);

  const dbMessages = input.messageRows.map((row) => {
    const outbound = row.direction === 'outbound';
    const subject = outbound ? replacePlaceholders(row.subject ?? '', recipientForTokens) : row.subject;
    const bodyText =
      outbound && row.bodyText
        ? replacePlaceholders(row.bodyText, recipientForTokens)
        : row.bodyText;
    const rawHtml = outbound && row.bodyHtml ? replacePlaceholders(row.bodyHtml, recipientForTokens) : row.bodyHtml;
    return {
      id: row.id,
      direction: row.direction,
      fromEmail: row.fromEmail,
      subject,
      bodyText,
      bodyHtml: rawHtml != null ? sanitizeInboundEmailHtmlForDisplay(rawHtml) : rawHtml,
      receivedAt: toIso(row.receivedAt),
    };
  });
  const hasSent = input.recipientSentAt != null && String(input.recipientSentAt).trim() !== '';
  const synthetic = hasSent
    ? [
        {
          id: -Math.abs(input.recipientId),
          direction: 'outbound',
          fromEmail: input.campaignFromEmail,
          subject: resolvedCampaignSubject,
          bodyText: null as string | null,
          bodyHtml: sanitizeInboundEmailHtmlForDisplay(resolvedCampaignHtml),
          receivedAt: toIso(input.recipientSentAt as Date | string),
        },
      ]
    : [];
  const merged = [...synthetic, ...dbMessages];
  merged.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
  return merged;
}

type ReplyListKind = 'replies' | 'system' | 'all';

function parseReplyListKind(input: unknown): ReplyListKind {
  const v = String(input ?? '').trim().toLowerCase();
  if (v === 'replies') return 'replies';
  if (v === 'system') return 'system';
  return 'all';
}

function isSystemNotificationSender(fromEmail: string): boolean {
  const local = String(fromEmail || '').split('@')[0]?.toLowerCase().trim() || '';
  if (!local) return false;
  if (local === 'mailer-daemon') return true;
  if (local.startsWith('mailer-daemon-') || local.startsWith('mailer-daemon+') || local.startsWith('mailer-daemon.')) return true;
  return local.includes('postmaster');
}

const systemSenderSql = `
(
  LOWER(SPLIT_PART(er.from_email, '@', 1)) = 'mailer-daemon'
  OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon-%'
  OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon+%'
  OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon.%'
  OR POSITION('postmaster' IN LOWER(SPLIT_PART(er.from_email, '@', 1))) > 0
)
`;

const followUpCountSubquery = `
  (SELECT COUNT(*)::int FROM email_replies fu
   WHERE fu.campaign_id = er.campaign_id AND fu.recipient_id = er.recipient_id AND fu.direction = 'outbound')
`;

/** Optional query: followUpCount = exact, or followUpCountMin = minimum (e.g. 5 for "5+"). */
function parseFollowUpFilterSql(
  req: Request,
  startParamIndex: number
): { sql: string; params: unknown[]; nextIndex: number } {
  const rawExact = req.query.followUpCount;
  const rawMin = req.query.followUpCountMin;
  if (rawMin !== undefined && rawMin !== '') {
    const n = parseInt(String(rawMin), 10);
    if (Number.isFinite(n) && n >= 0) {
      return {
        sql: `AND ${followUpCountSubquery} >= $${startParamIndex}`,
        params: [n],
        nextIndex: startParamIndex + 1,
      };
    }
  }
  if (rawExact !== undefined && rawExact !== '') {
    const n = parseInt(String(rawExact), 10);
    if (Number.isFinite(n) && n >= 0) {
      return {
        sql: `AND ${followUpCountSubquery} = $${startParamIndex}`,
        params: [n],
        nextIndex: startParamIndex + 1,
      };
    }
  }
  return { sql: '', params: [], nextIndex: startParamIndex };
}

export async function getThreadRootForRecipientHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = parseInt(String(req.query.campaignId ?? ''), 10);
    const recipientId = parseInt(String(req.query.recipientId ?? ''), 10);
    if (!Number.isFinite(campaignId) || campaignId < 1 || !Number.isFinite(recipientId) || recipientId < 1) {
      return res.status(400).json({ error: 'campaignId and recipientId are required' });
    }

    const scope = await db
      .select({ cid: campaignTable.id, rid: recipientTable.id })
      .from(recipientTable)
      .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
      .where(
        and(
          eq(recipientTable.id, recipientId),
          eq(recipientTable.campaignId, campaignId),
          eq(campaignTable.userId, userId)
        )
      )
      .limit(1);
    if (!scope[0]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const q = `
      SELECT COALESCE(thread_root_id, id)::int AS root
      FROM email_replies
      WHERE campaign_id = $1 AND recipient_id = $2
      ORDER BY CASE WHEN direction = 'inbound' THEN 0 ELSE 1 END, received_at ASC
      LIMIT 1
    `;
    const r = await dbPool.query(q, [campaignId, recipientId]);
    const root = (r.rows[0] as { root: number } | undefined)?.root;
    res.status(200).json({ threadRootId: root ?? null });
  } catch (error) {
    console.error('Thread root error:', error);
    res.status(500).json({ error: 'Failed to resolve thread' });
  }
}

export async function listRepliesHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const kind = parseReplyListKind(req.query.kind);
    const offset = (page - 1) * limit;
    const search = String(req.query.search ?? '').trim();

    // Multi-campaign filter: campaignIds=comma-separated OR legacy campaignId
    let requestedIds: number[] = [];
    const rawMulti = req.query.campaignIds;
    if (rawMulti !== undefined && rawMulti !== '') {
      const str = Array.isArray(rawMulti) ? rawMulti.join(',') : String(rawMulti);
      requestedIds = [...new Set(str.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0))];
    }
    const legacyId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : NaN;
    if (requestedIds.length === 0 && !Number.isNaN(legacyId) && legacyId > 0) {
      requestedIds = [legacyId];
    }

    const userCampRows = await db.select({ id: campaignTable.id }).from(campaignTable).where(eq(campaignTable.userId, userId));
    const allowed = new Set(userCampRows.map((r) => r.id));
    let campaignFilter: number[] | null = null;
    if (requestedIds.length > 0) {
      campaignFilter = requestedIds.filter((id) => allowed.has(id));
      if (campaignFilter.length === 0) {
        return res.status(200).json({ replies: [], total: 0 });
      }
    }

    const kindSql =
      kind === 'system'
        ? `AND ${systemSenderSql}`
        : kind === 'replies'
          ? `AND NOT ${systemSenderSql}`
          : '';

    const params: unknown[] = [userId];
    let p = 2;
    let campSql = '';
    if (campaignFilter && campaignFilter.length > 0) {
      campSql = `AND er.campaign_id = ANY($${p}::int[])`;
      params.push(campaignFilter);
      p++;
    }
    let searchSql = '';
    if (search.length > 0) {
      searchSql = `AND (er.subject ILIKE $${p} OR r.email ILIKE $${p} OR c.name ILIKE $${p})`;
      params.push(`%${search}%`);
      p++;
    }

    const follow = parseFollowUpFilterSql(req, p);
    const followSql = follow.sql;
    params.push(...follow.params);
    p = follow.nextIndex;

    const limitIdx = p;
    const offsetIdx = p + 1;
    params.push(limit, offset);

    const listSql = `
      SELECT * FROM (
        SELECT DISTINCT ON (COALESCE(er.thread_root_id, er.id))
          er.id,
          er.campaign_id AS "campaignId",
          er.recipient_id AS "recipientId",
          er.from_email AS "fromEmail",
          er.subject,
          er.body_text AS "bodyText",
          er.body_html AS "bodyHtml",
          er.received_at AS "receivedAt",
          er.direction AS "direction",
          EXISTS (
            SELECT 1
            FROM email_replies er2
            WHERE COALESCE(er2.thread_root_id, er2.id) = COALESCE(er.thread_root_id, er.id)
              AND er2.direction = 'inbound'
              AND er2.read_at IS NULL
          ) AS "isUnread",
          ${systemSenderSql} AS "isSystemNotification",
          COALESCE(er.thread_root_id, er.id) AS "threadRootId",
          c.name AS "campaignName",
          r.email AS "recipientEmail",
          ${followUpCountSubquery} AS "followUpCount"
        FROM email_replies er
        INNER JOIN campaigns c ON er.campaign_id = c.id
        INNER JOIN recipients r ON er.recipient_id = r.id
        WHERE c.user_id = $1 ${campSql} ${kindSql} ${searchSql} ${followSql}
        ORDER BY COALESCE(er.thread_root_id, er.id), er.received_at DESC
      ) threads
      ORDER BY "receivedAt" DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countParams = params.slice(0, -2);
    const countSql = `
      SELECT count(*)::int AS c FROM (
        SELECT DISTINCT COALESCE(er.thread_root_id, er.id) AS tk
        FROM email_replies er
        INNER JOIN campaigns c ON er.campaign_id = c.id
        INNER JOIN recipients r ON er.recipient_id = r.id
        WHERE c.user_id = $1 ${campSql} ${kindSql} ${searchSql} ${followSql}
      ) t
    `;

    const [listResult, countResult] = await Promise.all([
      dbPool.query(listSql, params),
      dbPool.query(countSql, countParams),
    ]);

    const rows = listResult.rows as {
      id: number;
      campaignId: number;
      recipientId: number;
      fromEmail: string;
      subject: string;
      bodyText: string | null;
      bodyHtml: string | null;
      receivedAt: string;
      direction: string;
      isUnread: boolean;
      isSystemNotification: boolean;
      threadRootId: number;
      campaignName: string;
      recipientEmail: string;
      followUpCount: number;
    }[];

    const list = rows.map((r) => ({
      id: r.id,
      threadRootId: r.threadRootId,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      fromEmail: r.fromEmail,
      direction: r.direction,
      isUnread: r.isUnread,
      isSystemNotification: r.isSystemNotification,
      subject: r.subject,
      snippet: snippet(r.bodyText || r.bodyHtml, 200),
      receivedAt: r.receivedAt,
      followUpCount: r.followUpCount ?? 0,
    }));

    const count = (countResult.rows[0] as { c: number } | undefined)?.c ?? 0;

    res.status(200).json({ replies: list, total: count });
  } catch (error) {
    console.error('List replies error:', error);
    res.status(500).json({ error: 'Failed to list replies' });
  }
}

/** Full thread payload by thread root id (for deep links from Sent). */
export async function getReplyThreadByRootHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const threadRootId = parseInt(String(req.params.threadRootId ?? ''), 10);
    if (isNaN(threadRootId) || threadRootId < 1) {
      res.status(400).json({ error: 'Invalid thread root id' });
      return;
    }

    const rows = await db
      .select({
        id: emailRepliesTable.id,
        campaignId: emailRepliesTable.campaignId,
        recipientId: emailRepliesTable.recipientId,
        threadRootId: emailRepliesTable.threadRootId,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
        campaignName: campaignTable.name,
        recipientEmail: recipientTable.email,
        recipientName: recipientTable.name,
        recipientCustomFields: recipientTable.customFields,
        campaignSubject: campaignTable.subject,
        campaignFromEmail: campaignTable.fromEmail,
        campaignEmailContent: campaignTable.emailContent,
        recipientSentAt: recipientTable.sentAt,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .innerJoin(recipientTable, eq(emailRepliesTable.recipientId, recipientTable.id))
      .where(
        and(
          eq(campaignTable.userId, userId),
          or(eq(emailRepliesTable.threadRootId, threadRootId), eq(emailRepliesTable.id, threadRootId))
        )
      )
      .orderBy(asc(emailRepliesTable.id))
      .limit(1);

    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const root = r.threadRootId ?? r.id;

    await db
      .update(emailRepliesTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(emailRepliesTable.campaignId, r.campaignId),
          eq(emailRepliesTable.recipientId, r.recipientId),
          eq(emailRepliesTable.direction, 'inbound'),
          isNull(emailRepliesTable.readAt),
        )
      );

    const messageRows = await db
      .select({
        id: emailRepliesTable.id,
        direction: emailRepliesTable.direction,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .where(
        and(
          eq(campaignTable.userId, userId),
          eq(emailRepliesTable.campaignId, r.campaignId),
          eq(emailRepliesTable.recipientId, r.recipientId),
        )
      )
      .orderBy(asc(emailRepliesTable.receivedAt));

    const recipientForTokens = {
      email: r.recipientEmail,
      name: r.recipientName,
      customFields: r.recipientCustomFields,
    };
    const resolvedThreadSubject = replacePlaceholders(r.campaignSubject ?? '', recipientForTokens).trim();
    const subjectLine =
      resolvedThreadSubject || messageRows[0]?.subject || r.subject;
    const messages = mergeCampaignOriginalSendWithMessages({
      campaignSubject: r.campaignSubject,
      campaignFromEmail: r.campaignFromEmail,
      campaignEmailContent: r.campaignEmailContent,
      recipientId: r.recipientId,
      recipientSentAt: r.recipientSentAt,
      recipientEmail: r.recipientEmail,
      recipientName: r.recipientName,
      recipientCustomFields: r.recipientCustomFields,
      messageRows,
    });

    res.status(200).json({
      threadRootId: root,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      isSystemNotification: isSystemNotificationSender(r.fromEmail),
      subject: subjectLine,
      messages,
    });
  } catch (error) {
    console.error('Get thread by root error:', error);
    res.status(500).json({ error: 'Failed to get thread' });
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
        threadRootId: emailRepliesTable.threadRootId,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
        campaignName: campaignTable.name,
        recipientEmail: recipientTable.email,
        recipientName: recipientTable.name,
        recipientCustomFields: recipientTable.customFields,
        campaignSubject: campaignTable.subject,
        campaignFromEmail: campaignTable.fromEmail,
        campaignEmailContent: campaignTable.emailContent,
        recipientSentAt: recipientTable.sentAt,
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

    const threadRootId = r.threadRootId ?? r.id;

    await db
      .update(emailRepliesTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(emailRepliesTable.campaignId, r.campaignId),
          eq(emailRepliesTable.recipientId, r.recipientId),
          eq(emailRepliesTable.direction, 'inbound'),
          isNull(emailRepliesTable.readAt),
        )
      );

    const messageRows = await db
      .select({
        id: emailRepliesTable.id,
        direction: emailRepliesTable.direction,
        fromEmail: emailRepliesTable.fromEmail,
        subject: emailRepliesTable.subject,
        bodyText: emailRepliesTable.bodyText,
        bodyHtml: emailRepliesTable.bodyHtml,
        receivedAt: emailRepliesTable.receivedAt,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .where(
        and(
          eq(campaignTable.userId, userId),
          eq(emailRepliesTable.campaignId, r.campaignId),
          eq(emailRepliesTable.recipientId, r.recipientId),
        )
      )
      .orderBy(asc(emailRepliesTable.receivedAt));

    const recipientForTokens = {
      email: r.recipientEmail,
      name: r.recipientName,
      customFields: r.recipientCustomFields,
    };
    const resolvedThreadSubject = replacePlaceholders(r.campaignSubject ?? '', recipientForTokens).trim();
    const subjectLine =
      resolvedThreadSubject || messageRows[0]?.subject || r.subject;

    const messages = mergeCampaignOriginalSendWithMessages({
      campaignSubject: r.campaignSubject,
      campaignFromEmail: r.campaignFromEmail,
      campaignEmailContent: r.campaignEmailContent,
      recipientId: r.recipientId,
      recipientSentAt: r.recipientSentAt,
      recipientEmail: r.recipientEmail,
      recipientName: r.recipientName,
      recipientCustomFields: r.recipientCustomFields,
      messageRows,
    });

    res.status(200).json({
      threadRootId,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      isSystemNotification: isSystemNotificationSender(r.fromEmail),
      subject: subjectLine,
      messages,
    });
  } catch (error) {
    console.error('Get reply error:', error);
    res.status(500).json({ error: 'Failed to get reply' });
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function sendReplyHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const id = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid reply id' });
    }

    const body = String(req.body?.body ?? '').trim();
    if (!body) {
      return res.status(400).json({ error: 'Reply body is required' });
    }

    const rows = await db
      .select({
        replyId: emailRepliesTable.id,
        threadRootId: emailRepliesTable.threadRootId,
        replyMessageId: emailRepliesTable.messageId,
        recipientMessageId: recipientTable.messageId,
        campaignId: emailRepliesTable.campaignId,
        recipientId: emailRepliesTable.recipientId,
        recipientEmail: recipientTable.email,
        subject: emailRepliesTable.subject,
        campaignFromName: campaignTable.fromName,
        campaignFromEmail: campaignTable.fromEmail,
        campaignSmtpSettingsId: campaignTable.smtpSettingsId,
      })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .innerJoin(recipientTable, eq(emailRepliesTable.recipientId, recipientTable.id))
      .where(and(eq(emailRepliesTable.id, id), eq(campaignTable.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Reply not found' });
    }

    const subject = toReplySubject(row.subject);
    const safeHtml = `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(body)}</p>`;
    const inReplyToMid = row.replyMessageId || row.recipientMessageId || undefined;
    const inReplyToHeader = formatMessageIdForHeader(inReplyToMid);
    const refParts = [
      formatMessageIdForHeader(row.recipientMessageId),
      formatMessageIdForHeader(row.replyMessageId),
    ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i) as string[];
    const referencesHeader = refParts.length ? refParts.join(' ') : inReplyToHeader;

    const sentRawMessageId = await sendViaSmtp({
      to: row.recipientEmail,
      subject,
      text: body,
      html: safeHtml,
      fromName: row.campaignFromName,
      fromEmail: row.campaignFromEmail,
      userId,
      smtpSettingsId: row.campaignSmtpSettingsId,
      inReplyTo: inReplyToHeader,
      references: referencesHeader,
    });

    const sentMessageId = normalizeMessageId(sentRawMessageId || undefined);
    const threadRoot = row.threadRootId ?? row.replyId;
    const inReplyToStored = normalizeMessageId(inReplyToMid ?? undefined);

    await db.insert(emailRepliesTable).values({
      campaignId: row.campaignId,
      recipientId: row.recipientId,
      fromEmail: row.campaignFromEmail,
      subject,
      bodyText: body,
      bodyHtml: safeHtml.slice(0, 20000),
      messageId: sentMessageId,
      inReplyTo: inReplyToStored,
      direction: 'outbound',
      threadRootId: threadRoot,
    });

    return res.status(200).json({ message: 'Reply sent successfully' });
  } catch (error) {
    console.error('Send reply error:', error);
    return res.status(500).json({ error: 'Failed to send reply' });
  }
}
