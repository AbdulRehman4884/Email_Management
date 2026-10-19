/**
 * CRM step 6: "needs reply" APIs. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   GET  /crm/settings                       reminder settings (hours, daily email)
 *   PUT  /crm/settings {needsReplyAfterHours?, reminderEmailDigest?}
 *   GET  /crm/needs-reply?includeSnoozed=1   leads waiting for your reply (Inbox tab)
 *   POST /crm/contacts/:id/snooze {until}    hide until a time (ISO date)
 *   POST /crm/contacts/:id/needs-reply/done  "Mark as done"
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';
import {
  DEFAULT_NEEDS_REPLY_HOURS,
  MAX_NEEDS_REPLY_HOURS,
  MAX_SNOOZE_DAYS,
  MIN_NEEDS_REPLY_HOURS,
  listWaitingLeads,
  markReplied,
  snoozeNeedsReply,
} from '../lib/crm/needsReply.js';
import { listSmtpProfilesForUser } from '../lib/smtpSettings.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function idParam(req: Request, name: string): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[crm needs-reply]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

export const DIGEST_HOUR = Math.min(23, Math.max(0, Number(process.env.CRM_DIGEST_HOUR ?? 8) || 0));

async function ownContact(userId: number, contactId: number) {
  const r = await dbPool.query<{ id: number; needs_reply: boolean }>(
    `SELECT id, needs_reply FROM crm_contacts WHERE id = $1 AND user_id = $2`,
    [contactId, userId]
  );
  if (!r.rows[0]) throw new HttpError(404, 'Lead not found');
  return r.rows[0];
}

async function readSettings(userId: number) {
  await dbPool.query(`INSERT INTO crm_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const r = await dbPool.query<{ needs_reply_after_hours: number; reminder_email_digest: boolean; last_digest_sent_at: string | null }>(
    `SELECT needs_reply_after_hours, reminder_email_digest, last_digest_sent_at FROM crm_settings WHERE user_id = $1`,
    [userId]
  );
  const s = r.rows[0];
  const profiles = await listSmtpProfilesForUser(userId).catch(() => []);
  return {
    needsReplyAfterHours: s?.needs_reply_after_hours ?? DEFAULT_NEEDS_REPLY_HOURS,
    reminderEmailDigest: s?.reminder_email_digest ?? false,
    lastDigestSentAt: s?.last_digest_sent_at ?? null,
    digestHour: DIGEST_HOUR,
    smtpConfigured: profiles.length > 0,
    limits: { minHours: MIN_NEEDS_REPLY_HOURS, maxHours: MAX_NEEDS_REPLY_HOURS },
  };
}

/** GET /crm/settings */
export const getCrmSettings = handle(async (req, res) => {
  res.json(await readSettings(userIdOf(req)));
});

/** PUT /crm/settings {needsReplyAfterHours?, reminderEmailDigest?} */
export const saveCrmSettings = handle(async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  let hours: number | null = null;
  if (has('needsReplyAfterHours')) {
    hours = Number(body.needsReplyAfterHours);
    if (!Number.isInteger(hours) || hours < MIN_NEEDS_REPLY_HOURS || hours > MAX_NEEDS_REPLY_HOURS) {
      throw new HttpError(400, `Hours must be a whole number from ${MIN_NEEDS_REPLY_HOURS} to ${MAX_NEEDS_REPLY_HOURS}`);
    }
  }
  let digest: boolean | null = null;
  if (has('reminderEmailDigest')) {
    if (typeof body.reminderEmailDigest !== 'boolean') throw new HttpError(400, 'reminderEmailDigest must be true or false');
    digest = body.reminderEmailDigest;
  }
  await dbPool.query(
    `INSERT INTO crm_settings (user_id, needs_reply_after_hours, reminder_email_digest)
     VALUES ($1, COALESCE($2::int, ${DEFAULT_NEEDS_REPLY_HOURS}), COALESCE($3::boolean, false))
     ON CONFLICT (user_id) DO UPDATE
       SET needs_reply_after_hours = COALESCE($2::int, crm_settings.needs_reply_after_hours),
           reminder_email_digest = COALESCE($3::boolean, crm_settings.reminder_email_digest),
           updated_at = now()`,
    [userId, hours, digest]
  );
  res.json(await readSettings(userId));
});

/** GET /crm/needs-reply?includeSnoozed=1 */
export const listNeedsReply = handle(async (req, res) => {
  const userId = userIdOf(req);
  const includeSnoozed = req.query.includeSnoozed === '1' || req.query.includeSnoozed === 'true';
  res.json(await listWaitingLeads(userId, { includeSnoozed }));
});

/** POST /crm/contacts/:id/snooze {until: ISO date} */
export const snoozeContact = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = idParam(req, 'id');
  await ownContact(userId, contactId);
  const until = new Date(String(req.body?.until ?? ''));
  const now = Date.now();
  if (Number.isNaN(until.getTime()) || until.getTime() <= now + 30_000) throw new HttpError(400, 'Pick a time in the future');
  if (until.getTime() > now + MAX_SNOOZE_DAYS * 86_400_000) throw new HttpError(400, `You can snooze for at most ${MAX_SNOOZE_DAYS} days`);
  await snoozeNeedsReply(dbPool, contactId, until);
  res.json({ ok: true, snoozedUntil: until.toISOString() });
});

/** POST /crm/contacts/:id/needs-reply/done */
export const markContactDone = handle(async (req, res) => {
  const userId = userIdOf(req);
  const contactId = idParam(req, 'id');
  await ownContact(userId, contactId);
  await markReplied(dbPool, contactId);
  res.json({ ok: true });
});
