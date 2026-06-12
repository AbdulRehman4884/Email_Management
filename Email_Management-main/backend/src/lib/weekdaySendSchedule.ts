import { getScheduleTimeZone } from "./localDateTime.js";

const SHORT_WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** ISO weekday: Monday = 1 … Sunday = 7. Uses schedule timezone wall calendar (same as DB_TIMEZONE). */
export function getIsoWeekdayInScheduleZone(now: Date = new Date()): number {
  const tz = getScheduleTimeZone();
  const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  return SHORT_WEEKDAY_TO_ISO[short] ?? 1;
}

/** DB/API JSON: unique ints in [1,7]. Null or empty after parse = send any day. */
export function parseSendWeekdaysJson(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const nums = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n));
  const uniq = [...new Set(nums.map((n) => Math.floor(n)))].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
  if (uniq.length === 0) return null;
  return uniq;
}

export function isSendWeekdayAllowed(isoDow: number, allowed: number[] | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(isoDow);
}

export function parseSendWeekdaysBody(raw: unknown): { ok: true; val: number[] | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, val: null };
  if (raw === null) return { ok: true, val: null };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "sendWeekdays must be an array of integers 1–7 (Monday–Sunday)" };
  }
  const parsed = parseSendWeekdaysJson(raw);
  if (!parsed) {
    return { ok: false, error: "sendWeekdays must include at least one day (1=Mon … 7=Sun)" };
  }
  return { ok: true, val: parsed };
}
