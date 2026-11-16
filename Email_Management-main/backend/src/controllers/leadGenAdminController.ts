/**
 * Lead Engine admin monitor (use case UC-13) + data subject requests (UC-12) + public privacy endpoints.
 *   admin:  today's runs, failed/partial runs, queue, per-source success and block rates, common errors;
 *           source on/off, caps; privacy request queue; "refresh now".
 *   public: POST /lead-gen/privacy/requests (opt-out / erasure), GET /lead-gen/privacy/verify (email link).
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dbPool } from '../lib/db.js';
import { sendEmailViaEnv } from '../lib/smtp.js';
import { createSubjectRequest, processByAdmin, verifyAndProcess } from '../lib/leadgen/compliance.js';
import { startNightlyRefresh } from '../lib/leadgen/refresh.js';

export async function adminOverview(_req: Request, res: Response) {
  const [runs, queue, sources, errors, recent, master, dsr] = await Promise.all([
    dbPool.query(
      `SELECT status, count(*)::int AS n FROM scrape_runs WHERE created_at >= date_trunc('day', now()) GROUP BY status`),
    dbPool.query(
      `SELECT task_type, status, count(*)::int AS n FROM scrape_tasks WHERE status IN ('pending', 'running') GROUP BY task_type, status ORDER BY task_type`),
    dbPool.query(
      `SELECT s.id, s.code, s.type, s.is_enabled, s.rate_per_min, s.daily_cap, s.cooldown_until, s.notes,
              COALESCE(u.requests_used, 0) AS requests_today, COALESCE(u.blocked_count, 0) AS blocked_today,
              (SELECT count(*)::int FROM scrape_tasks t WHERE t.source_id = s.id AND t.completed_at >= now() - interval '1 day' AND t.status = 'done') AS tasks_done,
              (SELECT count(*)::int FROM scrape_tasks t WHERE t.source_id = s.id AND t.completed_at >= now() - interval '1 day' AND t.status IN ('failed', 'skipped')) AS tasks_failed
         FROM sources s LEFT JOIN source_daily_usage u ON u.source_id = s.id AND u.day = current_date ORDER BY s.id`),
    dbPool.query(
      `SELECT left(last_error, 120) AS error, count(*)::int AS n FROM scrape_tasks
        WHERE last_error IS NOT NULL AND COALESCE(completed_at, next_attempt_at) >= now() - interval '1 day'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
    dbPool.query(
      `SELECT r.id, r.user_id, u.email AS user_email, r.run_type, r.status, r.stats, r.error, r.created_at, r.started_at, r.completed_at, ss.name AS search_name
         FROM scrape_runs r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN saved_searches ss ON ss.id = r.saved_search_id
        ORDER BY r.created_at DESC LIMIT 50`),
    dbPool.query(
      `SELECT (SELECT count(*)::int FROM companies WHERE deleted_at IS NULL) AS companies,
              (SELECT count(*)::int FROM people WHERE deleted_at IS NULL) AS people,
              (SELECT count(*)::int FROM workspace_leads) AS workspace_leads,
              (SELECT count(*)::int FROM entity_merges) AS merges`),
    dbPool.query(`SELECT status, count(*)::int AS n FROM data_subject_requests GROUP BY status`),
  ]);
  res.json({
    runsToday: Object.fromEntries(runs.rows.map((r) => [r.status, r.n])),
    queue: queue.rows,
    sources: sources.rows.map((s) => ({
      ...s,
      blockRate: s.requests_today > 0 ? Math.round((s.blocked_today / s.requests_today) * 1000) / 10 : 0,
      successRate: s.tasks_done + s.tasks_failed > 0 ? Math.round((s.tasks_done / (s.tasks_done + s.tasks_failed)) * 1000) / 10 : null,
    })),
    commonErrors: errors.rows,
    recentRuns: recent.rows,
    masterData: master.rows[0],
    privacyRequests: Object.fromEntries(dsr.rows.map((r) => [r.status, r.n])),
  });
}

const SourcePatch = z.object({
  isEnabled: z.boolean().optional(),
  ratePerMin: z.number().int().min(1).max(10_000).nullable().optional(),
  dailyCap: z.number().int().min(1).max(10_000_000).nullable().optional(),
  clearCooldown: z.boolean().optional(),
});

export async function adminUpdateSource(req: Request, res: Response) {
  const parsed = SourcePatch.safeParse(req.body);
  const sourceId = Number(req.params.id);
  if (!parsed.success || !Number.isInteger(sourceId)) return res.status(400).json({ error: 'Invalid source change' });
  const b = parsed.data;
  const r = await dbPool.query(
    `UPDATE sources SET is_enabled = COALESCE($2, is_enabled),
            rate_per_min = CASE WHEN $3::boolean THEN $4 ELSE rate_per_min END,
            daily_cap = CASE WHEN $5::boolean THEN $6 ELSE daily_cap END,
            cooldown_until = CASE WHEN $7 THEN NULL ELSE cooldown_until END
      WHERE id = $1 RETURNING *`,
    [sourceId, b.isEnabled ?? null, b.ratePerMin !== undefined, b.ratePerMin ?? null, b.dailyCap !== undefined, b.dailyCap ?? null, b.clearCooldown === true]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ source: r.rows[0] });
}

export async function adminRefreshNow(_req: Request, res: Response) {
  const runId = await startNightlyRefresh(new Date(), { force: true });
  res.json({ runId, message: runId ? 'Refresh run started.' : "Tonight's refresh run already exists." });
}

export async function adminListPrivacy(_req: Request, res: Response) {
  const r = await dbPool.query(
    `SELECT id, request_type, identifier_type, status, received_at, verified_at, processed_at,
            (received_at < now() - interval '25 days' AND status NOT IN ('done', 'rejected')) AS due_soon
       FROM data_subject_requests ORDER BY received_at DESC LIMIT 200`
  );
  res.json({ requests: r.rows });
}

/** The admin checked the identity by hand and gives the identifier again (only its hash is stored). */
export async function adminProcessPrivacy(req: Request, res: Response) {
  const parsed = z.object({ identifier: z.string().trim().min(3).max(500), reject: z.boolean().optional() }).safeParse(req.body);
  const requestId = Number(req.params.id);
  if (!parsed.success || !Number.isInteger(requestId)) return res.status(400).json({ error: 'Give the identifier of the request' });
  if (parsed.data.reject) {
    await dbPool.query(`UPDATE data_subject_requests SET status = 'rejected', processed_at = now() WHERE id = $1 AND status <> 'done'`, [requestId]);
    return res.json({ ok: true, status: 'rejected' });
  }
  const result = await processByAdmin(requestId, parsed.data.identifier);
  if (!result) return res.status(409).json({ error: 'The identifier does not match this request, or it is already closed.' });
  res.json({ ok: true, status: 'done', erased: result });
}

// ── Public (no login) ────────────────────────────────────────────────────────

const PrivacyRequestSchema = z
  .object({
    type: z.enum(['opt_out', 'erasure']).default('erasure'),
    email: z.string().trim().email().max(254).optional(),
    linkedinUrl: z.string().trim().max(500).optional(),
    domain: z.string().trim().max(255).optional(),
  })
  .refine((v) => [v.email, v.linkedinUrl, v.domain].filter(Boolean).length === 1, { message: 'Give exactly one of email, linkedinUrl or domain' });

const recentByIp = new Map<string, number[]>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const hits = (recentByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  hits.push(now);
  recentByIp.set(ip, hits);
  if (recentByIp.size > 10_000) recentByIp.clear();
  return hits.length > 5;
}

/** Sends the confirmation email. Replaced in tests (they must never send real email). */
let privacyMailer: typeof sendEmailViaEnv = sendEmailViaEnv;
export function setPrivacyMailerForTests(fn: typeof sendEmailViaEnv): void {
  privacyMailer = fn;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function publicPrivacyRequest(req: Request, res: Response) {
  if (tooMany(req.ip ?? 'unknown')) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  const parsed = PrivacyRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
  const b = parsed.data;
  const [identifierType, identifier] = b.email ? (['email', b.email] as const) : b.linkedinUrl ? (['linkedin_url', b.linkedinUrl] as const) : (['domain', b.domain!] as const);
  const created = await createSubjectRequest(b.type, identifierType, identifier);
  if (!created) return res.status(400).json({ error: `That ${identifierType.replace('_', ' ')} is not valid.` });
  if (created.token && b.email) {
    const base = (process.env.PUBLIC_API_URL || process.env.TRACKING_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const link = `${base}/api/lead-gen/privacy/verify?id=${created.id}&token=${encodeURIComponent(created.token)}&email=${encodeURIComponent(b.email)}`;
    await privacyMailer({
      to: b.email,
      subject: 'Confirm your data removal request',
      html: `<p>We received a request to remove the business contact data we hold for <b>${escapeHtml(b.email)}</b>.</p>
             <p><a href="${link}">Confirm and remove my data</a></p><p>If you did not ask for this, ignore this email.</p>`,
      text: `Confirm and remove your data: ${link}`,
      fromName: 'MailFlow Privacy',
    }).catch((err) => console.error('[LeadGen] privacy confirmation email failed:', err instanceof Error ? err.message : err));
  }
  res.status(202).json({
    id: created.id,
    message: created.needsAdmin
      ? 'Request received. Our team will check it and answer within 30 days.'
      : 'Request received. Please open the confirmation link we sent to that email.',
  });
}

export async function publicPrivacyVerify(req: Request, res: Response) {
  const requestId = Number(req.query.id);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const email = typeof req.query.email === 'string' ? req.query.email : '';
  const result = Number.isInteger(requestId) && token && email ? await verifyAndProcess(requestId, token, email) : null;
  res.status(result ? 200 : 400).type('html').send(
    result
      ? '<!doctype html><meta charset="utf-8"><title>Done</title><p style="font-family:sans-serif">Your data was removed and will not be collected again.</p>'
      : '<!doctype html><meta charset="utf-8"><title>Link not valid</title><p style="font-family:sans-serif">This link is not valid or was already used.</p>'
  );
}
