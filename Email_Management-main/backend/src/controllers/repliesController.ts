import type { Request, Response } from 'express';
import { emailRepliesTable, campaignTable, recipientTable } from '../db/schema';
import { db, dbPool } from '../lib/db';
import { eq, and, or, asc, isNull } from 'drizzle-orm';
import { sendEmail as sendViaSmtp } from '../lib/smtp.js';
import { normalizeMessageId } from '../lib/messageId.js';
import { sanitizeInboundEmailHtmlForDisplay } from '../lib/sanitizeEmailHtml.js';
import {
  analyzeAndStoreReplyIntelligence,
  getReplyIntelligenceByReplyId,
  listHotLeads,
  listMeetingReadyLeads,
  markReplyForHumanReview,
  summarizeObjections,
} from '../lib/replyIntelligence.js';

function snippet(str: string | null, maxLen: number): string {
  if (!str) return '';
  const plain = str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length <= maxLen ? plain : plain.slice(0, maxLen) + '…';
}

function angleMessageId(raw: string | null | undefined): string | undefined {
  const n = normalizeMessageId(raw ?? undefined);
  if (!n) return undefined;
  return `<${n}>`;
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

export async function listRepliesHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const campaignId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : null;
    const kind = parseReplyListKind(req.query.kind);
    const offset = (page - 1) * limit;

    const campSql = campaignId != null && !isNaN(campaignId) ? `AND er.campaign_id = $2` : '';
    const kindSql =
      kind === 'system'
        ? `AND ${systemSenderSql}`
        : kind === 'replies'
          ? `AND NOT ${systemSenderSql}`
          : '';
    const listParams: unknown[] =
      campaignId != null && !isNaN(campaignId) ? [userId, campaignId, limit, offset] : [userId, limit, offset];
    const limitIdx = campaignId != null && !isNaN(campaignId) ? 3 : 2;
    const offsetIdx = campaignId != null && !isNaN(campaignId) ? 4 : 3;

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
          ri.intent_category AS "intentCategory",
          ri.sentiment,
          ri.objection_type AS "objectionType",
          ri.lead_temperature AS "leadTemperature",
          ri.hot_lead_score AS "hotLeadScore",
          ri.meeting_ready AS "meetingReady",
          ri.requires_human_review AS "requiresHumanReview",
          ri.review_status AS "reviewStatus",
          ri.suggested_reply_text AS "suggestedReplyText",
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
          r.email AS "recipientEmail"
        FROM email_replies er
        INNER JOIN campaigns c ON er.campaign_id = c.id
        INNER JOIN recipients r ON er.recipient_id = r.id
        LEFT JOIN reply_intelligence ri ON ri.reply_id = er.id
        WHERE c.user_id = $1 ${campSql} ${kindSql}
        ORDER BY COALESCE(er.thread_root_id, er.id), er.received_at DESC
      ) threads
      ORDER BY "receivedAt" DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const countParams: unknown[] = campaignId != null && !isNaN(campaignId) ? [userId, campaignId] : [userId];
    const countSql = `
      SELECT count(*)::int AS c FROM (
        SELECT DISTINCT COALESCE(er.thread_root_id, er.id) AS tk
        FROM email_replies er
        INNER JOIN campaigns c ON er.campaign_id = c.id
        WHERE c.user_id = $1 ${campSql} ${kindSql}
      ) t
    `;

    const [listResult, countResult] = await Promise.all([
      dbPool.query(listSql, listParams),
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
      intentCategory: string | null;
      sentiment: string | null;
      objectionType: string | null;
      leadTemperature: string | null;
      hotLeadScore: number | null;
      meetingReady: boolean | null;
      requiresHumanReview: boolean | null;
      reviewStatus: string | null;
      suggestedReplyText: string | null;
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
      intelligence: r.intentCategory ? {
        category: r.intentCategory,
        sentiment: r.sentiment,
        objectionType: r.objectionType,
        leadTemperature: r.leadTemperature,
        hotLeadScore: r.hotLeadScore ?? 0,
        meetingReady: r.meetingReady === true,
        requiresHumanReview: r.requiresHumanReview === true,
        reviewStatus: r.reviewStatus,
        hasSuggestedReply: Boolean(r.suggestedReplyText),
      } : null,
      receivedAt: r.receivedAt,
    }));

    const count = (countResult.rows[0] as { c: number } | undefined)?.c ?? 0;

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
        threadRootId: emailRepliesTable.threadRootId,
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

    const threadRootId = r.threadRootId ?? r.id;

    await db
      .update(emailRepliesTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(emailRepliesTable.campaignId, r.campaignId),
          or(eq(emailRepliesTable.threadRootId, threadRootId), eq(emailRepliesTable.id, threadRootId)),
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
          or(eq(emailRepliesTable.threadRootId, threadRootId), eq(emailRepliesTable.id, threadRootId))
        )
      )
      .orderBy(asc(emailRepliesTable.receivedAt));

    const subjectLine = messageRows[0]?.subject ?? r.subject;

    const messages = messageRows.map((row) => ({
      ...row,
      bodyHtml: row.bodyHtml != null ? sanitizeInboundEmailHtmlForDisplay(row.bodyHtml) : row.bodyHtml,
    }));
    const intelligence = await getReplyIntelligenceByReplyId(r.id) ?? await analyzeAndStoreReplyIntelligence(r.id);

    res.status(200).json({
      threadRootId,
      campaignId: r.campaignId,
      recipientId: r.recipientId,
      campaignName: r.campaignName,
      recipientEmail: r.recipientEmail,
      isSystemNotification: isSystemNotificationSender(r.fromEmail),
      subject: subjectLine,
      messages,
      intelligence,
    });
  } catch (error) {
    console.error('Get reply error:', error);
    res.status(500).json({ error: 'Failed to get reply' });
  }
}

function toReplySubject(subject: string): string {
  const s = (subject || '').trim();
  if (!s) return 'Re:';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
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
    const inReplyToHeader = angleMessageId(inReplyToMid);
    const refParts = [angleMessageId(row.recipientMessageId), angleMessageId(row.replyMessageId)].filter(
      (v, i, a) => Boolean(v) && a.indexOf(v) === i
    ) as string[];
    const referencesHeader = refParts.length ? refParts.join(' ') : inReplyToHeader;

    const sentRawMessageId = await sendViaSmtp({
      to: row.recipientEmail,
      subject,
      text: body,
      html: safeHtml,
      fromName: row.campaignFromName,
      fromEmail: row.campaignFromEmail,
      userId,
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

export async function replyIntelligenceSummaryHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : null;
    const summary = await summarizeObjections({
      userId,
      campaignId: campaignId != null && !isNaN(campaignId) ? campaignId : null,
    });
    return res.status(200).json(summary);
  } catch (error) {
    console.error('Reply intelligence summary error:', error);
    return res.status(500).json({ error: 'Failed to retrieve reply intelligence summary' });
  }
}

export async function hotLeadsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : null;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
    const leads = await listHotLeads({
      userId,
      campaignId: campaignId != null && !isNaN(campaignId) ? campaignId : null,
      limit,
    });
    return res.status(200).json({ leads, total: leads.length });
  } catch (error) {
    console.error('Hot leads error:', error);
    return res.status(500).json({ error: 'Failed to retrieve hot leads' });
  }
}

export async function meetingReadyLeadsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = req.query.campaignId ? parseInt(String(req.query.campaignId), 10) : null;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 10;
    const leads = await listMeetingReadyLeads({
      userId,
      campaignId: campaignId != null && !isNaN(campaignId) ? campaignId : null,
      limit,
    });
    return res.status(200).json({ leads, total: leads.length });
  } catch (error) {
    console.error('Meeting-ready leads error:', error);
    return res.status(500).json({ error: 'Failed to retrieve meeting-ready leads' });
  }
}

export async function getReplySuggestionHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid reply id' });

    const [reply] = await db
      .select({ id: emailRepliesTable.id })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .where(and(eq(emailRepliesTable.id, id), eq(campaignTable.userId, userId)))
      .limit(1);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const intelligence = await analyzeAndStoreReplyIntelligence(id);
    return res.status(200).json({
      replyId: id,
      category: intelligence.category,
      autoReplyMode: intelligence.autoReplyMode,
      requiresHumanReview: intelligence.requiresHumanReview,
      reviewReason: intelligence.reviewReason,
      suggestedReplyText: intelligence.suggestedReplyText,
      suggestedReplyHtml: intelligence.suggestedReplyHtml,
      diagnostics: intelligence.suggestionDiagnostics,
    });
  } catch (error) {
    console.error('Reply suggestion error:', error);
    return res.status(500).json({ error: 'Failed to generate reply suggestion' });
  }
}

export async function markReplyReviewHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid reply id' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;

    const [reply] = await db
      .select({ id: emailRepliesTable.id })
      .from(emailRepliesTable)
      .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
      .where(and(eq(emailRepliesTable.id, id), eq(campaignTable.userId, userId)))
      .limit(1);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    await analyzeAndStoreReplyIntelligence(id);
    await markReplyForHumanReview(id, reason);
    return res.status(200).json({ message: 'Reply marked for human review', replyId: id });
  } catch (error) {
    console.error('Mark reply review error:', error);
    return res.status(500).json({ error: 'Failed to mark reply for review' });
  }
}
