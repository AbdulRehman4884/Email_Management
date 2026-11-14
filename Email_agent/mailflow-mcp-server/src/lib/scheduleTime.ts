/**
 * src/lib/scheduleTime.ts
 *
 * The backend stores campaign schedules as wall-clock strings ("YYYY-MM-DD HH:mm:ss") in its
 * schedule timezone (DB_TIMEZONE / SCHEDULE_TZ, default Asia/Karachi) and rejects ISO strings
 * with an offset. The MCP schemas take ISO 8601 with an offset, so convert before sending.
 */

export function scheduleTimeZone(): string {
  const z = (process.env.SCHEDULE_TZ || process.env.DB_TIMEZONE || "Asia/Karachi").trim();
  return /^[A-Za-z0-9_/+:. -]+$/.test(z) ? z : "Asia/Karachi";
}

/** "2026-11-12T05:00:00Z" → "2026-11-12 10:00:00" (Asia/Karachi). Unparseable input is returned as is. */
export function toScheduleWallClock(iso: string, timeZone = scheduleTimeZone()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
