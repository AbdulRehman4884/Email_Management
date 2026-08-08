import { eq, and, asc } from "drizzle-orm";
import { campaignTable, emailRepliesTable, recipientTable } from "../db/schema";
import { db } from "./db";
import { sendEmail as sendViaSmtp } from "./smtp.js";
import { normalizeMessageId } from "./messageId.js";
import { resolveCanonicalThreadRootIdForRecipient } from "./replyThreading.js";
import { replacePlaceholders } from "./replacePlaceholders.js";
import { recordSuccessfulSend } from "./dailySendQuota";
import {
  buildOutboundThreadHeaders,
  resolveThreadSubjectForOutbound,
} from "./emailThreading.js";

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
 * The SMTP subject uses `Re: …` on the original campaign thread (not the template title)
 * so Gmail/Outlook keep the message in the same conversation.
 */
export async function sendFollowUpOutbound(params: {
  userId: number;
  campaignId: number;
  recipientId: number;
  subject: string;
  body: string;
  followUpTemplateId?: string | null;
  followUpJobId?: number | null;
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
      campaignSubject: campaignTable.subject,
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
  const resolvedBody = replacePlaceholders(params.body, recipientForTokens).trim();
  if (!resolvedBody) return { ok: false, error: "Body is empty after resolving placeholders" };

  const existingReplies = await db
    .select({
      messageId: emailRepliesTable.messageId,
      subject: emailRepliesTable.subject,
    })
    .from(emailRepliesTable)
    .where(
      and(
        eq(emailRepliesTable.campaignId, campaignId),
        eq(emailRepliesTable.recipientId, recipientId)
      )
    )
    .orderBy(asc(emailRepliesTable.receivedAt));

  const { inReplyTo, references, lastMessageIdNormalized } = buildOutboundThreadHeaders({
    originalMessageId: row.recipientMessageId,
    threadMessages: existingReplies,
  });

  if (!lastMessageIdNormalized) {
    return {
      ok: false,
      error:
        "Cannot thread follow-up: original email has no Message-ID. Resend the campaign email to this recipient or wait until the primary send completes.",
    };
  }

  const threadSubject = resolveThreadSubjectForOutbound({
    campaignSubject: row.campaignSubject,
    threadMessages: existingReplies,
  });

  const safeHtml = `<p style="white-space:pre-wrap;margin:0;">${escapeHtmlForFollowUp(resolvedBody)}</p>`;

  try {
    const sentRawMessageId = await sendViaSmtp({
      to: row.recipientEmail,
      subject: threadSubject,
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
        subject: threadSubject,
        bodyText: resolvedBody,
        bodyHtml: safeHtml.slice(0, 20000),
        messageId: sentMessageId,
        inReplyTo: lastMessageIdNormalized,
        direction: "outbound",
        threadRootId: existingThreadRoot ?? null,
        followUpTemplateId: params.followUpTemplateId ?? null,
        followUpJobId: params.followUpJobId ?? null,
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
