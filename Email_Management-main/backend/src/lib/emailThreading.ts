import { normalizeMessageId } from "./messageId.js";

/** Subject line clients expect for a reply in an existing thread. */
export function toReplySubject(subject: string): string {
  const s = (subject || "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function formatMessageIdForHeader(
  messageId: string | null | undefined
): string | undefined {
  const normalized = normalizeMessageId(messageId ?? undefined);
  if (!normalized) return undefined;
  return `<${normalized}>`;
}

export type ThreadMessageRef = {
  messageId: string | null;
  subject?: string;
};

/**
 * Build In-Reply-To / References for an outbound message continuing a thread.
 * Order: original campaign send, then each prior reply/follow-up chronologically.
 */
export function buildOutboundThreadHeaders(input: {
  originalMessageId: string | null;
  threadMessages: ThreadMessageRef[];
}): {
  inReplyTo?: string;
  references?: string;
  lastMessageIdNormalized: string | null;
} {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const n = normalizeMessageId(raw ?? undefined);
    if (n && !seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  };

  add(input.originalMessageId);
  for (const row of input.threadMessages) {
    add(row.messageId);
  }

  const headerIds = ordered.map((id) => `<${id}>`);
  const lastMessageIdNormalized =
    ordered.length > 0 ? ordered[ordered.length - 1]! : null;

  return {
    inReplyTo: lastMessageIdNormalized
      ? `<${lastMessageIdNormalized}>`
      : undefined,
    references: headerIds.length > 0 ? headerIds.join(" ") : undefined,
    lastMessageIdNormalized,
  };
}

/** Use the latest message subject in the thread, or the campaign subject for the first follow-up. */
export function resolveThreadSubjectForOutbound(input: {
  campaignSubject: string;
  threadMessages: Array<{ subject: string }>;
}): string {
  const last = input.threadMessages[input.threadMessages.length - 1];
  const base = (last?.subject || input.campaignSubject || "").trim();
  return toReplySubject(base);
}
