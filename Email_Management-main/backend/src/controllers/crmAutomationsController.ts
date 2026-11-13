/**
 * Lead automations. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   GET    /crm/automation-templates                 ready-made automations (key, name, description, one line per step)
 *   GET    /crm/automations                          the user's automations with the forms that use them and lead counts
 *   POST   /crm/automations                          new automation (starts off); { templateKey } starts from a template
 *   GET    /crm/automations/:id                      one automation
 *   PATCH  /crm/automations/:id                      name, on/off, email account, steps
 *   DELETE /crm/automations/:id                      also deletes its run history; forms that used it get no automation
 *   GET    /crm/automations/:id/runs                 leads in it (?status=open|completed|stopped, ?limit, ?offset)
 *   GET    /crm/automation-calls                     leads waiting for a call result (all automations)
 *   GET    /crm/automation-runs/:runId/events        what happened to one lead
 *   POST   /crm/automation-runs/:runId/call-result   { result: interested | no_answer | not_interested }
 *   POST   /crm/automation-runs/:runId/stop          stop one lead
 *   POST   /crm/automation-runs/:runId/send-now      a waiting lead skips its wait (its next step runs now)
 *   GET    /crm/campaigns/:id/automation             the campaign's automation and whether it can still change
 *   PUT    /crm/campaigns/:id/automation             { automationId | null } while the campaign is a draft or scheduled
 *   POST   /crm/automation-ai/write                  "Write with AI": one follow-up email (nothing is saved or sent)
 *
 * Every query is limited to the logged-in user's own rows. Email account, tags and stages must be the user's.
 * Answers 503 until migrations 0040 and 0041 are applied.
 * A campaign has one automation (kind 'campaign'); it is locked once the campaign has started.
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';
import { allSteps, CALL_RESULTS, kindOf, storedSteps, validateAutomationInput, type CallResult, type CleanAutomation } from '../lib/crm/automationSteps.js';
import { applyCallResult, automationTablesReady, sendNow, stopRunByUser } from '../lib/crm/automations.js';
import { AUTOMATION_TEMPLATES, findTemplate, templateOutline, templateSteps, type StageLookup } from '../lib/crm/automationTemplates.js';
import { writeFollowUpWithAi } from '../lib/crm/automationAi.js';
import { htmlToPlainText } from '../lib/htmlToPlainText.js';

const MAX_AUTOMATIONS = 50;
const OPEN = `('active', 'running', 'waiting_call')`;

class HttpError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message);
  }
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function intParam(req: Request, name: string, label: string): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${label} id`);
  return n;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      if (!(await automationTablesReady())) {
        throw new HttpError(503, 'Automations are not set up yet. Run the automation migration first (npx tsx scripts/run-automation-migration.ts).');
      }
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, ...(err.details.length ? { errors: err.details } : {}) });
        return;
      }
      console.error('[crm automations]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

type AutomationRow = {
  id: number;
  name: string;
  kind: string;
  is_active: boolean;
  smtp_settings_id: number | null;
  steps: unknown;
  created_at: string;
  updated_at: string;
};

const toClean = (a: AutomationRow): CleanAutomation => ({
  name: a.name,
  kind: kindOf(a.kind),
  isActive: a.is_active,
  smtpSettingsId: a.smtp_settings_id,
  steps: storedSteps(a.steps, kindOf(a.kind)),
});

type Counts = { running: number; waitingCall: number; completed: number; stopped: number };

/** Forms and campaigns that use each automation, and how many leads are in each state. */
async function extras(userId: number, ids: number[]) {
  const usedBy = new Map<number, Array<{ id: number; name: string }>>();
  const usedByCampaigns = new Map<number, Array<{ id: number; name: string; status: string }>>();
  const counts = new Map<number, Counts>();
  if (ids.length === 0) return { usedBy, usedByCampaigns, counts };
  const [forms, runs, campaigns] = await Promise.all([
    dbPool.query<{ id: number; name: string; automation_id: number }>(
      `SELECT id, name, automation_id FROM crm_forms WHERE user_id = $1 AND automation_id = ANY($2::int[]) ORDER BY name`,
      [userId, ids]
    ),
    dbPool.query<{ automation_id: number; status: string; n: number }>(
      `SELECT automation_id, status, count(*)::int AS n FROM crm_automation_runs
        WHERE user_id = $1 AND automation_id = ANY($2::int[]) GROUP BY automation_id, status`,
      [userId, ids]
    ),
    dbPool.query<{ id: number; name: string; status: string; automation_id: number }>(
      `SELECT c.id, c.name, c.status, ca.automation_id FROM crm_campaign_automations ca JOIN campaigns c ON c.id = ca.campaign_id
        WHERE ca.user_id = $1 AND ca.automation_id = ANY($2::int[]) ORDER BY c.name`,
      [userId, ids]
    ),
  ]);
  for (const c of campaigns.rows) {
    usedByCampaigns.set(c.automation_id, [...(usedByCampaigns.get(c.automation_id) ?? []), { id: c.id, name: c.name, status: c.status }]);
  }
  for (const f of forms.rows) usedBy.set(f.automation_id, [...(usedBy.get(f.automation_id) ?? []), { id: f.id, name: f.name }]);
  for (const r of runs.rows) {
    const c = counts.get(r.automation_id) ?? { running: 0, waitingCall: 0, completed: 0, stopped: 0 };
    if (r.status === 'active' || r.status === 'running') c.running += r.n;
    else if (r.status === 'waiting_call') c.waitingCall += r.n;
    else if (r.status === 'completed') c.completed += r.n;
    else if (r.status === 'stopped') c.stopped += r.n;
    counts.set(r.automation_id, c);
  }
  return { usedBy, usedByCampaigns, counts };
}

function automationOut(a: AutomationRow, x: Awaited<ReturnType<typeof extras>>) {
  return {
    id: a.id,
    ...toClean(a),
    usedBy: x.usedBy.get(a.id) ?? [],
    usedByCampaigns: x.usedByCampaigns.get(a.id) ?? [],
    counts: x.counts.get(a.id) ?? { running: 0, waitingCall: 0, completed: 0, stopped: 0 },
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

const SELECT = `SELECT id, name, kind, is_active, smtp_settings_id, steps, created_at, updated_at FROM crm_automations`;

async function readAutomation(userId: number, id: number): Promise<AutomationRow> {
  const r = await dbPool.query<AutomationRow>(`${SELECT} WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Automation not found');
  return r.rows[0];
}

async function sendOne(res: Response, userId: number, id: number, status = 200) {
  const a = await readAutomation(userId, id);
  res.status(status).json({ automation: automationOut(a, await extras(userId, [id])) });
}

/** Email account, tags and stages used by the steps must be the user's own. */
async function checkOwnership(userId: number, a: CleanAutomation): Promise<void> {
  const errors: string[] = [];
  if (a.smtpSettingsId != null) {
    const s = await dbPool.query(`SELECT 1 FROM smtp_settings WHERE id = $1 AND user_id = $2`, [a.smtpSettingsId, userId]);
    if (!s.rowCount) errors.push('Email account: pick one of your email accounts');
  }
  const steps = allSteps(a.steps);
  const tagIds = [...new Set(steps.flatMap((s) => (s.type === 'tag' ? [s.tagId] : [])))];
  if (tagIds.length) {
    const t = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_tags WHERE id = ANY($1::int[]) AND user_id = $2`, [tagIds, userId]);
    if (t.rows[0]?.n !== tagIds.length) errors.push('Tag: pick your own tags');
  }
  const stageIds = [...new Set(steps.flatMap((s) => (s.type === 'stage' ? [s.stageId] : [])))];
  if (stageIds.length) {
    const s = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_pipeline_stages WHERE id = ANY($1::int[]) AND user_id = $2`, [stageIds, userId]);
    if (s.rows[0]?.n !== stageIds.length) errors.push('Stage: pick a stage of your own pipelines');
  }
  if (errors.length) throw new HttpError(400, errors[0]!, errors);
}

/** GET /crm/automations */
export const listAutomations = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<AutomationRow>(`${SELECT} WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId]);
  const x = await extras(userId, r.rows.map((a) => a.id));
  res.json({ automations: r.rows.map((a) => automationOut(a, x)) });
});

/** GET /crm/automations/:id */
export const getAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  await sendOne(res, userId, intParam(req, 'id', 'automation'));
});

/** GET /crm/automation-templates */
export const listAutomationTemplates = handle(async (_req, res) => {
  res.json({
    templates: AUTOMATION_TEMPLATES.map((t) => ({ key: t.key, kind: t.kind, name: t.name, description: t.description, outline: templateOutline(t) })),
  });
});

/** Stages of the user's default pipeline (read only; nothing is created). */
async function defaultPipelineStages(userId: number): Promise<StageLookup> {
  const r = await dbPool.query<{ id: number; name: string; type: string }>(
    `SELECT s.id, s.name, s.type FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
      WHERE p.user_id = $1 AND p.is_default ORDER BY s.position, s.id`,
    [userId]
  );
  return r.rows;
}

/** POST /crm/automations — a new automation is off until the user turns it on. */
export const createAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  let body = (req.body ?? {}) as Record<string, unknown>;
  if (body.templateKey != null && body.templateKey !== '') {
    const t = findTemplate(body.templateKey);
    if (!t) throw new HttpError(400, 'Template not found');
    const { templateKey: _key, ...rest } = body;
    body = { name: t.name, ...rest, kind: t.kind, steps: templateSteps(t, await defaultPipelineStages(userId)) };
  }
  const v = validateAutomationInput({ isActive: false, steps: [], ...body });
  if (!v.ok) throw new HttpError(400, v.errors[0]!, v.errors);
  await checkOwnership(userId, v.value);
  const count = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_automations WHERE user_id = $1`, [userId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_AUTOMATIONS) throw new HttpError(400, `At most ${MAX_AUTOMATIONS} automations`);
  const r = await dbPool.query<{ id: number }>(
    `INSERT INTO crm_automations (user_id, name, kind, is_active, smtp_settings_id, steps) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [userId, v.value.name, v.value.kind, v.value.isActive, v.value.smtpSettingsId, JSON.stringify(v.value.steps)]
  );
  await sendOne(res, userId, r.rows[0]!.id, 201);
});

/** PATCH /crm/automations/:id */
export const updateAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = intParam(req, 'id', 'automation');
  const current = await readAutomation(userId, id);
  const v = validateAutomationInput((req.body ?? {}) as Record<string, unknown>, toClean(current));
  if (!v.ok) throw new HttpError(400, v.errors[0]!, v.errors);
  await checkOwnership(userId, v.value);
  await dbPool.query(
    `UPDATE crm_automations SET name = $3, is_active = $4, smtp_settings_id = $5, steps = $6::jsonb, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, v.value.name, v.value.isActive, v.value.smtpSettingsId, JSON.stringify(v.value.steps)]
  );
  await sendOne(res, userId, id);
});

/** DELETE /crm/automations/:id — forms and campaigns that used it keep working, without an automation. */
export const deleteAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query(`DELETE FROM crm_automations WHERE id = $1 AND user_id = $2`, [intParam(req, 'id', 'automation'), userId]);
  if (!r.rowCount) throw new HttpError(404, 'Automation not found');
  res.json({ ok: true });
});

type RunListRow = {
  id: number;
  contact_id: number | null;
  email: string;
  name: string | null;
  form_name: string | null;
  campaign_id: number | null;
  campaign_name: string | null;
  status: string;
  step_index: number;
  branch: CallResult | null;
  branch_index: number;
  call_attempts: number;
  emails_sent: number;
  next_run_at: string | null;
  stop_reason: string | null;
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
};

const runOut = (r: RunListRow) => ({
  id: r.id,
  contactId: r.contact_id,
  email: r.email,
  name: r.name,
  formName: r.form_name,
  campaignId: r.campaign_id,
  campaignName: r.campaign_name,
  status: r.status === 'running' ? 'active' : r.status,
  stepIndex: r.step_index,
  branch: r.branch,
  branchIndex: r.branch_index,
  callAttempts: r.call_attempts,
  emailsSent: r.emails_sent,
  nextRunAt: r.next_run_at,
  stopReason: r.stop_reason,
  lastError: r.last_error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/** GET /crm/automations/:id/runs */
export const listAutomationRuns = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = intParam(req, 'id', 'automation');
  await readAutomation(userId, id);
  const status = String(req.query.status ?? '');
  const filter =
    status === 'open' ? `AND r.status IN ${OPEN}`
      : status === 'completed' ? `AND r.status = 'completed'`
        : status === 'stopped' ? `AND r.status = 'stopped'`
          : '';
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const [rows, total] = await Promise.all([
    dbPool.query<RunListRow>(
      `SELECT r.id,
              COALESCE(r.contact_id, (SELECT ccr.contact_id FROM crm_contact_recipients ccr WHERE ccr.recipient_id = r.recipient_id)) AS contact_id,
              COALESCE(cc.email, rec.email) AS email, COALESCE(cc.name, rec.name) AS name, f.name AS form_name,
              r.campaign_id, c.name AS campaign_name, r.status, r.step_index, r.branch, r.branch_index,
              r.call_attempts, r.emails_sent, r.next_run_at, r.stop_reason, r.last_error, r.started_at, r.finished_at
         FROM crm_automation_runs r
         LEFT JOIN crm_contacts cc ON cc.id = r.contact_id
         LEFT JOIN recipients rec ON rec.id = r.recipient_id
         LEFT JOIN campaigns c ON c.id = r.campaign_id
         LEFT JOIN crm_forms f ON f.id = r.form_id
        WHERE r.automation_id = $1 AND r.user_id = $2 ${filter}
        ORDER BY (r.status IN ${OPEN}) DESC, r.updated_at DESC, r.id DESC
        LIMIT $3 OFFSET $4`,
      [id, userId, limit, offset]
    ),
    dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_automation_runs r WHERE r.automation_id = $1 AND r.user_id = $2 ${filter}`, [id, userId]),
  ]);
  res.json({ runs: rows.rows.map(runOut), total: total.rows[0]?.n ?? 0, limit, offset });
});

/** GET /crm/automation-calls — every lead waiting for the user's call result, oldest first. */
export const listCallsToMake = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<{
    id: number; contact_id: number; email: string; name: string | null; phone: string | null; automation_id: number;
    automation_name: string; steps: unknown; step_index: number; call_attempts: number; since: string;
  }>(
    `SELECT r.id, r.contact_id, cc.email, cc.name,
            CASE WHEN jsonb_typeof(cc.custom_fields) = 'object' THEN cc.custom_fields->>'phone' END AS phone,
            r.automation_id, a.name AS automation_name, a.steps, r.step_index, r.call_attempts, r.updated_at AS since
       FROM crm_automation_runs r
       JOIN crm_automations a ON a.id = r.automation_id
       JOIN crm_contacts cc ON cc.id = r.contact_id
      WHERE r.user_id = $1 AND r.status = 'waiting_call'
      ORDER BY r.updated_at ASC
      LIMIT 200`,
    [userId]
  );
  res.json({
    calls: r.rows.map((c) => {
      const step = storedSteps(c.steps)[c.step_index];
      return {
        runId: c.id,
        contactId: c.contact_id,
        email: c.email,
        name: c.name,
        phone: c.phone,
        automationId: c.automation_id,
        automationName: c.automation_name,
        message: step?.type === 'call' ? step.message : '',
        attempt: c.call_attempts,
        since: c.since,
      };
    }),
  });
});

/** GET /crm/automation-runs/:runId/events */
export const listRunEvents = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<{ kind: string; detail: string | null; created_at: string }>(
    `SELECT kind, detail, created_at FROM crm_automation_events WHERE run_id = $1 AND user_id = $2 ORDER BY id ASC LIMIT 300`,
    [intParam(req, 'runId', 'run'), userId]
  );
  res.json({ events: r.rows.map((e) => ({ kind: e.kind, detail: e.detail, at: e.created_at })) });
});

/** POST /crm/automation-runs/:runId/call-result */
export const postCallResult = handle(async (req, res) => {
  const userId = userIdOf(req);
  const result = String((req.body as Record<string, unknown> | undefined)?.result ?? '') as CallResult;
  if (!CALL_RESULTS.includes(result)) throw new HttpError(400, 'Result: Interested, No answer or Not interested');
  const r = await applyCallResult(userId, intParam(req, 'runId', 'run'), result);
  if (!r.ok) throw new HttpError(r.status, r.error);
  res.json({ ok: true, message: r.message });
});

/** POST /crm/automation-runs/:runId/stop */
export const postStopRun = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await stopRunByUser(userId, intParam(req, 'runId', 'run'));
  if (!r.ok) throw new HttpError(r.status, r.error);
  res.json({ ok: true, message: r.message });
});

/** POST /crm/automation-runs/:runId/send-now */
export const postSendNow = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await sendNow(userId, intParam(req, 'runId', 'run'));
  if (!r.ok) throw new HttpError(r.status, r.error);
  res.json({ ok: true, message: r.message });
});

/** A campaign's automation can be picked, changed or removed only before the campaign starts. */
const CAMPAIGN_EDITABLE = ['draft', 'scheduled'];

async function campaignAutomationOut(userId: number, campaignId: number) {
  const r = await dbPool.query<{ status: string; automation_id: number | null; automation_name: string | null; automation_active: boolean | null }>(
    `SELECT c.status, ca.automation_id, a.name AS automation_name, a.is_active AS automation_active
       FROM campaigns c
       LEFT JOIN crm_campaign_automations ca ON ca.campaign_id = c.id
       LEFT JOIN crm_automations a ON a.id = ca.automation_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [campaignId, userId]
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'Campaign not found');
  return {
    campaignId,
    campaignStatus: row.status,
    automationId: row.automation_id,
    automationName: row.automation_name,
    automationActive: row.automation_active,
    /** False once the campaign has started: the automation is locked. */
    canChange: CAMPAIGN_EDITABLE.includes(row.status),
  };
}

/** GET /crm/campaigns/:id/automation */
export const getCampaignAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  res.json(await campaignAutomationOut(userId, intParam(req, 'id', 'campaign')));
});

/** PUT /crm/campaigns/:id/automation — { automationId: number | null }. One automation per campaign, locked after the start. */
export const setCampaignAutomation = handle(async (req, res) => {
  const userId = userIdOf(req);
  const campaignId = intParam(req, 'id', 'campaign');
  const raw = (req.body as Record<string, unknown> | undefined)?.automationId;
  const automationId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (automationId !== null && (!Number.isInteger(automationId) || automationId < 1)) throw new HttpError(400, 'Automation: invalid id');
  const current = await campaignAutomationOut(userId, campaignId);
  if (!current.canChange) {
    throw new HttpError(409, 'This campaign has started, so its automation can no longer be changed or removed.');
  }
  if (automationId === null) {
    await dbPool.query(`DELETE FROM crm_campaign_automations WHERE campaign_id = $1 AND user_id = $2`, [campaignId, userId]);
  } else {
    const a = await dbPool.query(`SELECT 1 FROM crm_automations WHERE id = $1 AND user_id = $2 AND kind = 'campaign'`, [automationId, userId]);
    if (!a.rowCount) throw new HttpError(400, 'Automation: pick one of your campaign automations');
    await dbPool.query(
      `INSERT INTO crm_campaign_automations (campaign_id, automation_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (campaign_id) DO UPDATE SET automation_id = EXCLUDED.automation_id, created_at = now()`,
      [campaignId, automationId, userId]
    );
  }
  res.json(await campaignAutomationOut(userId, campaignId));
});

/**
 * POST /crm/automation-ai/write — { automationId, followUpNumber?, previous?: string[], instruction?, context? }.
 * Campaign automations: the AI reads the first email of a campaign that uses the automation (or `context`).
 * Returns { subject, body } for the builder; nothing is saved or sent.
 */
export const postAiWrite = handle(async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const automationId = Number(body.automationId);
  if (!Number.isInteger(automationId) || automationId < 1) throw new HttpError(400, 'Invalid automation id');
  const automation = await readAutomation(userId, automationId);
  const kind = kindOf(automation.kind);
  let context = String(body.context ?? '').slice(0, 3000);
  if (kind === 'campaign' && !context.trim()) {
    const c = await dbPool.query<{ subject: string; email_content: string }>(
      `SELECT c.subject, c.email_content FROM crm_campaign_automations ca JOIN campaigns c ON c.id = ca.campaign_id
        WHERE ca.automation_id = $1 AND ca.user_id = $2 ORDER BY c.id DESC LIMIT 1`,
      [automationId, userId]
    );
    const first = c.rows[0];
    if (first) context = `Subject: ${first.subject}\n\n${htmlToPlainText(first.email_content ?? '')}`;
  }
  const followUpNumber = Math.min(20, Math.max(1, Math.floor(Number(body.followUpNumber) || 1)));
  const previous = Array.isArray(body.previous) ? body.previous.slice(0, 5).map((p) => String(p ?? '')) : [];
  const r = await writeFollowUpWithAi(userId, { kind, followUpNumber, context, previous, instruction: String(body.instruction ?? '') });
  if (!r.ok) throw new HttpError(r.status, r.error);
  res.json({ subject: r.subject, body: r.body });
});
