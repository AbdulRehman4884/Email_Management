import { formatInTimeZone } from "date-fns-tz";
import { getScheduleTimeZone } from "./localDateTime";

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
