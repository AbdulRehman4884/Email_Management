/**
 * Schedule maths (pure, no database). Times are kept in the user's IANA timezone and saved in UTC.
 *   - next run: the first slot (run_at_local on an allowed weekday) strictly after `after`
 *   - no backlog: the caller passes `now` after a downtime, so missed days are skipped, not replayed
 *   - jitter: 0-10 minutes, never past local midnight, so the run date stays the slot's date
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { ScheduleFrequency, Weekday } from './types.js';

export const DEFAULT_TIMEZONE = 'Asia/Karachi';
export const MAX_JITTER_MS = 10 * 60_000;
export const EVERY_DAY_MASK = 127;

/** Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64 (search_schedules.weekdays_mask). */
export const WEEKDAY_BITS: Record<Weekday, number> = { mon: 1, tue: 2, wed: 4, thu: 8, fri: 16, sat: 32, sun: 64 };
const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function weekdaysToMask(days: Weekday[] | null | undefined): number {
  if (!days || days.length === 0) return EVERY_DAY_MASK;
  return days.reduce((m, d) => m | WEEKDAY_BITS[d], 0) || EVERY_DAY_MASK;
}

export function maskToWeekdays(mask: number): Weekday[] {
  return WEEKDAY_ORDER.filter((d) => (mask & WEEKDAY_BITS[d]) !== 0);
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "9:00", "09:00", "09:00:00" -> "09:00:00". Null when it is not a time of day. */
export function normalizeLocalTime(input: string): string | null {
  const m = input.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || min > 59 || s > 59) return null;
  return [h, min, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface ScheduleTiming {
  frequency: ScheduleFrequency;
  /** "HH:MM" or "HH:MM:SS" (Postgres time). */
  runAtLocal: string;
  timezone: string;
  weekdaysMask: number;
}

/** Bit of a "yyyy-MM-dd" calendar date (the weekday does not depend on a timezone). */
function weekdayBit(localDate: string): number {
  const sunday0 = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return 1 << ((sunday0 + 6) % 7);
}

function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The date ("yyyy-MM-dd") of an instant in a timezone. */
export function localDateOf(at: Date, timezone: string): string {
  return formatInTimeZone(at, timezone, 'yyyy-MM-dd');
}

/**
 * First slot strictly after `after` (UTC Date), plus jitter.
 * `random` returns [0, 1); pass () => 0 for no jitter.
 */
export function computeNextRunAt(s: ScheduleTiming, after: Date, random: () => number = Math.random): Date {
  const tz = isValidTimezone(s.timezone) ? s.timezone : DEFAULT_TIMEZONE;
  const time = normalizeLocalTime(s.runAtLocal) ?? '09:00:00';
  const mask = s.frequency === 'daily' ? EVERY_DAY_MASK : s.weekdaysMask & EVERY_DAY_MASK || EVERY_DAY_MASK;
  const start = localDateOf(after, tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start, i);
    if ((mask & weekdayBit(day)) === 0) continue;
    const slot = fromZonedTime(`${day}T${time}`, tz);
    if (slot.getTime() <= after.getTime()) continue;
    const midnight = fromZonedTime(`${addDays(day, 1)}T00:00:00`, tz).getTime();
    const room = Math.max(0, Math.min(MAX_JITTER_MS, midnight - slot.getTime() - 60_000));
    return new Date(slot.getTime() + Math.floor(random() * room));
  }
  // Unreachable with a valid mask (every week has an allowed day).
  return new Date(after.getTime() + 86_400_000);
}
