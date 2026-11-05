/**
 * Step 10: lead capture forms. Mounted in crmRouter at /api/crm (auth + crmEnabled plan check).
 *
 *   GET    /crm/forms                     the user's forms with views, submissions and conversion %
 *   POST   /crm/forms                     new form
 *   GET    /crm/forms/:id                 one form (the spam-check secret key is never sent back)
 *   PATCH  /crm/forms/:id                 change settings / fields / design, switch on or off
 *   DELETE /crm/forms/:id                 also deletes its submissions
 *   GET    /crm/forms/:id/submissions     newest first, paged (?limit, ?offset)
 *   GET    /crm/forms/:id/submissions/export   all submissions as CSV (?tz = the browser's time zone)
 *
 * Every query is limited to the logged-in user's own forms. Pipeline, stage, tags, email account
 * and campaign must belong to the user too.
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';
import { newPublicKey, publicBaseUrl } from '../lib/crm/webTracking.js';
import { DEFAULT_DESIGN, DEFAULT_FIELDS, validateFormInput, type Answer, type CleanForm, type FormRow } from '../lib/crm/forms.js';
import { csvCell, formatInZone, pgDate, validTimeZone } from './crmDashboardController.js';

const MAX_FORMS = 50;

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

function idParam(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid form id');
  return n;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, ...(err.details.length ? { errors: err.details } : {}) });
        return;
      }
      console.error('[crm forms]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

type FormListRow = FormRow & { view_count: number; submission_count: number; created_at: string; updated_at: string; last_submission_at: string | null };

function toClean(f: FormRow): CleanForm {
  return {
    name: f.name,
    isActive: f.is_active,
    title: f.title,
    description: f.description,
    fields: f.fields?.length ? f.fields : DEFAULT_FIELDS,
    design: { ...DEFAULT_DESIGN, ...(f.design ?? {}) },
    successMessage: f.success_message,
    consentEnabled: f.consent_enabled,
    consentText: f.consent_text,
    pipelineId: f.pipeline_id,
    stageId: f.stage_id,
    tagIds: f.tag_ids ?? [],
    thankYouEnabled: f.thank_you_enabled,
    thankYouSmtpSettingsId: f.thank_you_smtp_settings_id,
    thankYouSubject: f.thank_you_subject,
    thankYouBody: f.thank_you_body,
    notifyEnabled: f.notify_enabled,
    notifyEmail: f.notify_email,
    captchaProvider: f.captcha_provider,
    captchaSiteKey: f.captcha_site_key,
    captchaSecretKey: f.captcha_secret_key,
    addToCampaignId: f.add_to_campaign_id,
  };
}

function formOut(f: FormListRow, base: string) {
  const { captchaSecretKey, ...settings } = toClean(f);
  return {
    id: f.id,
    formKey: f.form_key,
    ...settings,
    captchaSecretKeySet: Boolean(captchaSecretKey),
    views: f.view_count,
    submissions: f.submission_count,
    /** Submissions ÷ views, in % (null before the first view). */
    conversion: f.view_count > 0 ? Math.round((f.submission_count / f.view_count) * 1000) / 10 : null,
    lastSubmissionAt: f.last_submission_at,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    urls: {
      script: `${base}/f.js`,
      hosted: `${base}/f/${f.form_key}`,
    },
  };
}

const FORM_SELECT = `
  SELECT f.*, (SELECT max(s.created_at) FROM crm_form_submissions s WHERE s.form_id = f.id) AS last_submission_at
    FROM crm_forms f`;

async function readForm(userId: number, id: number) {
  const r = await dbPool.query<FormListRow>(`${FORM_SELECT} WHERE f.id = $1 AND f.user_id = $2`, [id, userId]);
  if (!r.rows[0]) throw new HttpError(404, 'Form not found');
  return r.rows[0];
}

/** Pipeline, stage, tags, email account and campaign must be the user's own. */
async function checkOwnership(userId: number, f: CleanForm): Promise<void> {
  const errors: string[] = [];
  if (f.pipelineId != null) {
    const p = await dbPool.query(`SELECT 1 FROM crm_pipelines WHERE id = $1 AND user_id = $2`, [f.pipelineId, userId]);
    if (!p.rowCount) errors.push('Pipeline: pick one of your pipelines');
  }
  if (f.stageId != null) {
    const s = await dbPool.query(
      `SELECT 1 FROM crm_pipeline_stages WHERE id = $1 AND user_id = $2 AND ($3::int IS NULL OR pipeline_id = $3)`,
      [f.stageId, userId, f.pipelineId]
    );
    if (!s.rowCount) errors.push('Stage: pick a stage of the chosen pipeline');
  }
  if (f.tagIds.length) {
    const t = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_tags WHERE id = ANY($1::int[]) AND user_id = $2`, [f.tagIds, userId]);
    if (t.rows[0]?.n !== f.tagIds.length) errors.push('Tags: pick your own tags');
  }
  if (f.thankYouSmtpSettingsId != null) {
    const s = await dbPool.query(`SELECT 1 FROM smtp_settings WHERE id = $1 AND user_id = $2`, [f.thankYouSmtpSettingsId, userId]);
    if (!s.rowCount) errors.push('Thank-you email: pick one of your email accounts');
  }
  if (f.addToCampaignId != null) {
    const c = await dbPool.query(`SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2`, [f.addToCampaignId, userId]);
    if (!c.rowCount) errors.push('Campaign: pick one of your campaigns');
  }
  if (errors.length) throw new HttpError(400, errors[0]!, errors);
}

const COLUMNS: Array<[keyof CleanForm, string, string?]> = [
  ['name', 'name'],
  ['isActive', 'is_active'],
  ['title', 'title'],
  ['description', 'description'],
  ['fields', 'fields', 'jsonb'],
  ['design', 'design', 'jsonb'],
  ['successMessage', 'success_message'],
  ['consentEnabled', 'consent_enabled'],
  ['consentText', 'consent_text'],
  ['pipelineId', 'pipeline_id'],
  ['stageId', 'stage_id'],
  ['tagIds', 'tag_ids', 'int[]'],
  ['thankYouEnabled', 'thank_you_enabled'],
  ['thankYouSmtpSettingsId', 'thank_you_smtp_settings_id'],
  ['thankYouSubject', 'thank_you_subject'],
  ['thankYouBody', 'thank_you_body'],
  ['notifyEnabled', 'notify_enabled'],
  ['notifyEmail', 'notify_email'],
  ['captchaProvider', 'captcha_provider'],
  ['captchaSiteKey', 'captcha_site_key'],
  ['captchaSecretKey', 'captcha_secret_key'],
  ['addToCampaignId', 'add_to_campaign_id'],
];

const valueOf = (f: CleanForm, key: keyof CleanForm, cast?: string) => (cast === 'jsonb' ? JSON.stringify(f[key]) : f[key]);

/** GET /crm/forms */
export const listForms = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query<FormListRow>(`${FORM_SELECT} WHERE f.user_id = $1 ORDER BY f.created_at DESC, f.id DESC`, [userId]);
  const base = publicBaseUrl(req);
  res.json({ forms: r.rows.map((f) => formOut(f, base)) });
});

/** GET /crm/forms/:id */
export const getForm = handle(async (req, res) => {
  const userId = userIdOf(req);
  res.json({ form: formOut(await readForm(userId, idParam(req)), publicBaseUrl(req)) });
});

/** POST /crm/forms */
export const createForm = handle(async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const v = validateFormInput({ fields: DEFAULT_FIELDS, ...body });
  if (!v.ok) throw new HttpError(400, v.errors[0]!, v.errors);
  await checkOwnership(userId, v.value);
  const count = await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_forms WHERE user_id = $1`, [userId]);
  if ((count.rows[0]?.n ?? 0) >= MAX_FORMS) throw new HttpError(400, `At most ${MAX_FORMS} forms`);
  const cols = COLUMNS.map(([, c]) => c);
  const params = [userId, newPublicKey('FM'), ...COLUMNS.map(([k, , cast]) => valueOf(v.value, k, cast))];
  const placeholders = COLUMNS.map(([, , cast], i) => `$${i + 3}${cast ? `::${cast}` : ''}`);
  const r = await dbPool.query<{ id: number }>(
    `INSERT INTO crm_forms (user_id, form_key, ${cols.join(', ')}) VALUES ($1, $2, ${placeholders.join(', ')}) RETURNING id`,
    params
  );
  res.status(201).json({ form: formOut(await readForm(userId, r.rows[0]!.id), publicBaseUrl(req)) });
});

/** PATCH /crm/forms/:id */
export const updateForm = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = idParam(req);
  const current = await readForm(userId, id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  // An empty secret key field keeps the saved key (it is never sent to the browser).
  if (body.captchaSecretKey === '' || body.captchaSecretKey === null) delete body.captchaSecretKey;
  const v = validateFormInput(body, toClean(current));
  if (!v.ok) throw new HttpError(400, v.errors[0]!, v.errors);
  if (!v.value.captchaProvider) {
    v.value.captchaSiteKey = null;
    v.value.captchaSecretKey = null;
  }
  await checkOwnership(userId, v.value);
  const sets = COLUMNS.map(([, c, cast], i) => `${c} = $${i + 3}${cast ? `::${cast}` : ''}`);
  await dbPool.query(
    `UPDATE crm_forms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId, ...COLUMNS.map(([k, , cast]) => valueOf(v.value, k, cast))]
  );
  res.json({ form: formOut(await readForm(userId, id), publicBaseUrl(req)) });
});

/** DELETE /crm/forms/:id */
export const deleteForm = handle(async (req, res) => {
  const userId = userIdOf(req);
  const r = await dbPool.query(`DELETE FROM crm_forms WHERE id = $1 AND user_id = $2`, [idParam(req), userId]);
  if (!r.rowCount) throw new HttpError(404, 'Form not found');
  res.json({ ok: true });
});

/** GET /crm/forms/:id/submissions */
export const listSubmissions = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = idParam(req);
  await readForm(userId, id);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const [rows, total] = await Promise.all([
    dbPool.query<{ id: number; contact_id: number | null; email: string; answers: unknown; page_url: string | null; created_at: string; created_contact: boolean }>(
      `SELECT id, contact_id, email, answers, page_url, created_at, created_contact
         FROM crm_form_submissions WHERE form_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [id, userId, limit, offset]
    ),
    dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM crm_form_submissions WHERE form_id = $1 AND user_id = $2`, [id, userId]),
  ]);
  res.json({
    submissions: rows.rows.map((s) => ({
      id: s.id,
      contactId: s.contact_id,
      email: s.email,
      answers: Array.isArray(s.answers) ? s.answers : [],
      pageUrl: s.page_url,
      newLead: s.created_contact,
      createdAt: s.created_at,
    })),
    total: total.rows[0]?.n ?? 0,
    limit,
    offset,
  });
});

/** GET /crm/forms/:id/submissions/export */
export const exportSubmissionsCsv = handle(async (req, res) => {
  const userId = userIdOf(req);
  const id = idParam(req);
  const form = await readForm(userId, id);
  const tz = validTimeZone(req.query.tz) ?? validTimeZone(process.env.DB_TIMEZONE || process.env.PGTZ) ?? 'Asia/Karachi';
  const rows = await dbPool.query<{ email: string; answers: Answer[] | null; page_url: string | null; created_contact: boolean; created_at: string }>(
    `SELECT email, answers, page_url, created_contact, created_at
       FROM crm_form_submissions WHERE form_id = $1 AND user_id = $2
      ORDER BY created_at DESC, id DESC LIMIT 50000`,
    [id, userId]
  );
  // One column per current field, then answers of fields that were removed later.
  const columns = (form.fields ?? []).map((f) => ({ id: f.id, label: f.label }));
  for (const r of rows.rows) {
    for (const a of r.answers ?? []) if (!columns.some((c) => c.id === a.fieldId)) columns.push({ id: a.fieldId, label: a.label });
  }
  const header = ['Submitted', 'Email', 'New lead', 'Page', ...columns.map((c) => c.label)];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows.rows) {
    const d = pgDate(r.created_at);
    const answer = (fieldId: string) => (r.answers ?? []).find((a) => a.fieldId === fieldId)?.value ?? '';
    lines.push([d ? formatInZone(d, tz) : '', r.email, r.created_contact ? 'yes' : 'no', r.page_url, ...columns.map((c) => answer(c.id))].map(csvCell).join(','));
  }
  const slug = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'form';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-submissions-${formatInZone(new Date(), tz).slice(0, 10)}.csv"`);
  res.send(`\ufeff${lines.join('\r\n')}\r\n`);
});
