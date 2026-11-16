import { sql } from 'drizzle-orm';
import { recipientTable } from '../db/schema';

/**
 * F-20: when a recipient was really sent, as ISO UTC ("2026-10-15T21:28:00Z").
 * recipients.sent_at is a DATE column, so the time (and in PKT often the day) is lost; sent_ts has it.
 * Falls back to the plain date for rows sent before sent_ts existed.
 */
export const recipientSentAtIso = () =>
  sql<string | null>`coalesce(to_char(${recipientTable.sentTs} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ${recipientTable.sentAt}::text)`;
