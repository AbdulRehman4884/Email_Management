/**
 * src/lib/campaignScheduleForm.ts
 *
 * The sending schedule the user sets in the chat's schedule box (the same choices as the
 * campaign wizard's "When should this send?"): start, emails per day, days, hours, stop.
 * Every choice maps to an existing campaign field; the backend checks them again on save.
 */

import { z } from "zod";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Must be YYYY-MM-DDTHH:mm");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be HH:mm");

export const scheduleChoiceSchema = z
  .object({
    /** Browser wall clock; null = right away. */
    startAt: localDateTime.nullable(),
    /** null = as fast as the sending accounts allow. */
    dailyLimit: z.number().int().min(1).max(10000).nullable(),
    /** ISO weekdays 1 = Mon … 7 = Sun; null = every day. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable(),
    windowStart: hhmm.nullable(),
    windowEnd: hhmm.nullable(),
    /** Browser wall clock; null = no stop time. */
    stopAt: localDateTime.nullable(),
    /** Run this long, pause, resume and repeat; null = off. */
    stopAfterMinutes: z.number().int().min(1).max(10080).nullable(),
  })
  .strict()
  .refine((c) => (c.windowStart === null) === (c.windowEnd === null) && (c.windowStart === null || c.windowStart !== c.windowEnd), {
    message: "Set both sending hours (and make them different), or neither.",
  })
  .refine((c) => c.stopAt === null || c.stopAfterMinutes === null, { message: "Choose one way to stop." });

export type ScheduleChoice = z.infer<typeof scheduleChoiceSchema>;

/** The sender box's answer: one or more email accounts, and optionally only some of their aliases. */
export const senderChoiceSchema = z
  .object({
    smtpSettingIds: z.array(z.number().int().positive()).min(1).max(50),
    /** Empty = every active alias of the chosen accounts. */
    aliasIds: z.array(z.number().int().positive()).max(500),
  })
  .strict();

export type SenderChoice = z.infer<typeof senderChoiceSchema>;

/** Sent with the schedule question; the chat shows the schedule box under it. */
export interface ScheduleForm {
  kind: "schedule";
  recipientCount: number;
  smtpSettingsId?: number;
}

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function daysText(days: number[] | null): string {
  if (!days) return "every day";
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.join() === "1,2,3,4,5") return "weekdays (Mon–Fri)";
  if (d.join() === "6,7") return "weekends (Sat, Sun)";
  if (d.length === 7) return "every day";
  return d.map((n) => DAY[n]).join(", ");
}

function durationText(min: number): string {
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min} minute${min === 1 ? "" : "s"}`;
}

/** The summary lines shown before the user confirms the start. */
export function scheduleLines(c: ScheduleChoice, timeZone: string): string[] {
  const at = (local: string) => `**${local.replace("T", " ")}** (${timeZone})`;
  return [
    `- Start: ${c.startAt ? at(c.startAt) : "right away, as soon as you confirm"}`,
    `- Speed: ${c.dailyLimit ? `up to **${c.dailyLimit}** emails a day` : "as fast as your email account allows"}`,
    `- Days: ${daysText(c.weekdays)}`,
    `- Hours: ${c.windowStart && c.windowEnd ? `${c.windowStart}–${c.windowEnd}` : "any time of day"}`,
    `- Stops: ${
      c.stopAt
        ? `at ${at(c.stopAt)}`
        : c.stopAfterMinutes
          ? `pauses after ${durationText(c.stopAfterMinutes)}, then resumes and repeats until everyone is emailed`
          : "when everyone is emailed"
    }`,
  ];
}

/**
 * The update_campaign fields for a choice. `toIso` turns the user's wall clock into an instant.
 * Every field is sent (null turns a setting off), so a second try replaces the first one fully.
 */
export function scheduleUpdateArgs(
  c: ScheduleChoice,
  toIso: (local: string) => string | undefined,
  now = Date.now(),
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const startIso = c.startAt ? toIso(c.startAt.replace("T", " ")) : null;
  if (startIso === undefined) return { ok: false, error: "The start time is not a valid date and time." };
  if (startIso && new Date(startIso).getTime() <= now + 60_000) return { ok: false, error: "The start time has already passed. Please pick a time in the future." };
  const stopIso = c.stopAt ? toIso(c.stopAt.replace("T", " ")) : null;
  if (stopIso === undefined) return { ok: false, error: "The stop time is not a valid date and time." };
  if (stopIso && new Date(stopIso).getTime() <= now) return { ok: false, error: "The stop time has already passed. Please pick a time in the future." };
  if (stopIso && startIso && new Date(stopIso).getTime() <= new Date(startIso).getTime()) {
    return { ok: false, error: "The stop time must be after the start time." };
  }
  return {
    ok: true,
    args: {
      scheduledAt: startIso,
      pauseAt: stopIso,
      autoPauseAfterMinutes: c.stopAfterMinutes,
      dailySendLimit: c.dailyLimit,
      sendWeekdays: c.weekdays && c.weekdays.length < 7 ? [...new Set(c.weekdays)].sort((a, b) => a - b) : null,
      dailySendWindowStart: c.windowStart,
      dailySendWindowEnd: c.windowEnd,
    },
  };
}
