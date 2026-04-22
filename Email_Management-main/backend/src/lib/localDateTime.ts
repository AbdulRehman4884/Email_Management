const DATETIME_LOCAL_REGEX = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

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

export function getCurrentLocalTimestampString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * Parse a database timestamp string (stored as local time) into a Date object.
 * Handles formats like "2026-04-22 13:26:00" or "2026-04-22T13:26:00"
 */
export function parseLocalTimestamp(dbTimestamp: string | null | undefined): Date | null {
  if (!dbTimestamp) return null;
  
  const str = String(dbTimestamp).trim().replace('T', ' ').slice(0, 19);
  const match = DATETIME_LOCAL_REGEX.exec(str);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]) - 1; // JS months are 0-indexed
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  return new Date(year, month, day, hour, minute, second);
}

/**
 * Check if the scheduled time has arrived (or passed).
 * Returns true if scheduledAt is null OR if scheduledAt <= now.
 * Returns false if scheduledAt is still in the future.
 */
export function isScheduledTimeReached(scheduledAt: string | null | undefined): boolean {
  if (!scheduledAt) return true; // No schedule = ready immediately
  
  const scheduledDate = parseLocalTimestamp(scheduledAt);
  if (!scheduledDate) return true; // Invalid format = ready immediately
  
  const now = new Date();
  return scheduledDate.getTime() <= now.getTime();
}

export function isFutureLocalTimestamp(scheduledAt: string | null | undefined): boolean {
  if (!scheduledAt) return false;
  const scheduledDate = parseLocalTimestamp(scheduledAt);
  if (!scheduledDate) return false;
  return scheduledDate.getTime() > Date.now();
}
