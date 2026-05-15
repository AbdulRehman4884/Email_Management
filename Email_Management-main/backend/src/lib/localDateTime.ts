import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const DATETIME_LOCAL_REGEX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** IANA zone for schedule wall clock (must match `DB_TIMEZONE` in lib/db.ts for operators). */
export function getScheduleTimeZone(): string {
  const z = (process.env.DB_TIMEZONE || process.env.SCHEDULE_TZ || "Asia/Karachi").trim();
  return /^[A-Za-z0-9_/+:. -]+$/.test(z) ? z : "Asia/Karachi";
}

function isValidLocalDateParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  const dt = new Date(year, month - 1, day, hour, minute, second, 0);
  return (
    dt.getFullYear() === year &&
    dt.getMonth() === month - 1 &&
    dt.getDate() === day &&
    dt.getHours() === hour &&
    dt.getMinutes() === minute &&
    dt.getSeconds() === second
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function normalizeLocalScheduleInput(input: string): string | null {
  const trimmed = String(input || "").trim();
  const match = DATETIME_LOCAL_REGEX.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  if (!isValidLocalDateParts(year, month, day, hour, minute, second)) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/**
 * Current time as a wall clock string in `getScheduleTimeZone()` (same frame as DB schedule strings).
 * Works on a UTC app server: not tied to the host OS zone.
 */
export function getCurrentLocalTimestampString(): string {
  return formatInTimeZone(new Date(), getScheduleTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

/**
 * Parse stored schedule string (YYYY-MM-DD HH:MM:SS) as that wall time in the schedule zone → UTC `Date` for comparison.
 * Without this, `new Date(y,m,d,h,mi,s)` uses the **server** zone (e.g. UTC in production) and scheduling breaks.
 */
export function parseLocalTimestamp(dbTimestamp: string | null | undefined): Date | null {
  if (!dbTimestamp) return null;

  const str = String(dbTimestamp).trim().replace("T", " ").slice(0, 19);
  const match = DATETIME_LOCAL_REGEX.exec(str);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1; // 0-11
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  // Calendar in local *constructor* is only a carrier for components; fromZonedTime re-reads them as `timeZone` wall time.
  const asComponents = new Date(year, month, day, hour, minute, second);
  return fromZonedTime(asComponents, getScheduleTimeZone());
}

/**
 * Check if the scheduled time has arrived (or passed) in the schedule time zone.
 */
export function isScheduledTimeReached(scheduledAt: string | null | undefined): boolean {
  if (!scheduledAt) return true;
  const scheduledDate = parseLocalTimestamp(scheduledAt);
  if (!scheduledDate) return true;
  return scheduledDate.getTime() <= Date.now();
}

export function isFutureLocalTimestamp(scheduledAt: string | null | undefined): boolean {
  if (!scheduledAt) return false;
  const scheduledDate = parseLocalTimestamp(scheduledAt);
  if (!scheduledDate) return false;
  return scheduledDate.getTime() > Date.now();
}

/** HH:mm:ss from stored schedule string (first send / daily resume clock). Default 09:00 if missing. */
export function extractScheduleTimeOfDay(scheduledAt: string | null | undefined): { h: number; m: number; s: number } {
  if (!scheduledAt) return { h: 9, m: 0, s: 0 };
  const str = String(scheduledAt).trim().replace("T", " ");
  const timePart = str.length >= 19 ? str.slice(11, 19) : "";
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timePart);
  if (!match) return { h: 9, m: 0, s: 0 };
  return { h: Number(match[1]), m: Number(match[2]), s: Number(match[3] ?? 0) };
}

/** True if current wall clock in schedule zone is at or past the given schedule time-of-day (string compare on HH:mm:ss). */
export function isScheduleTimeOfDayReached(scheduledAt: string | null | undefined, now: Date = new Date()): boolean {
  const { h, m, s } = extractScheduleTimeOfDay(scheduledAt);
  const target = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const cur = formatInTimeZone(now, getScheduleTimeZone(), "HH:mm:ss");
  return cur >= target;
}

/** True when `now` falls on a strictly later calendar day than `pausedAt` in the schedule time zone. */
export function isCalendarDayAfterPaused(pausedAtIso: string | null | undefined, now: Date = new Date()): boolean {
  if (!pausedAtIso) return false;
  const tz = getScheduleTimeZone();
  const pauseDay = formatInTimeZone(new Date(pausedAtIso), tz, "yyyy-MM-dd");
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  return today > pauseDay;
}
