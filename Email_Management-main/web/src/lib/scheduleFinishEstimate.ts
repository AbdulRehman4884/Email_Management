/**
 * Pure helper: given recipients, an effective per-day send rate, allowed weekdays and a start
 * date, estimate how many sending days it takes and roughly when the campaign finishes.
 *
 * This powers the "what will happen" preview under the scheduling builder — it is an estimate,
 * not a guarantee (SMTP hiccups, pauses and quota changes move the real date). It never talks to
 * the backend.
 */

const ISO = (d: Date): number => (d.getDay() === 0 ? 7 : d.getDay());

export interface FinishEstimateInput {
  /** How many recipients still need an email. */
  recipientCount: number;
  /** Effective emails/day: the campaign daily cap, else the selected accounts' combined capacity. null/0 = unknown. */
  perDay: number | null;
  /** ISO weekdays 1–7 the campaign may send on; null/empty = every day. */
  sendWeekdays?: number[] | null;
  /** When sending starts; null = now. */
  start?: Date | null;
}

export interface FinishEstimate {
  recipientCount: number;
  perDay: number | null;
  /** Number of calendar days on which sending happens (not elapsed days). */
  sendingDays: number | null;
  /** Rough finish date, or null when it can't be bounded (no per-day rate). */
  finishDate: Date | null;
  /** One-line, plain-language summary for the preview card. */
  summary: string;
}

function formatDay(d: Date, now: Date): string {
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Walk the calendar from `start`, counting only allowed weekdays, until `sendingDays` are used up. */
function finishDateFor(start: Date, sendingDays: number, allowed: Set<number> | null): Date | null {
  if (sendingDays <= 0) return start;
  let remaining = sendingDays;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let guard = 0; guard < 4000; guard++) {
    if (!allowed || allowed.has(ISO(cursor))) {
      remaining -= 1;
      if (remaining <= 0) return cursor;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

export function estimateScheduleFinish(input: FinishEstimateInput): FinishEstimate {
  const recipientCount = Math.max(0, Math.floor(input.recipientCount || 0));
  const perDay = input.perDay != null && input.perDay > 0 ? Math.floor(input.perDay) : null;
  const now = new Date();
  const start = input.start && !Number.isNaN(input.start.getTime()) ? input.start : now;
  const allowedList = (input.sendWeekdays ?? []).filter((n) => n >= 1 && n <= 7);
  const allowed = allowedList.length > 0 && allowedList.length < 7 ? new Set(allowedList) : null;

  if (recipientCount <= 0) {
    return { recipientCount, perDay, sendingDays: null, finishDate: null, summary: 'Add recipients to see an estimate.' };
  }
  if (!perDay) {
    return {
      recipientCount,
      perDay: null,
      sendingDays: null,
      finishDate: null,
      summary: `${recipientCount.toLocaleString()} recipient${recipientCount === 1 ? '' : 's'} · sends as fast as your accounts allow`,
    };
  }

  const sendingDays = Math.ceil(recipientCount / perDay);
  const finishDate = finishDateFor(start, sendingDays, allowed);
  const parts = [
    `${recipientCount.toLocaleString()} recipient${recipientCount === 1 ? '' : 's'}`,
    `~${perDay.toLocaleString()}/day`,
    `~${sendingDays} sending day${sendingDays === 1 ? '' : 's'}`,
  ];
  if (finishDate) parts.push(`finishes around ${formatDay(finishDate, now)}`);
  return { recipientCount, perDay, sendingDays, finishDate, summary: parts.join(' · ') };
}
