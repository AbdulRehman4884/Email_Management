/**
 * Backend stores `scheduledAt` as a wall-clock string (YYYY-MM-DD HH:MM:SS) — same clock the user picked.
 * `new Date("...T...")` without a timezone is often treated as **UTC** in JS engines, which shifts the UI by hours.
 * These helpers always interpret that string in the **browser's local** calendar, matching datetime-local and the server intent.
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
const DATETIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/;

function hasExplicitOffset(s: string): boolean {
  return /Z$|[+-]\d{2}:?\d{2}$/i.test(s.trim());
}

/**
 * Turn API / form schedule strings into a local Date (for comparisons and display).
 */
export function localScheduleStringToDate(s: string): Date | null {
  const raw = String(s).trim();
  if (!raw) return null;
  if (hasExplicitOffset(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const mLocal = DATETIME_LOCAL.exec(raw);
  if (mLocal) {
    const y = +mLocal[1], mo = +mLocal[2], d = +mLocal[3], h = +mLocal[4], min = +mLocal[5];
    return new Date(y, mo - 1, d, h, min, 0, 0);
  }
  const head = raw.slice(0, 19).replace('T', ' ');
  const m = WALL.exec(head);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], min = +m[5], sec = +(m[6] ?? 0);
  return new Date(y, mo - 1, d, h, min, sec, 0);
}

/**
 * User-facing label for a stored schedule (e.g. Campaign Details, agent cards).
 */
export function formatLocalScheduleDisplay(s: string, locale: string = 'en-US'): string {
  const dt = localScheduleStringToDate(s);
  if (!dt) return s;
  return dt.toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
