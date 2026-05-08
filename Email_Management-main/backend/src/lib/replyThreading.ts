import { and, asc, eq } from 'drizzle-orm';
import { db } from './db.js';
import { emailRepliesTable, recipientTable } from '../db/schema.js';
import { normalizeMessageId } from './messageId.js';

function tokenizeMessageIdList(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(/<([^>]+)>/g)) {
    const n = normalizeMessageId(m[1]);
    if (n && !seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  if (ids.length === 0) {
    const n = normalizeMessageId(raw);
    if (n) ids.push(n);
  }
  return ids;
}

/** Ordered Message-IDs from inbound headers (In-Reply-To first, then References, then optional Message-Id). */
export function buildInboundRefIdList(input: {
  inReplyTo?: string | null;
  references?: string | null;
  messageId?: string | null;
  headers?: string | Record<string, string> | null;
}): string[] {
  let inReplyTo = input.inReplyTo ?? null;
  let references = input.references ?? null;
  if (!inReplyTo && !references && input.headers) {
    try {
      const h =
        typeof input.headers === 'string'
          ? (JSON.parse(input.headers || '{}') as Record<string, string>)
          : input.headers;
      inReplyTo = h['In-Reply-To'] || h['in-reply-to'] || null;
      references = h['References'] || h['references'] || null;
    } catch {
      /* ignore */
    }
  }
  const ordered: string[] = [];
  const add = (arr: string[]) => {
    for (const x of arr) {
      if (x && !ordered.includes(x)) ordered.push(x);
    }
  };
  add(tokenizeMessageIdList(inReplyTo));
  add(tokenizeMessageIdList(references));
  const mid = normalizeMessageId(input.messageId ?? undefined);
  if (mid && !ordered.includes(mid)) ordered.push(mid);
  return ordered;
}

export type ParentEmailReply = { id: number; threadRootId: number | null };

export type ResolvedReplyTarget = {
  recipientId: number;
  campaignId: number;
  /** Set when In-Reply-To / References matched an existing `email_replies` row */
  parentEmailReply: ParentEmailReply | null;
};

/**
 * Walk referenced Message-IDs in order; first hit on `recipients.message_id` or `email_replies.message_id` wins.
 */
export async function resolveReplyTargetFromRefIds(rawIds: string[]): Promise<ResolvedReplyTarget | null> {
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const mid = normalizeMessageId(raw);
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);

    const [recRow] = await db
      .select({ id: recipientTable.id, campaignId: recipientTable.campaignId })
      .from(recipientTable)
      .where(eq(recipientTable.messageId, mid))
      .limit(1);
    if (recRow) {
      return {
        recipientId: recRow.id,
        campaignId: recRow.campaignId,
        parentEmailReply: null,
      };
    }

    const [replyRow] = await db
      .select({
        id: emailRepliesTable.id,
        threadRootId: emailRepliesTable.threadRootId,
        recipientId: emailRepliesTable.recipientId,
        campaignId: emailRepliesTable.campaignId,
      })
      .from(emailRepliesTable)
      .where(eq(emailRepliesTable.messageId, mid))
      .limit(1);
    if (replyRow) {
      return {
        recipientId: replyRow.recipientId,
        campaignId: replyRow.campaignId,
        parentEmailReply: { id: replyRow.id, threadRootId: replyRow.threadRootId },
      };
    }
  }
  return null;
}

export function effectiveThreadRootId(parent: ParentEmailReply | null): number | null {
  if (!parent) return null;
  return parent.threadRootId ?? parent.id;
}

/** Oldest row for this recipient defines the thread root so follow-ups chain onto one conversation. */
export async function resolveCanonicalThreadRootIdForRecipient(
  campaignId: number,
  recipientId: number,
): Promise<number | null> {
  const rows = await db
    .select({
      id: emailRepliesTable.id,
      threadRootId: emailRepliesTable.threadRootId,
    })
    .from(emailRepliesTable)
    .where(and(eq(emailRepliesTable.campaignId, campaignId), eq(emailRepliesTable.recipientId, recipientId)))
    .orderBy(asc(emailRepliesTable.receivedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return row.threadRootId ?? row.id;
}

/**
 * Insert an inbound reply row and fix `thread_root_id` when this message starts a new thread.
 */
export async function persistInboundEmailReply(input: {
  campaignId: number;
  recipientId: number;
  fromEmail: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  parentEmailReply: ParentEmailReply | null;
}): Promise<number> {
  const threadRootId = effectiveThreadRootId(input.parentEmailReply);

  const [inserted] = await db
    .insert(emailRepliesTable)
    .values({
      campaignId: input.campaignId,
      recipientId: input.recipientId,
      fromEmail: input.fromEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      direction: 'inbound',
      threadRootId,
    })
    .returning({ id: emailRepliesTable.id });

  const newId = inserted?.id;
  if (newId == null) {
    throw new Error('persistInboundEmailReply: insert returned no id');
  }

  if (threadRootId == null) {
    await db
      .update(emailRepliesTable)
      .set({ threadRootId: newId })
      .where(eq(emailRepliesTable.id, newId));
  }

  return newId;
}
