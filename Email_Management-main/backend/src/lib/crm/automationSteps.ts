/**
 * Lead automations: the steps of an automation and their checks. Pure (no database), unit tested.
 *
 * An automation is a list of steps that runs top to bottom for one lead:
 *   email   send an email (an empty subject = a reply in the thread of the first email)
 *   wait    wait some minutes / hours / days
 *   remind  a bell reminder for the user ("Call this lead")
 *   tag     add one of the user's tags to the lead
 *   stage   move the lead to a stage
 *   call    the user calls the lead and picks the result; each result has its own steps.
 *           "No answer" can repeat the call reminder before its own steps run.
 * A call step is always the last main step (its results hold the rest), and result steps have no call step.
 */
/** Text from the builder: no control characters, trimmed, at most `max` (same as the form builder). */
function plainText(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

export const CALL_RESULTS = ['interested', 'no_answer', 'not_interested'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];
export const CALL_RESULT_LABELS: Record<CallResult, string> = {
  interested: 'Interested',
  no_answer: 'No answer',
  not_interested: 'Not interested',
};

export const WAIT_UNITS = ['minutes', 'hours', 'days'] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];
const UNIT_MS: Record<WaitUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** Longest single wait: one year. */
const MAX_WAIT_MS = 365 * UNIT_MS.days;

export const MAX_MAIN_STEPS = 20;
export const MAX_RESULT_STEPS = 10;
export const MAX_CALL_RETRIES = 5;
const MAX_SUBJECT = 255;
const MAX_BODY = 10_000;
const MAX_MESSAGE = 300;

export type EmailStep = { id: string; type: 'email'; subject: string; body: string };
export type WaitStep = { id: string; type: 'wait'; amount: number; unit: WaitUnit };
export type RemindStep = { id: string; type: 'remind'; message: string };
export type TagStep = { id: string; type: 'tag'; tagId: number };
export type StageStep = { id: string; type: 'stage'; stageId: number };
export type ResultStep = EmailStep | WaitStep | RemindStep | TagStep | StageStep;
export type CallStep = {
  id: string;
  type: 'call';
  /** Shown in the call reminder, e.g. "Ask about their budget". */
  message: string;
  /** "No answer": how many more times the call is repeated before the No answer steps run. */
  retries: number;
  retryAmount: number;
  retryUnit: WaitUnit;
  outcomes: Record<CallResult, ResultStep[]>;
};
export type AutomationStep = ResultStep | CallStep;

/**
 * 'form': started by a form, all step types.
 * 'campaign' (migration 0041): follow-ups after a campaign's first email. Only email and wait steps; every email
 * is a reply in the campaign's thread ("Re: <campaign subject>"), sent from the campaign's email account.
 */
export const AUTOMATION_KINDS = ['form', 'campaign'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

export interface CleanAutomation {
  name: string;
  kind: AutomationKind;
  isActive: boolean;
  smtpSettingsId: number | null;
  steps: AutomationStep[];
}

export const waitMs = (amount: number, unit: WaitUnit) => amount * UNIT_MS[unit];

let idCounter = 0;
const newStepId = () => `s${Date.now().toString(36)}${(idCounter++ % 1296).toString(36)}`;

function cleanWait(src: Record<string, unknown>, p: string, errors: string[], amountKey = 'amount', unitKey = 'unit'): { amount: number; unit: WaitUnit } {
  const amount = Number(src[amountKey]);
  const unit = String(src[unitKey] ?? '') as WaitUnit;
  if (!WAIT_UNITS.includes(unit)) errors.push(`${p}: wait in minutes, hours or days`);
  else if (!Number.isInteger(amount) || amount < 1 || waitMs(amount, unit) > MAX_WAIT_MS) errors.push(`${p}: wait a whole number, at most one year`);
  return { amount: Number.isInteger(amount) && amount > 0 ? amount : 1, unit: WAIT_UNITS.includes(unit) ? unit : 'days' };
}

/** One step that is not a call. `hasSubject` = an earlier email on this path has a subject (needed for a thread reply). */
function cleanResultStep(raw: unknown, p: string, errors: string[], state: { hasSubject: boolean }): ResultStep | null {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawId = String(src.id ?? '').trim();
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(rawId) ? rawId : newStepId();
  switch (src.type) {
    case 'email': {
      const subject = plainText(src.subject, MAX_SUBJECT);
      const body = plainText(src.body, MAX_BODY);
      if (!body) errors.push(`${p}: write the email message`);
      if (!subject && !state.hasSubject) errors.push(`${p}: write a subject (only a later email can leave it empty to reply in the same thread)`);
      if (subject) state.hasSubject = true;
      return { id, type: 'email', subject, body };
    }
    case 'wait':
      return { id, type: 'wait', ...cleanWait(src, p, errors) };
    case 'remind': {
      const message = plainText(src.message, MAX_MESSAGE);
      if (!message) errors.push(`${p}: write the reminder`);
      return { id, type: 'remind', message };
    }
    case 'tag': {
      const tagId = Number(src.tagId);
      if (!Number.isInteger(tagId) || tagId < 1) errors.push(`${p}: pick a tag`);
      return { id, type: 'tag', tagId: Number.isInteger(tagId) ? tagId : 0 };
    }
    case 'stage': {
      const stageId = Number(src.stageId);
      if (!Number.isInteger(stageId) || stageId < 1) errors.push(`${p}: pick a stage`);
      return { id, type: 'stage', stageId: Number.isInteger(stageId) ? stageId : 0 };
    }
    case 'call':
      errors.push(`${p}: a call result cannot have another call step`);
      return null;
    default:
      errors.push(`${p}: unknown step "${String(src.type ?? '')}"`);
      return null;
  }
}

/** Campaign automations: email (message only, always a reply in the campaign thread) and wait steps. */
function cleanCampaignSteps(raw: unknown[], errors: string[]): AutomationStep[] {
  const steps: AutomationStep[] = [];
  raw.slice(0, MAX_MAIN_STEPS).forEach((s, i) => {
    const p = `Step ${i + 1}`;
    const type = (s && typeof s === 'object' ? (s as Record<string, unknown>).type : undefined);
    if (type !== 'email' && type !== 'wait') {
      errors.push(`${p}: a campaign automation has only Email and Wait steps`);
      return;
    }
    const step = cleanResultStep(s, p, errors, { hasSubject: true });
    if (step) steps.push(step.type === 'email' ? { ...step, subject: '' } : step);
  });
  return steps;
}

/** Checks the steps sent by the builder. Step ids are kept (new ones are made when missing). */
export function cleanSteps(raw: unknown, errors: string[], kind: AutomationKind = 'form'): AutomationStep[] {
  if (!Array.isArray(raw)) {
    errors.push('Steps: must be a list');
    return [];
  }
  if (raw.length > MAX_MAIN_STEPS) errors.push(`Steps: at most ${MAX_MAIN_STEPS}`);
  if (kind === 'campaign') return cleanCampaignSteps(raw, errors);
  const steps: AutomationStep[] = [];
  const state = { hasSubject: false };
  raw.slice(0, MAX_MAIN_STEPS).forEach((s, i) => {
    const p = `Step ${i + 1}`;
    const src = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    if (src.type !== 'call') {
      const step = cleanResultStep(s, p, errors, state);
      if (step) steps.push(step);
      return;
    }
    if (i !== raw.length - 1) errors.push(`${p}: the call step must be the last step (add the next steps under each call result)`);
    const rawId = String(src.id ?? '').trim();
    const retries = Number(src.retries ?? 0);
    if (!Number.isInteger(retries) || retries < 0 || retries > MAX_CALL_RETRIES) errors.push(`${p}: call again 0 to ${MAX_CALL_RETRIES} times`);
    const retryWait = cleanWait({ amount: src.retryAmount ?? 1, unit: src.retryUnit ?? 'days' }, `${p} (call again)`, errors);
    const rawOutcomes = (src.outcomes && typeof src.outcomes === 'object' ? src.outcomes : {}) as Record<string, unknown>;
    const outcomes = {} as Record<CallResult, ResultStep[]>;
    for (const result of CALL_RESULTS) {
      const list = Array.isArray(rawOutcomes[result]) ? (rawOutcomes[result] as unknown[]) : [];
      if (list.length > MAX_RESULT_STEPS) errors.push(`${p} (${CALL_RESULT_LABELS[result]}): at most ${MAX_RESULT_STEPS} steps`);
      const branchState = { ...state };
      outcomes[result] = list
        .slice(0, MAX_RESULT_STEPS)
        .map((r, j) => cleanResultStep(r, `${p} (${CALL_RESULT_LABELS[result]}), step ${j + 1}`, errors, branchState))
        .filter((r): r is ResultStep => r != null);
    }
    steps.push({
      id: /^[A-Za-z0-9_-]{1,40}$/.test(rawId) ? rawId : newStepId(),
      type: 'call',
      message: plainText(src.message, MAX_MESSAGE),
      retries: Number.isInteger(retries) ? Math.min(MAX_CALL_RETRIES, Math.max(0, retries)) : 0,
      retryAmount: retryWait.amount,
      retryUnit: retryWait.unit,
      outcomes,
    });
  });
  return steps;
}

const optId = (v: unknown): number | null | 'bad' => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 'bad';
};

/** Full check of an automation from the builder. `base` = PATCH: what is not sent keeps its value. */
export function validateAutomationInput(input: Record<string, unknown>, base?: CleanAutomation): { ok: true; value: CleanAutomation } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const name = has('name') ? plainText(input.name, 255) : base?.name ?? '';
  if (!name) errors.push('Name: give the automation a name');
  // The kind is chosen when the automation is made and never changes.
  let kind: AutomationKind = base?.kind ?? 'form';
  if (has('kind') && input.kind !== kind) {
    if (base) errors.push('Kind: a form automation cannot become a campaign automation, or the other way round');
    else if ((AUTOMATION_KINDS as readonly unknown[]).includes(input.kind)) kind = input.kind as AutomationKind;
    else errors.push('Kind: form or campaign');
  }
  const steps = has('steps') ? cleanSteps(input.steps, errors, kind) : base?.steps ?? [];
  let smtpSettingsId = base?.smtpSettingsId ?? null;
  if (has('smtpSettingsId')) {
    const v = optId(input.smtpSettingsId);
    if (v === 'bad') errors.push('Email account: invalid id');
    else smtpSettingsId = v;
  }
  const isActive = has('isActive') ? input.isActive === true : base?.isActive ?? false;
  if (isActive) {
    if (steps.length === 0) errors.push('Add at least one step before turning the automation on');
    if (kind === 'campaign') {
      if (!usesEmail(steps)) errors.push('Add at least one follow-up email before turning the automation on');
    } else if (smtpSettingsId == null && usesEmail(steps)) {
      errors.push('Email account: pick the account the emails are sent from');
    }
  }
  // Campaign automations send from each campaign's own email account.
  if (kind === 'campaign') smtpSettingsId = null;
  return errors.length ? { ok: false, errors } : { ok: true, value: { name, kind, isActive, smtpSettingsId, steps } };
}

/** Every step, results included (for ownership checks of tags and stages). */
export function allSteps(steps: AutomationStep[]): ResultStep[] {
  return steps.flatMap((s) => (s.type === 'call' ? CALL_RESULTS.flatMap((r) => s.outcomes[r]) : [s]));
}

export const usesEmail = (steps: AutomationStep[]) => allSteps(steps).some((s) => s.type === 'email');

/** Steps saved in the database; anything malformed is dropped instead of failing a running lead. */
export function storedSteps(raw: unknown, kind: AutomationKind = 'form'): AutomationStep[] {
  return Array.isArray(raw) ? cleanSteps(raw, [], kind) : [];
}

/** The kind saved in the database ('form' before migration 0041). */
export const kindOf = (v: unknown): AutomationKind => (v === 'campaign' ? 'campaign' : 'form');

export interface LeadFields {
  email: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  form: string | null;
}

/** {{name}} {{first_name}} {{email}} {{company}} {{phone}} {{form}} (any case, spaces allowed). Unknown ones stay as written. */
export function fillPlaceholders(text: string, lead: LeadFields): string {
  const name = lead.name?.trim() || '';
  const values: Record<string, string> = {
    name,
    first_name: name.split(/\s+/)[0] ?? '',
    email: lead.email,
    company: lead.company?.trim() || '',
    phone: lead.phone?.trim() || '',
    form: lead.form?.trim() || '',
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (all, key: string) => values[key.toLowerCase()] ?? all);
}

/**
 * Why a run must stop now, or null. `suppressed` = the lead's suppression_list reason
 * (unsubscribe, bounce, complaint, data_subject_request); Won / Lost stages stop it too. A reply does not.
 */
export function stopRule(lead: { suppressed: string | null; stage_type: string | null; stage_name: string | null }): { code: string; reason: string } | null {
  if (lead.suppressed) {
    if (lead.suppressed === 'bounce') return { code: 'bounced', reason: 'The email bounced' };
    return { code: 'unsubscribed', reason: lead.suppressed === 'unsubscribe' ? 'The lead unsubscribed' : 'The lead asked not to get emails' };
  }
  if (lead.stage_type === 'won' || lead.stage_type === 'lost') {
    const kind = lead.stage_type === 'won' ? 'Won' : 'Lost';
    const name = lead.stage_name && lead.stage_name !== kind ? `"${lead.stage_name}", a ${kind} stage` : `the ${kind} stage`;
    return { code: 'won_lost', reason: `The lead is in ${name}` };
  }
  return null;
}

/**
 * Campaign follow-ups stop when the lead replied (an out-of-office reply does not count), unsubscribed, bounced or
 * complained, when the CRM stops follow-ups for the lead (a "stop follow-ups" stage such as Interested, Won or Lost,
 * or a rule), or when the campaign was cancelled. A paused campaign only waits.
 */
export function campaignStopRule(lead: {
  status: string;
  suppressed: string | null;
  replied: boolean;
  crmBlocked: boolean;
  campaign_status: string;
}): { code: string; reason: string } | null {
  if (lead.replied) return { code: 'replied', reason: 'The lead replied' };
  if (lead.suppressed === 'bounce' || lead.status === 'bounced' || lead.status === 'failed') return { code: 'bounced', reason: 'The email bounced' };
  if (lead.suppressed || lead.status === 'unsubscribed' || lead.status === 'complained') return { code: 'unsubscribed', reason: 'The lead unsubscribed' };
  if (lead.crmBlocked) return { code: 'crm', reason: 'Follow-ups are stopped for this lead in the CRM (its stage or a rule)' };
  if (lead.campaign_status === 'cancelled') return { code: 'campaign_cancelled', reason: 'The campaign was cancelled' };
  return null;
}

/** "Re: <subject>" without stacking "Re: Re:". */
export const replySubject = (subject: string) => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`).slice(0, MAX_SUBJECT);
