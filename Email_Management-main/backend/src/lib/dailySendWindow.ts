import { formatInTimeZone } from "date-fns-tz";
import { getScheduleTimeZone } from "./localDateTime";
import { getIsoWeekdayInScheduleZone, isSendWeekdayAllowed, parseSendWeekdaysJson } from "./weekdaySendSchedule.js";

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function parseDailySendWindowTime(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = TIME_RE.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3] ?? 0);
  if (h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export type DailySendWindowFields = {
  dailySendWindowStart: string | null;
  dailySendWindowEnd: string | null;
};

export function hasDailySendWindow(c: DailySendWindowFields): boolean {
  return Boolean(c.dailySendWindowStart && c.dailySendWindowEnd);
}

function toSeconds(hhmmss: string): number {
  const m = TIME_RE.exec(hhmmss.trim());
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Current wall-clock time in schedule zone as seconds since midnight. */
export function getCurrentScheduleSeconds(now: Date = new Date()): number {
  const cur = formatInTimeZone(now, getScheduleTimeZone(), "HH:mm:ss");
  return toSeconds(cur);
}

/**
 * True when `now` is inside [start, end) in schedule timezone.
 * If end < start, window crosses midnight (e.g. 23:00–02:00).
 */
export function isWithinDailySendWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date = new Date()
): boolean {
  const s = start ? parseDailySendWindowTime(start) : null;
  const e = end ? parseDailySendWindowTime(end) : null;
  if (!s || !e) return true;
  const startSec = toSeconds(s);
  const endSec = toSeconds(e);
  if (startSec === endSec) return false;
  const cur = getCurrentScheduleSeconds(now);
  if (startSec < endSec) {
    return cur >= startSec && cur < endSec;
  }
  return cur >= startSec || cur < endSec;
}

/** True when weekday filter and daily send window (if set) allow sending right now. */
export function campaignCanSendNow(c: {
  sendWeekdays?: number[] | null;
  dailySendWindowStart?: string | null;
  dailySendWindowEnd?: string | null;
}): boolean {
  const sendDays = parseSendWeekdaysJson(c.sendWeekdays);
  if (!isSendWeekdayAllowed(getIsoWeekdayInScheduleZone(), sendDays)) return false;
  const windowSet = Boolean(c.dailySendWindowStart && c.dailySendWindowEnd);
  if (windowSet && !isWithinDailySendWindow(c.dailySendWindowStart, c.dailySendWindowEnd)) {
    return false;
  }
  return true;
}

/**
 * Milliseconds from `now` until the next moment that both the weekday filter and the daily time
 * window allow a send. 0 when a send is allowed right now. Used to hold (not skip) an automation
 * email that falls due outside its sending days/hours, e.g. a "wait 2 days" that lands on a Sunday.
 */
export function nextSendDelayMs(
  fields: {
    sendWeekdays?: number[] | null;
    dailySendWindowStart?: string | null;
    dailySendWindowEnd?: string | null;
  },
  now: Date = new Date()
): number {
  const allowed = parseSendWeekdaysJson(fields.sendWeekdays);
  const s = fields.dailySendWindowStart ? parseDailySendWindowTime(fields.dailySendWindowStart) : null;
  const e = fields.dailySendWindowEnd ? parseDailySendWindowTime(fields.dailySendWindowEnd) : null;
  const hasWindow = Boolean(s && e && toSeconds(s!) !== toSeconds(e!));
  const everyDay = !allowed || allowed.length === 0;
  if (everyDay && !hasWindow) return 0;

  const currentSec = getCurrentScheduleSeconds(now);
  const startSec = hasWindow ? toSeconds(s!) : 0;
  const endSec = hasWindow ? toSeconds(e!) : 86_400;
  const crosses = hasWindow && startSec > endSec;

  for (let d = 0; d <= 7; d++) {
    const dayDate = new Date(now.getTime() + d * 86_400_000);
    if (allowed && !allowed.includes(getIsoWeekdayInScheduleZone(dayDate))) continue;
    const floor = d === 0 ? currentSec : 0; // earliest second-of-day we may pick on this day
    let target: number | null;
    if (!hasWindow) {
      target = floor; // any time of day is fine
    } else if (!crosses) {
      target = floor >= endSec ? null : Math.max(startSec, floor); // today's window ended → try next day
    } else {
      // Window crosses midnight: valid seconds are [startSec, 86400) ∪ [0, endSec).
      if (floor < endSec) target = floor;
      else if (floor < startSec) target = startSec;
      else target = floor;
    }
    if (target === null) continue;
    const delaySec = d * 86_400 - currentSec + target;
    return Math.max(0, delaySec * 1000);
  }
  return 60 * 60 * 1000; // safety fallback: re-check in an hour (should never be reached)
}

export function parseDailySendWindowBody(body: unknown):
  | { ok: true; start: string | null; end: string | null }
  | { ok: false; error: string } {
  const b = body as Record<string, unknown>;
  const hasStart = b.dailySendWindowStart !== undefined && b.dailySendWindowStart !== null && b.dailySendWindowStart !== "";
  const hasEnd = b.dailySendWindowEnd !== undefined && b.dailySendWindowEnd !== null && b.dailySendWindowEnd !== "";
  if (!hasStart && !hasEnd) return { ok: true, start: null, end: null };
  if (hasStart !== hasEnd) {
    return { ok: false, error: "dailySendWindowStart and dailySendWindowEnd must both be set or both empty." };
  }
  const start = parseDailySendWindowTime(b.dailySendWindowStart);
  const end = parseDailySendWindowTime(b.dailySendWindowEnd);
  if (!start || !end) {
    return { ok: false, error: "dailySendWindowStart and dailySendWindowEnd must be valid times (HH:mm)." };
  }
  if (toSeconds(start) === toSeconds(end)) {
    return { ok: false, error: "Daily send window start and end cannot be the same time." };
  }
  return { ok: true, start, end };
}
