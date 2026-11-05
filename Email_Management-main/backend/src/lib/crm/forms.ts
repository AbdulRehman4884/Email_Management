/**
 * Lead capture forms (step 10).
 *
 *  - validateFormInput(): checks a form sent by the form builder (pure, no database).
 *  - submitForm(): a public submit. Spam checks (honeypot, optional Turnstile / reCAPTCHA, field checks),
 *    then in one transaction: same email = same lead, pipeline + stage + tags + fields, the submission,
 *    earlier website visits of the same browser join the lead, optional "add to campaign".
 *  - afterSubmit(): the form_submitted CRM event (rules + score), bell notification, notification
 *    email and the thank-you email. Emails go through the user's own SMTP account and only while
 *    that account still has sends left today.
 *
 * Answers are stored as plain text and always shown escaped.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';
import { ensureDefaultPipeline } from './pipelines.js';
import { webTablesReady } from './webTracking.js';
import { canAutoMove, type StageInfo } from './movePolicy.js';
import { emitCrmEvent } from './events.js';
import { sendEmail } from '../smtp.js';
import { countSendsTodayForSmtp, remainingSmtpQuota } from '../dailySendQuota.js';

type Db = Pick<PoolClient, 'query'>;

export const FIELD_TYPES = ['email', 'name', 'company', 'phone', 'message', 'text', 'number', 'dropdown'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** Built-in fields: at most one of each. */
const SINGLE_TYPES: FieldType[] = ['email', 'name', 'company', 'phone', 'message'];

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface FormDesign {
  buttonText: string;
  buttonColor: string;
  buttonTextColor: string;
  textColor: string;
  backgroundColor: string;
  rounded: boolean;
  /** Popup mode: open after this many seconds (null = only when a button with data-mailflow-open is clicked). */
  popupDelaySeconds: number | null;
}

export const DEFAULT_FIELDS: FormField[] = [
  { id: 'email', type: 'email', label: 'Email', required: true },
  { id: 'name', type: 'name', label: 'Name', required: false },
];

export const DEFAULT_DESIGN: FormDesign = {
  buttonText: 'Submit',
  buttonColor: '#4f46e5',
  buttonTextColor: '#ffffff',
  textColor: '#111827',
  backgroundColor: '#ffffff',
  rounded: true,
  popupDelaySeconds: 5,
};

const MAX_FIELDS = 20;
const MAX_OPTIONS = 30;
const MAX_ANSWER = 500;
const MAX_MESSAGE = 5000;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const isEmail = (v: string) => v.length <= 255 && EMAIL_RE.test(v);

/** Text from a visitor or the form builder: no control characters, trimmed, at most `max`. */
export function plainText(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

export interface CleanForm {
  name: string;
  isActive: boolean;
  title: string | null;
  description: string | null;
  fields: FormField[];
  design: FormDesign;
  successMessage: string | null;
  consentEnabled: boolean;
  consentText: string | null;
  pipelineId: number | null;
  stageId: number | null;
  tagIds: number[];
  thankYouEnabled: boolean;
  thankYouSmtpSettingsId: number | null;
  thankYouSubject: string | null;
  thankYouBody: string | null;
  notifyEnabled: boolean;
  notifyEmail: string | null;
  captchaProvider: 'turnstile' | 'recaptcha' | null;
  captchaSiteKey: string | null;
  captchaSecretKey: string | null;
  addToCampaignId: number | null;
}

function cleanFields(raw: unknown, errors: string[]): FormField[] {
  if (!Array.isArray(raw)) {
    errors.push('Fields: must be a list');
    return DEFAULT_FIELDS;
  }
  if (raw.length > MAX_FIELDS) errors.push(`Fields: at most ${MAX_FIELDS}`);
  const out: FormField[] = [];
  const ids = new Set<string>();
  raw.slice(0, MAX_FIELDS).forEach((f, i) => {
    const src = (f ?? {}) as Record<string, unknown>;
    const p = `Field ${i + 1}`;
    const type = String(src.type ?? '') as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      errors.push(`${p}: unknown type "${type}"`);
      return;
    }
    const id = String(src.id ?? '').trim();
    if (!/^[a-z0-9_]{1,40}$/.test(id)) errors.push(`${p}: id must be 1-40 lower-case letters, digits or _`);
    else if (ids.has(id)) errors.push(`${p}: the id "${id}" is used twice`);
    ids.add(id);
    if (SINGLE_TYPES.includes(type) && out.some((x) => x.type === type)) errors.push(`${p}: only one ${type} field`);
    const label = plainText(src.label, 100);
    if (!label) errors.push(`${p}: write a label`);
    const field: FormField = { id, type, label, required: type === 'email' ? true : src.required === true };
    const placeholder = plainText(src.placeholder, 100);
    if (placeholder) field.placeholder = placeholder;
    if (type === 'dropdown') {
      const options = Array.isArray(src.options) ? [...new Set(src.options.map((o) => plainText(o, 100)).filter(Boolean))] : [];
      if (options.length === 0) errors.push(`${p}: add at least one option`);
      if (options.length > MAX_OPTIONS) errors.push(`${p}: at most ${MAX_OPTIONS} options`);
      field.options = options.slice(0, MAX_OPTIONS);
    }
    out.push(field);
  });
  if (!out.some((f) => f.type === 'email')) errors.push('Fields: the Email field is required');
  return out;
}

function cleanDesign(raw: unknown, errors: string[]): FormDesign {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d: FormDesign = { ...DEFAULT_DESIGN };
  const color = (key: 'buttonColor' | 'buttonTextColor' | 'textColor' | 'backgroundColor', label: string) => {
    if (src[key] === undefined) return;
    if (typeof src[key] === 'string' && COLOR_RE.test(src[key] as string)) d[key] = (src[key] as string).toLowerCase();
    else errors.push(`${label}: a color like #4f46e5`);
  };
  color('buttonColor', 'Button color');
  color('buttonTextColor', 'Button text color');
  color('textColor', 'Text color');
  color('backgroundColor', 'Background color');
  if (src.buttonText !== undefined) {
    const t = plainText(src.buttonText, 40);
    if (!t) errors.push('Button text: write the button text (at most 40 characters)');
    else d.buttonText = t;
  }
  if (src.rounded !== undefined) d.rounded = src.rounded !== false;
  if (src.popupDelaySeconds !== undefined) {
    if (src.popupDelaySeconds === null || src.popupDelaySeconds === '') d.popupDelaySeconds = null;
    else {
      const n = Number(src.popupDelaySeconds);
      if (!Number.isInteger(n) || n < 0 || n > 600) errors.push('Popup delay: a whole number of seconds from 0 to 600');
      else d.popupDelaySeconds = n;
    }
  }
  return d;
}

const optId = (v: unknown): number | null | 'bad' => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 'bad';
};

/**
 * Full check of a form from the builder. `base` = PATCH: fields that are not sent keep their value.
 * Ownership of pipeline / stage / tags / SMTP account / campaign is checked by the controller.
 */
export function validateFormInput(input: Record<string, unknown>, base?: CleanForm): { ok: true; value: CleanForm } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const text = (k: keyof CleanForm, max: number) => (has(k) ? plainText(input[k], max) || null : (base?.[k] as string | null | undefined) ?? null);
  const flag = (k: keyof CleanForm, dflt: boolean) => (has(k) ? input[k] === true : (base?.[k] as boolean | undefined) ?? dflt);
  const id = (k: keyof CleanForm, label: string) => {
    if (!has(k)) return (base?.[k] as number | null | undefined) ?? null;
    const v = optId(input[k]);
    if (v === 'bad') {
      errors.push(`${label}: invalid id`);
      return null;
    }
    return v;
  };

  const name = has('name') ? plainText(input.name, 255) : base?.name ?? '';
  if (!name) errors.push('Name: give the form a name');
  const fields = has('fields') ? cleanFields(input.fields, errors) : base?.fields ?? DEFAULT_FIELDS;
  const design = has('design') ? cleanDesign(input.design, errors) : base?.design ?? DEFAULT_DESIGN;

  let tagIds = base?.tagIds ?? [];
  if (has('tagIds')) {
    const raw = Array.isArray(input.tagIds) ? input.tagIds : [];
    tagIds = [...new Set(raw.map(Number))];
    if (!Array.isArray(input.tagIds) || tagIds.some((t) => !Number.isInteger(t) || t < 1) || tagIds.length > 20) {
      errors.push('Tags: up to 20 of your tags');
      tagIds = [];
    }
  }

  const notifyEmail = text('notifyEmail', 255);
  if (notifyEmail && !isEmail(notifyEmail)) errors.push('Notification email: enter a valid email address');

  const provider = has('captchaProvider') ? input.captchaProvider || null : base?.captchaProvider ?? null;
  if (provider !== null && provider !== 'turnstile' && provider !== 'recaptcha') errors.push('Spam check: Turnstile, reCAPTCHA or none');
  const captchaSiteKey = text('captchaSiteKey', 255);
  const captchaSecretKey = text('captchaSecretKey', 255);
  if (provider && (!captchaSiteKey || !captchaSecretKey)) errors.push('Spam check: enter the site key and the secret key');

  const thankYouEnabled = flag('thankYouEnabled', false);
  const thankYouSmtpSettingsId = id('thankYouSmtpSettingsId', 'Thank-you email account');
  const thankYouSubject = text('thankYouSubject', 255);
  const thankYouBody = has('thankYouBody') ? plainText(input.thankYouBody, 5000) || null : base?.thankYouBody ?? null;
  if (thankYouEnabled && (!thankYouSmtpSettingsId || !thankYouSubject || !thankYouBody)) {
    errors.push('Thank-you email: pick your email account and write the subject and the message');
  }

  const consentEnabled = flag('consentEnabled', false);
  const consentText = text('consentText', 500);
  if (consentEnabled && !consentText) errors.push('Consent checkbox: write the consent text');

  const value: CleanForm = {
    name,
    isActive: flag('isActive', true),
    title: text('title', 255),
    description: text('description', 1000),
    fields,
    design,
    successMessage: text('successMessage', 500),
    consentEnabled,
    consentText,
    pipelineId: id('pipelineId', 'Pipeline'),
    stageId: id('stageId', 'Stage'),
    tagIds,
    thankYouEnabled,
    thankYouSmtpSettingsId,
    thankYouSubject,
    thankYouBody,
    notifyEnabled: flag('notifyEnabled', true),
    notifyEmail,
    captchaProvider: provider as CleanForm['captchaProvider'],
    captchaSiteKey,
    captchaSecretKey,
    addToCampaignId: id('addToCampaignId', 'Campaign'),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// ─── Public submit ──────────────────────────────────────────────────────────

export type FormRow = {
  id: number; user_id: number; form_key: string; name: string; is_active: boolean; title: string | null; description: string | null;
  fields: FormField[]; design: Partial<FormDesign>; success_message: string | null; consent_enabled: boolean; consent_text: string | null;
  pipeline_id: number | null; stage_id: number | null; tag_ids: number[]; thank_you_enabled: boolean; thank_you_smtp_settings_id: number | null;
  thank_you_subject: string | null; thank_you_body: string | null; notify_enabled: boolean; notify_email: string | null;
  captcha_provider: 'turnstile' | 'recaptcha' | null; captcha_site_key: string | null; captcha_secret_key: string | null;
  add_to_campaign_id: number | null;
};

export async function loadFormByKey(formKey: string, db: Db = dbPool): Promise<FormRow | null> {
  if (!/^FM_[A-Za-z0-9_-]{8,37}$/.test(formKey)) return null;
  const r = await db.query<FormRow>(`SELECT * FROM crm_forms WHERE form_key = $1`, [formKey]);
  return r.rows[0] ?? null;
}

export interface SubmitMeta {
  ip: string;
  ipHash: string;
  /** _mfv cookie of the website the form is on (t.js), to join earlier visits. */
  visitorKey: string | null;
  pageUrl: string | null;
}

export type SubmitResult =
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'spam' }
  | { status: 'captcha' }
  | { status: 'invalid'; errors: Record<string, string> }
  | { status: 'ok'; message: string; form: FormRow; contactId: number; submissionId: number; created: boolean; path: string | null; answers: Answer[] };

export type Answer = { fieldId: string; label: string; value: string };

async function captchaOk(form: FormRow, token: unknown, ip: string): Promise<boolean> {
  if (!form.captcha_provider || !form.captcha_secret_key) return true;
  if (typeof token !== 'string' || !token || token.length > 4096) return false;
  const url = form.captcha_provider === 'turnstile'
    ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
    : 'https://www.google.com/recaptcha/api/siteverify';
  const body = new URLSearchParams({ secret: form.captcha_secret_key, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}

/** Checks the answers against the form fields. Pure. */
export function checkAnswers(form: Pick<FormRow, 'fields' | 'consent_enabled' | 'consent_text'>, values: Record<string, unknown>, consent: unknown) {
  const errors: Record<string, string> = {};
  const answers: Answer[] = [];
  let email = '';
  for (const f of form.fields ?? []) {
    const value = plainText(values[f.id], f.type === 'message' ? MAX_MESSAGE : MAX_ANSWER);
    if (!value) {
      if (f.required) errors[f.id] = `${f.label} is required`;
      continue;
    }
    if (f.type === 'email') {
      if (!isEmail(value)) {
        errors[f.id] = 'Enter a valid email address';
        continue;
      }
      email = value.toLowerCase();
    }
    if (f.type === 'number' && !Number.isFinite(Number(value))) {
      errors[f.id] = `${f.label} must be a number`;
      continue;
    }
    if (f.type === 'dropdown' && !(f.options ?? []).includes(value)) {
      errors[f.id] = `Pick one of the options for ${f.label}`;
      continue;
    }
    answers.push({ fieldId: f.id, label: f.label, value });
  }
  if (form.consent_enabled) {
    if (consent !== true) errors.consent = 'Please give your consent';
    else answers.push({ fieldId: 'consent', label: form.consent_text ?? 'Consent', value: 'Yes' });
  }
  return { errors, answers, email };
}

function pathOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname.slice(0, 1000);
  } catch {
    return null;
  }
}

/** Public submit. Rate limits are checked by the controller before this runs. */
export async function submitForm(formKey: string, body: Record<string, unknown>, meta: SubmitMeta): Promise<SubmitResult> {
  const form = await loadFormByKey(formKey);
  if (!form) return { status: 'not_found' };
  if (!form.is_active) return { status: 'closed' };
  if (plainText(body._hp, 200)) return { status: 'spam' };

  const values = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : {};
  const { errors, answers, email } = checkAnswers(form, values, body.consent);
  if (Object.keys(errors).length || !email) return { status: 'invalid', errors: Object.keys(errors).length ? errors : { email: 'Enter a valid email address' } };
  if (!(await captchaOk(form, body.captchaToken, meta.ip))) return { status: 'captcha' };

  let pageUrl: string | null = null;
  if (meta.pageUrl) {
    try {
      const u = new URL(meta.pageUrl);
      if (/^https?:$/.test(u.protocol)) pageUrl = `${u.origin}${u.pathname}`.slice(0, 1000);
    } catch {
      pageUrl = null;
    }
  }

  const byType = (t: FieldType) => answers.find((a) => form.fields.find((f) => f.id === a.fieldId)?.type === t)?.value ?? null;
  const name = byType('name')?.slice(0, 255) ?? null;
  const company = byType('company')?.slice(0, 255) ?? null;
  const custom: Record<string, string> = {};
  const phone = byType('phone');
  if (phone) custom.phone = phone;
  for (const f of form.fields) {
    if (f.type === 'text' || f.type === 'number' || f.type === 'dropdown') {
      const a = answers.find((x) => x.fieldId === f.id);
      if (a) custom[f.label] = a.value;
    }
  }

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42031, $1)', [form.user_id]);
    await ensureDefaultPipeline(form.user_id, client);

    // The form's pipeline / stage when they still exist, else the default pipeline, first stage.
    const pipe = await client.query<{ pipeline_id: number; stage_id: number | null }>(
      `SELECT p.id AS pipeline_id,
              COALESCE(
                (SELECT s.id FROM crm_pipeline_stages s WHERE s.id = $3 AND s.pipeline_id = p.id),
                (SELECT s.id FROM crm_pipeline_stages s WHERE s.pipeline_id = p.id ORDER BY s.position, s.id LIMIT 1)
              ) AS stage_id
         FROM crm_pipelines p
        WHERE p.user_id = $1
        ORDER BY (p.id = $2) DESC, p.is_default DESC, p.id ASC
        LIMIT 1`,
      [form.user_id, form.pipeline_id ?? -1, form.stage_id ?? -1]
    );
    const pipelineId = pipe.rows[0]?.pipeline_id ?? null;
    const stageId = pipe.rows[0]?.stage_id ?? null;

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO crm_contacts (user_id, email, name, company, custom_fields, pipeline_id, stage_id, stage_entered_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CASE WHEN $7::int IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id, email) DO NOTHING
       RETURNING id`,
      [form.user_id, email, name, company, Object.keys(custom).length ? JSON.stringify(custom) : null, pipelineId, stageId]
    );
    const created = inserted.rows[0] != null;
    let contactId: number;
    if (created) {
      contactId = inserted.rows[0]!.id;
      if (stageId != null) {
        await client.query(`INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason) VALUES ($1, NULL, $2, 'created')`, [contactId, stageId]);
      }
    } else {
      const existing = await client.query<{ id: number; pipeline_id: number | null; stage_id: number | null }>(
        `SELECT id, pipeline_id, stage_id FROM crm_contacts WHERE user_id = $1 AND email = $2 FOR UPDATE`,
        [form.user_id, email]
      );
      const c = existing.rows[0]!;
      contactId = c.id;
      await client.query(
        `UPDATE crm_contacts
            SET name = COALESCE(NULLIF(btrim(name), ''), $2),
                company = COALESCE(NULLIF(btrim(company), ''), $3),
                custom_fields = CASE WHEN $4::jsonb IS NULL THEN custom_fields
                                     WHEN jsonb_typeof(custom_fields) = 'object' THEN custom_fields || $4::jsonb
                                     ELSE $4::jsonb END,
                updated_at = now()
          WHERE id = $1`,
        [contactId, name, company, Object.keys(custom).length ? JSON.stringify(custom) : null]
      );
      if (stageId != null) await placeExistingLead(client, contactId, c.pipeline_id, c.stage_id, pipelineId!, stageId, form.name);
    }

    if (form.tag_ids?.length) {
      await client.query(
        `INSERT INTO crm_contact_tags (contact_id, tag_id)
         SELECT $1, t.id FROM crm_tags t WHERE t.id = ANY($2::int[]) AND t.user_id = $3
         ON CONFLICT DO NOTHING`,
        [contactId, form.tag_ids, form.user_id]
      );
    }

    // Earlier visits of this browser (t.js cookie) join the lead.
    let visitorId: number | null = null;
    if (meta.visitorKey) {
      const v = await client.query<{ id: number }>(
        `UPDATE crm_web_visitors SET contact_id = $3
          WHERE user_id = $1 AND visitor_key = $2 AND (contact_id IS NULL OR contact_id = $3)
          RETURNING id`,
        [form.user_id, meta.visitorKey, contactId]
      );
      visitorId = v.rows[0]?.id ?? null;
      if (v.rows.length) {
        await client.query(
          `UPDATE crm_web_pageviews SET contact_id = $1 WHERE visitor_id = ANY($2::int[]) AND contact_id IS NULL`,
          [contactId, v.rows.map((r) => r.id)]
        );
      }
    }

    const sub = await client.query<{ id: number }>(
      `INSERT INTO crm_form_submissions (form_id, user_id, contact_id, visitor_id, created_contact, email, answers, page_url, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING id`,
      [form.id, form.user_id, contactId, visitorId, created, email, JSON.stringify(answers), pageUrl, meta.ipHash]
    );
    await client.query(`UPDATE crm_forms SET submission_count = submission_count + 1 WHERE id = $1`, [form.id]);
    if (form.add_to_campaign_id) await addToCampaign(client, form, contactId, email, name, custom);

    await client.query('COMMIT');
    return {
      status: 'ok',
      message: form.success_message || 'Thank you! We will be in touch soon.',
      form,
      contactId,
      submissionId: sub.rows[0]!.id,
      created,
      path: pathOf(pageUrl),
      answers,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** An existing lead moves to the form's stage only as the rules would move it (forward, not out of Won/Lost or manual stages). */
async function placeExistingLead(
  client: PoolClient, contactId: number, currentPipeline: number | null, currentStage: number | null, pipelineId: number, stageId: number, formName: string
): Promise<void> {
  if (currentPipeline != null && currentPipeline !== pipelineId) return;
  const stages = await client.query<{ id: number; name: string; position: number; type: string; manual_only: boolean; stop_follow_ups: boolean }>(
    `SELECT id, name, position, type, manual_only, stop_follow_ups FROM crm_pipeline_stages WHERE id = ANY($1::int[])`,
    [[stageId, currentStage ?? -1]]
  );
  const info = (id: number | null): StageInfo | null => {
    const s = stages.rows.find((x) => x.id === id);
    return s ? { id: s.id, name: s.name, position: s.position, type: s.type, manualOnly: s.manual_only, stopFollowUps: s.stop_follow_ups } : null;
  };
  if (currentPipeline != null && !canAutoMove(info(currentStage), info(stageId), true).ok) return;
  await client.query(
    `UPDATE crm_contacts SET pipeline_id = $2, stage_id = $3, stage_entered_at = now(), updated_at = now() WHERE id = $1`,
    [contactId, pipelineId, stageId]
  );
  await client.query(
    `INSERT INTO crm_stage_history (contact_id, from_stage_id, to_stage_id, reason) VALUES ($1, $2, $3, $4)`,
    [contactId, currentStage, stageId, `Form: ${formName}`.slice(0, 255)]
  );
}

/** Optional: the lead is added to a campaign of the same user that is not finished (once, not when suppressed). */
async function addToCampaign(client: PoolClient, form: FormRow, contactId: number, email: string, name: string | null, custom: Record<string, string>): Promise<void> {
  const camp = await client.query(
    `SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2 AND status NOT IN ('completed', 'cancelled') FOR UPDATE`,
    [form.add_to_campaign_id, form.user_id]
  );
  if (!camp.rowCount) return;
  const blocked = await client.query(
    `SELECT 1 FROM suppression_list WHERE lower(email) = $1
     UNION ALL
     SELECT 1 FROM recipients WHERE campaign_id = $2 AND lower(email) = $1
     LIMIT 1`,
    [email, form.add_to_campaign_id]
  );
  if (blocked.rowCount) return;
  const rec = await client.query<{ id: number }>(
    `INSERT INTO recipients (campaign_id, email, name, custom_fields, status) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [form.add_to_campaign_id, email, name?.slice(0, 100) ?? null, Object.keys(custom).length ? JSON.stringify(custom).slice(0, 5000) : null]
  );
  await client.query(`UPDATE campaigns SET reciept_count = reciept_count + 1, updated_at = now() WHERE id = $1`, [form.add_to_campaign_id]);
  await client.query(
    `INSERT INTO crm_contact_recipients (contact_id, recipient_id, campaign_id) VALUES ($1, $2, $3) ON CONFLICT (recipient_id) DO NOTHING`,
    [contactId, rec.rows[0]!.id, form.add_to_campaign_id]
  );
}

/** Lead drawer: lead source ("Form: <name>" when a form submit created the lead) and the form submissions. */
export async function contactFormActivity(contactId: number, db: Db = dbPool) {
  if (!(await webTablesReady(db))) return null;
  const r = await db.query<{ id: number; form_id: number; form_name: string; answers: Answer[]; page_url: string | null; created_contact: boolean; created_at: string }>(
    `SELECT s.id, s.form_id, f.name AS form_name, s.answers, s.page_url, s.created_contact, s.created_at
       FROM crm_form_submissions s JOIN crm_forms f ON f.id = s.form_id
      WHERE s.contact_id = $1
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 20`,
    [contactId]
  );
  const origin = r.rows.find((s) => s.created_contact);
  return {
    source: origin ? { type: 'form' as const, formId: origin.form_id, label: `Form: ${origin.form_name}` } : { type: 'campaign' as const, formId: null, label: 'Campaign' },
    submissions: r.rows.map((s) => ({
      id: s.id,
      formId: s.form_id,
      formName: s.form_name,
      answers: Array.isArray(s.answers) ? s.answers : [],
      pageUrl: s.page_url,
      at: s.created_at,
    })),
  };
}

// ─── After a submit: CRM event, notifications, thank-you email ─────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const textToHtml = (s: string) => `<p style="white-space:pre-wrap;margin:0;">${escapeHtml(s)}</p>`;

/** True when this SMTP account of the user may still send today (same daily limit as campaigns). */
async function smtpCanSend(userId: number, smtpId: number): Promise<boolean> {
  const r = await dbPool.query<{ daily_email_limit: number | null }>(
    `SELECT daily_email_limit FROM smtp_settings WHERE id = $1 AND user_id = $2`,
    [smtpId, userId]
  );
  if (!r.rows[0]) return false;
  const remaining = remainingSmtpQuota(r.rows[0].daily_email_limit, await countSendsTodayForSmtp(userId, smtpId));
  return remaining == null || remaining > 0;
}

export async function afterSubmit(r: Extract<SubmitResult, { status: 'ok' }>): Promise<void> {
  const { form, contactId } = r;
  await emitCrmEvent(form.user_id, contactId, {
    type: 'form_submitted',
    data: { formId: form.id, formName: form.name, submissionId: r.submissionId, path: r.path },
  });

  const lead = (await dbPool.query<{ email: string; name: string | null }>(`SELECT email, name FROM crm_contacts WHERE id = $1`, [contactId])).rows[0];
  if (!lead) return;
  const who = lead.name?.trim() ? `${lead.name.trim()} (${lead.email})` : lead.email;
  const summary = r.answers.map((a) => `${a.label}: ${a.value}`).join('\n');

  const notify = async () => {
    if (!form.notify_enabled) return;
    await dbPool.query(
      `INSERT INTO user_notifications (user_id, type, payload) VALUES ($1, 'crm_form_submitted', $2::jsonb)`,
      [
        form.user_id,
        JSON.stringify({
          contactId,
          formId: form.id,
          formName: form.name,
          email: lead.email,
          name: lead.name,
          message: `${who} submitted ${form.name}${r.path ? ` on ${r.path}` : ''}`,
        }),
      ]
    );
    if (form.notify_email) {
      const smtp = form.thank_you_smtp_settings_id
        ?? (await dbPool.query<{ id: number }>(`SELECT id FROM smtp_settings WHERE user_id = $1 ORDER BY id LIMIT 1`, [form.user_id])).rows[0]?.id
        ?? null;
      if (smtp != null && (await smtpCanSend(form.user_id, smtp))) {
        const text = `${who} submitted "${form.name}"${r.path ? ` on ${r.path}` : ''}.\n\n${summary}`;
        await sendEmail({ userId: form.user_id, smtpSettingsId: smtp, to: form.notify_email, subject: `New form submission: ${form.name}`, text, html: textToHtml(text), fromName: 'MailFlow Forms' });
      }
    }
  };

  const thankYou = async () => {
    if (!form.thank_you_enabled || !form.thank_you_smtp_settings_id || !form.thank_you_subject || !form.thank_you_body) return;
    if (!(await smtpCanSend(form.user_id, form.thank_you_smtp_settings_id))) return;
    const fill = (s: string) =>
      s.replace(/\{\{\s*name\s*\}\}/gi, lead.name?.trim() || '').replace(/\{\{\s*email\s*\}\}/gi, lead.email).replace(/\{\{\s*form\s*\}\}/gi, form.name);
    const text = fill(form.thank_you_body);
    await sendEmail({
      userId: form.user_id,
      smtpSettingsId: form.thank_you_smtp_settings_id,
      to: lead.email,
      subject: fill(form.thank_you_subject).slice(0, 255),
      text,
      html: textToHtml(text),
    });
  };

  // Both are tried even when one fails; the first error is reported to the CRM queue's log.
  const failed = (await Promise.allSettled([notify(), thankYou()])).find((x) => x.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
}
