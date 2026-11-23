/**
 * AI reply agent: answers lead replies with AI.
 *
 *  - onReplyLabeled(): called after a NEW inbound reply got its label. When the agent is on (Settings > AI reply
 *    agent) and the label is one it answers, the AI writes an answer:
 *      approve mode → the draft waits in the Inbox (Use draft / Discard);
 *      auto mode    → the draft is scheduled and the CRM worker sends it after the delay (processDueAiReplies).
 *    Off (the default) → nothing happens.
 *  - draftForThread(): the user asks for a draft by hand in the Inbox ("Write with AI"), whatever the mode.
 *  - Before an auto send everything is checked again: the user answered meanwhile, the lead wrote again,
 *    a meeting was booked, the lead unsubscribed, per-thread and daily limits.
 *
 * The send is the same as the Inbox "Send reply" (same thread headers, same sender, outbound row, needs-reply
 * cleared); the Inbox send code itself is not changed.
 */
import { db, dbPool } from '../db.js';
import { emailRepliesTable } from '../../db/schema.js';
import { sendEmail as sendViaSmtp } from '../smtp.js';
import { normalizeMessageId } from '../messageId.js';
import { formatMessageIdForHeader, toReplySubject } from '../emailThreading.js';
import { replacePlaceholders } from '../replacePlaceholders.js';
import { markRepliedForRecipient } from '../crm/needsReply.js';
import { runCrmInBackground } from '../crm/backgroundQueue.js';
import { isReplyLabel, type ReplyLabel } from '../../constants/replyLabels.js';
import { aiConfigured, completeJson } from './ai.js';
import {
  buildReplyMessages,
  decideAiReply,
  detectObjection,
  emailText,
  normalizeSettings,
  parseReplyAnswer,
  withoutQuoted,
  type AiReplySettings,
  type ThreadFacts,
} from './core.js';

export type DraftStatus = 'pending' | 'scheduled' | 'sent' | 'discarded' | 'used' | 'skipped' | 'failed';

export interface AiDraft {
  id: number;
  replyId: number;
  threadRootId: number;
  campaignId: number;
  recipientId: number;
  label: string | null;
  objection: string | null;
  body: string;
  status: DraftStatus;
  sendAfter: string | null;
  sentAt: string | null;
  note: string | null;
  createdAt: string;
}

interface DraftRow {
  id: number;
  reply_id: number;
  thread_root_id: number;
  campaign_id: number;
  recipient_id: number;
  label: string | null;
  objection: string | null;
  body: string;
  status: DraftStatus;
  send_after: Date | null;
  sent_at: Date | null;
  note: string | null;
  created_at: Date;
}

const DRAFT_COLUMNS = `id, reply_id, thread_root_id, campaign_id, recipient_id, label, objection, body, status,
  send_after, sent_at, note, created_at`;

/** timestamptz columns come back as Date: sent to the page as ISO text. */
const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

function toDraft(r: DraftRow): AiDraft {
  return {
    id: r.id,
    replyId: r.reply_id,
    threadRootId: r.thread_root_id,
    campaignId: r.campaign_id,
    recipientId: r.recipient_id,
    label: r.label,
    objection: r.objection,
    body: r.body,
    status: r.status,
    sendAfter: iso(r.send_after),
    sentAt: iso(r.sent_at),
    note: r.note,
    createdAt: iso(r.created_at)!,
  };
}

// ─── Settings ──────────────────────────────────────────────────────────────────

/** Postgres "relation does not exist": migration 0043 is not applied yet. */
export const isMissingTable = (err: unknown) => (err as { code?: string } | null)?.code === '42P01';

export async function getAiReplySettings(userId: number): Promise<AiReplySettings> {
  let r;
  try {
    r = await dbPool.query(
      `SELECT mode, labels, delay_minutes, max_per_thread, daily_limit, offer, meeting_link FROM ai_reply_settings WHERE user_id = $1`,
      [userId],
    );
  } catch (err) {
    // Before migration 0043 the agent is simply off (new replies are not slowed down or logged as errors).
    if (isMissingTable(err)) return normalizeSettings(null);
    throw err;
  }
  const row = r.rows[0];
  if (!row) return normalizeSettings(null);
  return normalizeSettings({
    mode: row.mode,
    labels: row.labels,
    delayMinutes: row.delay_minutes,
    maxPerThread: row.max_per_thread,
    dailyLimit: row.daily_limit,
    offer: row.offer,
    meetingLink: row.meeting_link,
  });
}

export async function saveAiReplySettings(userId: number, body: Record<string, unknown>): Promise<AiReplySettings> {
  const current = await getAiReplySettings(userId);
  const s = normalizeSettings({ ...current, ...body });
  await dbPool.query(
    `INSERT INTO ai_reply_settings (user_id, mode, labels, delay_minutes, max_per_thread, daily_limit, offer, meeting_link, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, labels = EXCLUDED.labels, delay_minutes = EXCLUDED.delay_minutes,
       max_per_thread = EXCLUDED.max_per_thread, daily_limit = EXCLUDED.daily_limit, offer = EXCLUDED.offer,
       meeting_link = EXCLUDED.meeting_link, updated_at = now()`,
    [userId, s.mode, JSON.stringify(s.labels), s.delayMinutes, s.maxPerThread, s.dailyLimit, s.offer, s.meetingLink],
  );
  return s;
}

// ─── Reading a reply and its thread ───────────────────────────────────────────

interface ReplyContext {
  replyId: number;
  userId: number;
  threadRootId: number;
  campaignId: number;
  recipientId: number;
  label: ReplyLabel | null;
  leadEmail: string;
  leadName: string | null;
  customFields: string | null;
  fromName: string;
  campaignSubject: string;
  campaignContent: string;
}

async function loadInboundReply(replyId: number, userId?: number): Promise<ReplyContext | null> {
  const r = await dbPool.query(
    `SELECT er.id, er.label, er.campaign_id, er.recipient_id, COALESCE(er.thread_root_id, er.id) AS thread_root_id,
            c.user_id, c.from_name, c.subject AS campaign_subject, c.email_content,
            rc.email AS lead_email, rc.name AS lead_name, rc.custom_fields
       FROM email_replies er
       JOIN campaigns c ON c.id = er.campaign_id
       JOIN recipients rc ON rc.id = er.recipient_id
      WHERE er.id = $1 AND er.direction = 'inbound' ${userId != null ? 'AND c.user_id = $2' : ''}`,
    userId != null ? [replyId, userId] : [replyId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    replyId: row.id,
    userId: row.user_id,
    threadRootId: row.thread_root_id,
    campaignId: row.campaign_id,
    recipientId: row.recipient_id,
    label: isReplyLabel(row.label) ? row.label : null,
    leadEmail: row.lead_email,
    leadName: row.lead_name,
    customFields: row.custom_fields,
    fromName: row.from_name ?? '',
    campaignSubject: row.campaign_subject ?? '',
    campaignContent: row.email_content ?? '',
  };
}

async function threadMessages(threadRootId: number, upToId: number): Promise<Array<{ from: 'lead' | 'you'; text: string }>> {
  const r = await dbPool.query(
    `SELECT direction, body_text, body_html FROM email_replies
      WHERE COALESCE(thread_root_id, id) = $1 AND id <= $2
      ORDER BY id DESC LIMIT 6`,
    [threadRootId, upToId],
  );
  return r.rows
    .reverse()
    .map((m) => ({ from: m.direction === 'inbound' ? ('lead' as const) : ('you' as const), text: withoutQuoted(emailText(m.body_html, m.body_text)) }))
    .filter((m) => m.text);
}

async function threadFacts(ctx: ReplyContext): Promise<ThreadFacts> {
  const r = await dbPool.query(
    `SELECT
       EXISTS (SELECT 1 FROM email_replies WHERE COALESCE(thread_root_id, id) = $1 AND direction = 'outbound' AND id > $2) AS answered_after,
       EXISTS (SELECT 1 FROM email_replies WHERE COALESCE(thread_root_id, id) = $1 AND direction = 'inbound' AND id > $2) AS newer_inbound,
       EXISTS (SELECT 1 FROM email_replies WHERE COALESCE(thread_root_id, id) = $1 AND label = 'meeting_booked') AS meeting_booked,
       (SELECT count(*)::int FROM ai_reply_drafts WHERE thread_root_id = $1 AND status = 'sent') AS ai_in_thread,
       (SELECT count(*)::int FROM ai_reply_drafts WHERE user_id = $3 AND status = 'sent' AND sent_at > now() - interval '24 hours') AS ai_today,
       EXISTS (SELECT 1 FROM suppression_list WHERE lower(email) = lower($4)) AS suppressed`,
    [ctx.threadRootId, ctx.replyId, ctx.userId, ctx.leadEmail],
  );
  const f = r.rows[0];
  return {
    label: ctx.label,
    answeredAfter: f.answered_after,
    newerInbound: f.newer_inbound,
    meetingBooked: f.meeting_booked,
    aiSentInThread: f.ai_in_thread,
    aiSentToday: f.ai_today,
    suppressed: f.suppressed,
  };
}

function firstNameOf(ctx: ReplyContext): string {
  try {
    const fields = ctx.customFields ? (JSON.parse(ctx.customFields) as Record<string, unknown>) : {};
    for (const k of Object.keys(fields)) {
      if (/^first_?name$/i.test(k) && typeof fields[k] === 'string' && (fields[k] as string).trim()) return (fields[k] as string).trim();
    }
  } catch {
    /* bad JSON: use the name */
  }
  return (ctx.leadName ?? '').trim().split(/\s+/)[0] ?? '';
}

// ─── Writing a draft ──────────────────────────────────────────────────────────

/** The AI writes an answer to one inbound reply. Null + reason when it cannot. */
async function writeAnswer(ctx: ReplyContext, settings: AiReplySettings): Promise<{ body: string; objection: string | null } | { error: string }> {
  if (!aiConfigured()) return { error: 'AI is not set up on this server.' };
  const thread = await threadMessages(ctx.threadRootId, ctx.replyId);
  const last = [...thread].reverse().find((m) => m.from === 'lead')?.text ?? '';
  const objection = detectObjection(last);
  const firstEmail = emailText(
    replacePlaceholders(ctx.campaignContent, { email: ctx.leadEmail, name: ctx.leadName, customFields: ctx.customFields }),
    null,
  );
  const messages = buildReplyMessages({
    senderName: ctx.fromName,
    leadFirstName: firstNameOf(ctx),
    label: ctx.label,
    objection,
    offer: settings.offer,
    meetingLink: settings.meetingLink,
    firstEmail,
    thread,
  });
  // Two tries: the second one is told why the first answer was not usable.
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await completeJson(
      attempt === 0 ? messages : [...messages, { role: 'user', content: `Your last answer was not usable (${reason}). Follow the rules exactly.` }],
      0.6,
    );
    if (answer === null) return { error: 'The AI did not answer. Try again in a moment.' };
    const parsed = parseReplyAnswer(answer, settings.meetingLink);
    if (parsed.ok) return { body: parsed.body, objection };
    reason = parsed.reason;
  }
  return { error: `The AI answer could not be used (${reason}).` };
}

async function insertDraft(
  ctx: ReplyContext,
  body: string,
  objection: string | null,
  status: DraftStatus,
  sendAfterMinutes: number | null,
  note: string | null,
): Promise<AiDraft | null> {
  const r = await dbPool.query<DraftRow>(
    `INSERT INTO ai_reply_drafts (user_id, reply_id, thread_root_id, campaign_id, recipient_id, label, objection, body, status, send_after, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::int IS NULL THEN NULL ELSE now() + ($10::int * interval '1 minute') END, $11)
     ON CONFLICT (reply_id) DO NOTHING
     RETURNING ${DRAFT_COLUMNS}`,
    [ctx.userId, ctx.replyId, ctx.threadRootId, ctx.campaignId, ctx.recipientId, ctx.label, objection, body, status, sendAfterMinutes, note],
  );
  return r.rows[0] ? toDraft(r.rows[0]) : null;
}

/**
 * A new inbound reply got its label. Does nothing when the agent is off (the default) or the reply is not one it
 * answers. Never throws.
 */
export async function onReplyLabeled(replyId: number): Promise<AiDraft | null> {
  try {
    const ctx = await loadInboundReply(replyId);
    if (!ctx) return null;
    const settings = await getAiReplySettings(ctx.userId);
    if (settings.mode === 'off') return null;
    const decision = decideAiReply(settings, await threadFacts(ctx));
    if (!decision.ok) return null;
    const written = await writeAnswer(ctx, settings);
    if ('error' in written) {
      console.warn(`[ai-reply] reply ${replyId}: ${written.error}`);
      return null;
    }
    return settings.mode === 'auto'
      ? insertDraft(ctx, written.body, written.objection, 'scheduled', settings.delayMinutes, null)
      : insertDraft(ctx, written.body, written.objection, 'pending', null, null);
  } catch (err) {
    console.error(`[ai-reply] reply ${replyId} failed:`, err);
    return null;
  }
}

/** Fire-and-forget, after a new reply is labeled. Uses the CRM background queue. */
export function scheduleAiReply(replyId: number): void {
  runCrmInBackground(`ai reply ${replyId}`, () => onReplyLabeled(replyId));
}

// ─── Inbox: drafts of a thread ────────────────────────────────────────────────

/** The newest open draft (pending or scheduled) of a thread, or null. */
export async function openDraftForThread(userId: number, threadRootId: number): Promise<AiDraft | null> {
  const r = await dbPool.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM ai_reply_drafts
      WHERE user_id = $1 AND thread_root_id = $2 AND status IN ('pending', 'scheduled')
      ORDER BY id DESC LIMIT 1`,
    [userId, threadRootId],
  );
  return r.rows[0] ? toDraft(r.rows[0]) : null;
}

export type DraftResult = { ok: true; draft: AiDraft } | { ok: false; status: number; error: string };

/**
 * "Write with AI" in the Inbox: a draft for the newest lead reply of the thread (whatever the mode).
 * An open draft is returned as is; `regenerate` writes a new one in its place.
 */
export async function draftForThread(userId: number, threadRootId: number, regenerate = false): Promise<DraftResult> {
  const latest = await dbPool.query<{ id: number }>(
    `SELECT er.id FROM email_replies er JOIN campaigns c ON c.id = er.campaign_id
      WHERE COALESCE(er.thread_root_id, er.id) = $1 AND er.direction = 'inbound' AND c.user_id = $2
      ORDER BY er.id DESC LIMIT 1`,
    [threadRootId, userId],
  );
  const replyId = latest.rows[0]?.id;
  if (!replyId) return { ok: false, status: 404, error: 'Conversation not found' };
  return draftForReply(userId, replyId, regenerate);
}

export async function draftForReply(userId: number, replyId: number, regenerate = false): Promise<DraftResult> {
  const ctx = await loadInboundReply(replyId, userId);
  if (!ctx) return { ok: false, status: 404, error: 'Reply not found' };
  const existing = await dbPool.query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM ai_reply_drafts WHERE reply_id = $1`, [replyId]);
  const old = existing.rows[0];
  if (old && !regenerate && (old.status === 'pending' || old.status === 'scheduled')) return { ok: true, draft: toDraft(old) };
  if (old?.status === 'sent') return { ok: false, status: 409, error: 'The AI already answered this reply.' };

  const settings = await getAiReplySettings(userId);
  const decision = decideAiReply(settings, await threadFacts(ctx), true);
  if (!decision.ok) return { ok: false, status: 409, error: `No AI reply: ${decision.reason}.` };
  const written = await writeAnswer(ctx, settings);
  if ('error' in written) return { ok: false, status: aiConfigured() ? 502 : 503, error: written.error };

  if (old) {
    const r = await dbPool.query<DraftRow>(
      `UPDATE ai_reply_drafts SET body = $2, objection = $3, status = 'pending', send_after = NULL, note = NULL, label = $4, updated_at = now()
        WHERE id = $1 RETURNING ${DRAFT_COLUMNS}`,
      [old.id, written.body, written.objection, ctx.label],
    );
    return { ok: true, draft: toDraft(r.rows[0]!) };
  }
  const draft = await insertDraft(ctx, written.body, written.objection, 'pending', null, null);
  if (!draft) return { ok: false, status: 409, error: 'A draft was just created. Reload the conversation.' };
  return { ok: true, draft };
}

/** Discard / used (copied into the reply box) / cancel a scheduled send. */
export async function setDraftStatus(userId: number, draftId: number, status: 'discarded' | 'used'): Promise<AiDraft | null> {
  const r = await dbPool.query<DraftRow>(
    `UPDATE ai_reply_drafts SET status = $3, send_after = NULL, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'scheduled')
      RETURNING ${DRAFT_COLUMNS}`,
    [draftId, userId, status],
  );
  return r.rows[0] ? toDraft(r.rows[0]) : null;
}

/** Drafts waiting for approval (newest first). */
export async function listOpenDrafts(userId: number, limit = 50): Promise<AiDraft[]> {
  const r = await dbPool.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM ai_reply_drafts WHERE user_id = $1 AND status IN ('pending', 'scheduled')
      ORDER BY id DESC LIMIT $2`,
    [userId, Math.min(200, Math.max(1, limit))],
  );
  return r.rows.map(toDraft);
}

// ─── Sending ──────────────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Sends a draft's text as a reply in its thread, like the Inbox "Send reply". Returns an error text or null. */
async function sendDraftEmail(draft: { reply_id: number; body: string }, userId: number): Promise<string | null> {
  const r = await dbPool.query(
    `SELECT er.id, er.thread_root_id, er.message_id AS reply_message_id, er.subject, er.campaign_id, er.recipient_id,
            rc.message_id AS recipient_message_id, rc.email AS recipient_email,
            c.from_name, c.from_email, c.smtp_settings_id
       FROM email_replies er
       JOIN campaigns c ON c.id = er.campaign_id
       JOIN recipients rc ON rc.id = er.recipient_id
      WHERE er.id = $1 AND c.user_id = $2`,
    [draft.reply_id, userId],
  );
  const row = r.rows[0];
  if (!row) return 'the reply was deleted';
  const subject = toReplySubject(row.subject);
  const safeHtml = `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(draft.body)}</p>`;
  const inReplyToMid = row.reply_message_id || row.recipient_message_id || undefined;
  const inReplyToHeader = formatMessageIdForHeader(inReplyToMid);
  const refParts = [formatMessageIdForHeader(row.recipient_message_id), formatMessageIdForHeader(row.reply_message_id)].filter(
    (v, i, a) => Boolean(v) && a.indexOf(v) === i,
  ) as string[];
  const referencesHeader = refParts.length ? refParts.join(' ') : inReplyToHeader;

  const sentRawMessageId = await sendViaSmtp({
    to: row.recipient_email,
    subject,
    text: draft.body,
    html: safeHtml,
    fromName: row.from_name,
    fromEmail: row.from_email,
    userId,
    smtpSettingsId: row.smtp_settings_id,
    inReplyTo: inReplyToHeader,
    references: referencesHeader,
  });

  await db.insert(emailRepliesTable).values({
    campaignId: row.campaign_id,
    recipientId: row.recipient_id,
    fromEmail: row.from_email,
    subject,
    bodyText: draft.body,
    bodyHtml: safeHtml.slice(0, 20000),
    messageId: normalizeMessageId(sentRawMessageId || undefined),
    inReplyTo: normalizeMessageId(inReplyToMid ?? undefined),
    direction: 'outbound',
    threadRootId: row.thread_root_id ?? row.id,
    receivedAt: new Date(),
  });
  await markRepliedForRecipient(row.recipient_id);
  return null;
}

/** Inbox plan check for auto sends (admins and legacy users without a plan row are allowed). */
export type AllowUser = (userId: number) => Promise<boolean>;

/**
 * CRM worker: sends scheduled AI replies whose delay is over. Everything is checked again first; a draft that may
 * no longer go out is marked skipped with the reason. Returns counts.
 */
export async function processDueAiReplies(allowUser: AllowUser, limit = 50): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const due = await dbPool.query<DraftRow & { user_id: number }>(
    `SELECT ${DRAFT_COLUMNS}, user_id FROM ai_reply_drafts
      WHERE status = 'scheduled' AND send_after <= now()
      ORDER BY send_after LIMIT $1`,
    [limit],
  );
  for (const d of due.rows) {
    // Only one worker sends a draft: the row must still be scheduled.
    const claim = await dbPool.query(
      `UPDATE ai_reply_drafts SET send_after = NULL, updated_at = now() WHERE id = $1 AND status = 'scheduled' AND send_after IS NOT NULL RETURNING id`,
      [d.id],
    );
    if (!claim.rowCount) continue;
    const mark = (status: DraftStatus, note: string | null) =>
      dbPool.query(
        `UPDATE ai_reply_drafts SET status = $2::varchar, note = $3, sent_at = CASE WHEN $2::varchar = 'sent' THEN now() ELSE sent_at END, updated_at = now() WHERE id = $1`,
        [d.id, status, note],
      );
    try {
      const ctx = await loadInboundReply(d.reply_id, d.user_id);
      if (!ctx) {
        await mark('skipped', 'the reply was deleted');
        out.skipped++;
        continue;
      }
      const settings = await getAiReplySettings(d.user_id);
      if (settings.mode !== 'auto') {
        await mark('pending', 'auto send was turned off: waiting for your approval');
        out.skipped++;
        continue;
      }
      if (!(await allowUser(d.user_id))) {
        await mark('skipped', 'your plan does not include the Inbox');
        out.skipped++;
        continue;
      }
      const decision = decideAiReply(settings, await threadFacts(ctx));
      if (!decision.ok) {
        await mark('skipped', decision.reason);
        out.skipped++;
        continue;
      }
      const error = await sendDraftEmail(d, d.user_id);
      if (error) {
        await mark('skipped', error);
        out.skipped++;
      } else {
        await mark('sent', null);
        out.sent++;
      }
    } catch (err) {
      console.error(`[ai-reply] sending draft ${d.id} failed:`, err);
      await mark('failed', String((err as Error)?.message ?? err).slice(0, 300));
      out.failed++;
    }
  }
  return out;
}

/** Suggestion for the MCP tool draft_reply_suggestion (GET /replies/:id/suggestion). */
export async function suggestionForReply(userId: number, replyId: number) {
  const ctx = await loadInboundReply(replyId, userId);
  if (!ctx) return null;
  const settings = await getAiReplySettings(userId);
  const facts = await threadFacts(ctx);
  const decision = decideAiReply(settings, facts, true);
  let text: string | null = null;
  let reviewReason: string | null = decision.ok ? null : decision.reason;
  if (decision.ok) {
    const result = await draftForReply(userId, replyId);
    if (result.ok) text = result.draft.body;
    else reviewReason = result.error;
  }
  return {
    replyId,
    category: ctx.label ?? 'unlabeled',
    autoReplyMode: settings.mode,
    requiresHumanReview: settings.mode !== 'auto' || !decision.ok,
    reviewReason,
    suggestedReplyText: text,
    suggestedReplyHtml: text ? `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</p>` : null,
    diagnostics: null,
  };
}
