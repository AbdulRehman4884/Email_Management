import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { sql } from "drizzle-orm";
import {
  getCurrentLocalTimestampString,
  getScheduleTimeZone,
  isScheduledTimeReached,
  normalizeLocalScheduleInput,
  parseLocalTimestamp,
} from "./localDateTime.js";

/** Store normalized schedule string as PostgreSQL varchar literal (matches campaign schedule columns). */
export function scheduleStringAsVarchar(s: string) {
  const t = String(s).trim().replace("T", " ").slice(0, 19);
  return sql.raw(`'${t.replace(/'/g, "''")}'::varchar(30)`);
}

export function addMinutesToWallClock(wallTimestamp: string, minutesToAdd: number): string | null {
  if (!Number.isFinite(minutesToAdd) || minutesToAdd < 1) return null;
  const norm = normalizeLocalScheduleInput(String(wallTimestamp).trim());
  if (!norm) return null;
  const parsed = parseLocalTimestamp(norm);
  if (!parsed) return null;
  const end = addMinutes(parsed, Math.floor(minutesToAdd));
  return formatInTimeZone(end, getScheduleTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

export function earlierWallTime(a: string | null | undefined, b: string | null | undefined): string | null {
  const sa = a?.trim();
  const sb = b?.trim();
  if (!sa && !sb) return null;
  if (!sa) return sb ?? null;
  if (!sb) return sa;
  const da = parseLocalTimestamp(sa);
  const db = parseLocalTimestamp(sb);
  if (!da) return sb;
  if (!db) return sa;
  return da.getTime() <= db.getTime() ? sa : sb;
}

export type PauseAnchorMode = "default" | "scheduled_activation" | "resume";

export function computePauseAtOnStart(
  campaign: {
    scheduledAt: string | null;
    pauseAt: string | null;
    autoPauseAfterMinutes: number | null;
  },
  anchorMode: PauseAnchorMode = "default"
): string | null {
  const userPause = campaign.pauseAt ? normalizeLocalScheduleInput(String(campaign.pauseAt)) : null;
  const ap = campaign.autoPauseAfterMinutes;
  let fromDuration: string | null = null;
  if (ap != null && ap > 0 && Number.isFinite(ap)) {
    let anchor: string | null = null;
    if (anchorMode === "resume") {
      anchor = getCurrentLocalTimestampString();
    } else if (anchorMode === "scheduled_activation") {
      anchor = campaign.scheduledAt
        ? normalizeLocalScheduleInput(String(campaign.scheduledAt))
        : getCurrentLocalTimestampString();
    } else {
      const useScheduleAnchor = Boolean(campaign.scheduledAt) && !isScheduledTimeReached(campaign.scheduledAt);
      anchor = useScheduleAnchor
        ? normalizeLocalScheduleInput(String(campaign.scheduledAt))
        : getCurrentLocalTimestampString();
    }
    if (anchor) {
      fromDuration = addMinutesToWallClock(anchor, Math.floor(ap));
    }
  }
  return earlierWallTime(userPause, fromDuration);
}

export function parseAutoPauseAfterMinutesBody(raw: unknown): { ok: true; val: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, val: null };
  }
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: "autoPauseAfterMinutes must be a positive integer" };
  }
  const m = Math.floor(n);
  if (m > 10080) {
    return { ok: false, error: "autoPauseAfterMinutes cannot exceed 10080 (7 days in minutes)" };
  }
  return { ok: true, val: m };
}
