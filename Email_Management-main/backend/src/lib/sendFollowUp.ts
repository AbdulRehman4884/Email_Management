import { eq, and, asc } from "drizzle-orm";
import { campaignTable, emailRepliesTable, recipientTable } from "../db/schema";
import { db } from "./db";
import { sendEmail as sendViaSmtp } from "./smtp.js";
import { normalizeMessageId } from "./messageId.js";
import { resolveCanonicalThreadRootIdForRecipient } from "./replyThreading.js";
import { replacePlaceholders } from "./replacePlaceholders.js";
import { recordSuccessfulSend } from "./dailySendQuota";

function formatMessageIdHeader(messageId: string | null | undefined): string | undefined {
  const normalized = normalizeMessageId(messageId ?? undefined);
  if (!normalized) return undefined;
  return normalized.startsWith("<") ? normalized : `<${normalized}>`;
}

function escapeHtmlForFollowUp(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export type SendFollowUpResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Send one follow-up for a recipient (SMTP + `email_replies` outbound row).
 * `subject`/`body` may still contain placeholders; they are resolved here.
 */
export async function sendFollowUpOutbound(params: {
  userId: number;
  campaignId: number;
  recipientId: number;
  subject: string;
  body: string;
  followUpTemplateId?: string | null;
  /** When true, log to email_send_log for SMTP daily quota (bulk scheduled jobs). */
  recordQuota?: boolean;
}): Promise<SendFollowUpResult> {
  const { userId, campaignId, recipientId, recordQuota } = params;
  const rows = await db
    .select({
      recipientEmail: recipientTable.email,
      recipientName: recipientTable.name,
      recipientCustomFields: recipientTable.customFields,
      recipientMessageId: recipientTable.messageId,
      campaignFromName: campaignTable.fromName,
      campaignFromEmail: campaignTable.fromEmail,
      campaignSmtpSettingsId: campaignTable.smtpSettingsId,
    })
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

  const row = rows[0];
  if (!row) return { ok: false, error: "Recipient not found" };
  if (row.campaignSmtpSettingsId == null) return { ok: false, error: "Campaign has no SMTP profile" };

  const recipientForTokens = {
    email: row.recipientEmail,
    name: row.recipientName,
    customFields: row.recipientCustomFields,
  };
  const resolvedSubject = replacePlaceholders(params.subject, recipientForTokens).trim();
  const resolvedBody = replacePlaceholders(params.body, recipientForTokens).trim();
  if (!resolvedSubject) return { ok: false, error: "Subject is empty after resolving placeholders" };
  if (!resolvedBody) return { ok: false, error: "Body is empty after resolving placeholders" };

  const safeHtml = `<p style="white-space:pre-wrap;margin:0;">${escapeHtmlForFollowUp(resolvedBody)}</p>`;

  // Build threading headers for proper email thread continuation
  const originalMessageId = row.recipientMessageId;
  
  // Get all existing messages in this thread (for References header)
  const existingReplies = await db
    .select({ messageId: emailRepliesTable.messageId })
    .from(emailRepliesTable)
    .where(
      and(
        eq(emailRepliesTable.campaignId, campaignId),
        eq(emailRepliesTable.recipientId, recipientId)
      )
    )
    .orderBy(asc(emailRepliesTable.receivedAt));

  // Build References header: original message + all thread messages
  const allMessageIds = [
    originalMessageId,
    ...existingReplies.map((r) => r.messageId),
  ]
    .filter(Boolean)
    .map((id) => formatMessageIdHeader(id))
    .filter((id): id is string => !!id);

  const references = allMessageIds.length > 0 ? allMessageIds.join(" ") : undefined;

  // In-Reply-To: the most recent message in the thread (or original if no replies)
  const lastMessageId =
    existingReplies.length > 0
      ? existingReplies[existingReplies.length - 1]?.messageId
      : originalMessageId;
  const inReplyTo = formatMessageIdHeader(lastMessageId);

  try {
    const sentRawMessageId = await sendViaSmtp({
      to: row.recipientEmail,
      subject: resolvedSubject,
      text: resolvedBody,
      html: safeHtml,
      fromName: row.campaignFromName,
      fromEmail: row.campaignFromEmail,
      userId,
      smtpSettingsId: row.campaignSmtpSettingsId,
      inReplyTo,
      references,
    });

    const sentMessageId = normalizeMessageId(sentRawMessageId || undefined);
    const existingThreadRoot = await resolveCanonicalThreadRootIdForRecipient(campaignId, recipientId);

    const [inserted] = await db
      .insert(emailRepliesTable)
      .values({
        campaignId,
        recipientId,
        fromEmail: row.campaignFromEmail,
        subject: resolvedSubject,
        bodyText: resolvedBody,
        bodyHtml: safeHtml.slice(0, 20000),
        messageId: sentMessageId,
        inReplyTo: inReplyTo ?? null,
        direction: "outbound",
        threadRootId: existingThreadRoot ?? null,
        followUpTemplateId: params.followUpTemplateId ?? null,
      })
      .returning({ id: emailRepliesTable.id });

    const newId = inserted?.id;
    if (newId != null && existingThreadRoot == null) {
      await db.update(emailRepliesTable).set({ threadRootId: newId }).where(eq(emailRepliesTable.id, newId));
    }

    if (recordQuota) {
      await recordSuccessfulSend(userId, row.campaignSmtpSettingsId, campaignId);
    }

    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg || "Send failed" };
  }
}
