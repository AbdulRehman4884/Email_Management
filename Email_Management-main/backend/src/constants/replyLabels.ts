/**
 * CRM reply labels: one shared list for the backend.
 * The web app keeps an identical copy in web/src/lib/replyLabels.ts — keep both in sync.
 */
export const REPLY_LABELS = [
  'interested',
  'not_interested',
  'out_of_office',
  'question',
  'meeting_booked',
  'neutral',
  'bounce_unsubscribe',
] as const;

export type ReplyLabel = (typeof REPLY_LABELS)[number];

/** 'keyword' = rules in replyLabeling.ts, 'ai' = model, 'manual' = changed by the user. */
export type ReplyLabelSource = 'keyword' | 'ai' | 'manual';

export const REPLY_LABEL_META: Record<ReplyLabel, { name: string; color: string; emoji: string }> = {
  interested: { name: 'Interested', color: '#22c55e', emoji: '🟢' },
  not_interested: { name: 'Not Interested', color: '#ef4444', emoji: '🔴' },
  out_of_office: { name: 'Out of Office', color: '#eab308', emoji: '🟡' },
  question: { name: 'Question', color: '#3b82f6', emoji: '🔵' },
  meeting_booked: { name: 'Meeting Booked', color: '#a855f7', emoji: '🟣' },
  neutral: { name: 'Neutral', color: '#9ca3af', emoji: '⚪' },
  bounce_unsubscribe: { name: 'Bounce / Unsubscribe', color: '#111827', emoji: '⚫' },
};

export function isReplyLabel(value: unknown): value is ReplyLabel {
  return typeof value === 'string' && (REPLY_LABELS as readonly string[]).includes(value);
}
