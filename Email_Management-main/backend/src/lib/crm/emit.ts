/**
 * Helpers for the places in the app that know a recipient (or an email), not a CRM contact.
 *
 *  - emitForRecipient(): fire-and-forget. Never throws and never slows down the caller
 *    (sending, open tracking, webhooks). Errors are logged.
 *  - emitForRecipientAsync(): same, but awaitable (workers and tests).
 *  - emitForEmail(): for unsubscribe links, which only know the email address.
 */
import { dbPool } from '../db.js';
import { ensureContactForRecipient } from './contacts.js';
import { emitCrmEvent, type CrmEventType } from './events.js';
import { runCrmInBackground } from './backgroundQueue.js';

export async function emitForRecipientAsync(
  recipientId: number,
  type: CrmEventType,
  data: Record<string, unknown> = {}
): Promise<void> {
  if (!Number.isInteger(recipientId) || recipientId < 1) return;
  try {
    const contact = await ensureContactForRecipient(recipientId);
    if (!contact) return;
    await emitCrmEvent(contact.userId, contact.contactId, { type, data: { recipientId, ...data } });
  } catch (err) {
    console.error(`[crm] ${type} for recipient ${recipientId} failed:`, err);
  }
}

export function emitForRecipient(recipientId: number, type: CrmEventType, data: Record<string, unknown> = {}): void {
  // Step 9: through the CRM queue (a few at a time), so bulk sends / IMAP polls are never slowed down.
  runCrmInBackground(`${type} recipient ${recipientId}`, () => emitForRecipientAsync(recipientId, type, data));
}

/** One event per user that has this email as a recipient (newest recipient row of each user). */
export async function emitForEmailAsync(email: string, type: CrmEventType, data: Record<string, unknown> = {}): Promise<void> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e.includes('@')) return;
  try {
    const rows = await dbPool.query<{ id: number; campaign_id: number }>(
      `SELECT DISTINCT ON (c.user_id) r.id, r.campaign_id
         FROM recipients r JOIN campaigns c ON c.id = r.campaign_id
        WHERE lower(r.email) = $1
        ORDER BY c.user_id, r.id DESC`,
      [e]
    );
    for (const r of rows.rows) {
      await emitForRecipientAsync(r.id, type, { campaignId: r.campaign_id, ...data });
    }
  } catch (err) {
    console.error(`[crm] ${type} for ${e} failed:`, err);
  }
}

export function emitForEmail(email: string, type: CrmEventType, data: Record<string, unknown> = {}): void {
  runCrmInBackground(`${type} email`, () => emitForEmailAsync(email, type, data));
}
