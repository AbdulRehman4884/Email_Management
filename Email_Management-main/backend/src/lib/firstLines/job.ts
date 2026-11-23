/**
 * AI first lines for a campaign: a background run over the campaign's not-yet-sent leads.
 *
 * For each lead: find the website (website column, or the company email domain) → read the homepage with the
 * guarded fetch (safeFetch: public addresses only, size and time limits) → the AI writes one sentence from a real
 * detail on it → the line must be grounded in the page (core.parseFirstLine) → saved in the lead's custom fields as
 * `first_line`. No website / nothing specific → a plain line from the company name, or empty.
 * The campaign gets `first_line` in its available columns, so {first_line} passes the placeholder check.
 *
 * Runs in this process (like the AI campaign creation job): progress lives in memory, the lines in the database.
 */
import { dbPool } from '../db.js';
import { safeFetch } from '../leadgen/http.js';
import { aiConfigured, completeJson } from '../aiReply/ai.js';
import {
  FIRST_LINE_FIELD,
  FIRST_LINE_MAX,
  FIRST_LINE_SOURCE_FIELD,
  buildFirstLineMessages,
  companyOf,
  emailTopicOf,
  fallbackLine,
  hasContent,
  isBlockedPage,
  jobTitleOf,
  parseFirstLine,
  readFields,
  summarizePage,
  websiteFor,
  withFirstLine,
  type PageSummary,
} from './core.js';

const CONCURRENCY = 6;
const MAX_LEADS = 5000;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 1_500_000;

export interface FirstLineRun {
  status: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  fromWebsite: number;
  fallback: number;
  empty: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const runs = new Map<number, FirstLineRun>();

export function runFor(campaignId: number): FirstLineRun | null {
  return runs.get(campaignId) ?? null;
}

interface LeadRow {
  id: number;
  email: string;
  name: string | null;
  custom_fields: string | null;
}

/** Homepage summary, or null when it cannot be read or has nothing usable. */
async function readWebsite(url: string): Promise<PageSummary | null> {
  try {
    const res = await safeFetch(url, { expect: 'html', timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES });
    if (res.status < 200 || res.status >= 300) return null;
    const page = summarizePage(res.body);
    return hasContent(page) && !isBlockedPage(page) ? page : null;
  } catch {
    return null;
  }
}

async function lineFor(
  lead: LeadRow,
  topic: string,
  pages: Map<string, Promise<PageSummary | null>>,
): Promise<{ line: string; source: 'website' | 'fallback' }> {
  const fields = readFields(lead.custom_fields);
  const company = companyOf(fields);
  const website = websiteFor(fields, lead.email);
  if (website) {
    // Leads of the same company share one download.
    const key = website.toLowerCase();
    if (!pages.has(key)) pages.set(key, readWebsite(website));
    const page = await pages.get(key)!;
    if (page) {
      const messages = buildFirstLineMessages({
        leadFirstName: (typeof fields.first_name === 'string' && fields.first_name) || (lead.name ?? '').split(/\s+/)[0] || '',
        company,
        jobTitle: jobTitleOf(fields),
        website,
        page,
        emailTopic: topic,
      });
      const parsed = parseFirstLine(await completeJson(messages, 0.5), page);
      if (parsed.ok) return { line: parsed.line, source: 'website' };
    }
  }
  return { line: fallbackLine(company), source: 'fallback' };
}

export type StartResult = { ok: true; run: FirstLineRun } | { ok: false; status: number; error: string };

/**
 * Starts the run for a campaign (one at a time per campaign). `overwrite` also rewrites leads that already have
 * a line (lines the user edited by hand are kept unless overwrite is set).
 */
export async function startFirstLines(userId: number, campaignId: number, overwrite: boolean): Promise<StartResult> {
  const current = runs.get(campaignId);
  if (current?.status === 'running') return { ok: true, run: current };
  if (!aiConfigured()) return { ok: false, status: 503, error: 'AI is not set up on this server.' };

  const c = await dbPool.query<{ status: string; email_content: string }>(
    `SELECT status, email_content FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  const campaign = c.rows[0];
  if (!campaign) return { ok: false, status: 404, error: 'Campaign not found' };
  if (campaign.status === 'completed') return { ok: false, status: 409, error: 'This campaign has finished: every email is already sent.' };

  const leads = await dbPool.query<LeadRow>(
    `SELECT id, email, name, custom_fields FROM recipients WHERE campaign_id = $1 AND status = 'pending' ORDER BY id LIMIT $2`,
    [campaignId, MAX_LEADS],
  );
  const todo = leads.rows.filter((l) => {
    if (overwrite) return true;
    const f = readFields(l.custom_fields);
    return !(typeof f[FIRST_LINE_FIELD] === 'string' && (f[FIRST_LINE_FIELD] as string).trim());
  });
  if (!todo.length) {
    return {
      ok: false,
      status: 409,
      error: leads.rows.length ? 'Every lead waiting to be sent already has a first line. Use "Write again" to replace them.' : 'This campaign has no leads waiting to be sent.',
    };
  }

  const run: FirstLineRun = {
    status: 'running',
    total: todo.length,
    done: 0,
    fromWebsite: 0,
    fallback: 0,
    empty: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  runs.set(campaignId, run);
  void execute(campaignId, campaign.email_content, todo, run);
  return { ok: true, run };
}

async function execute(campaignId: number, emailContent: string, todo: LeadRow[], run: FirstLineRun): Promise<void> {
  const topic = emailTopicOf(emailContent);
  const pages = new Map<string, Promise<PageSummary | null>>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const lead = todo[next++];
      if (!lead) return;
      try {
        const { line, source } = await lineFor(lead, topic, pages);
        // Read the row again: the lead may have changed meanwhile (other fields are kept).
        const fresh = await dbPool.query<{ custom_fields: string | null }>(
          `SELECT custom_fields FROM recipients WHERE id = $1 AND status = 'pending'`,
          [lead.id],
        );
        const json = fresh.rows[0] ? withFirstLine(fresh.rows[0].custom_fields, line, source) : null;
        if (json) {
          await dbPool.query(`UPDATE recipients SET custom_fields = $2 WHERE id = $1 AND status = 'pending'`, [lead.id, json]);
          if (!line) run.empty++;
          else if (source === 'website') run.fromWebsite++;
          else run.fallback++;
        } else {
          run.failed++;
        }
      } catch (err) {
        console.warn(`[first-lines] lead ${lead.id} failed:`, (err as Error)?.message ?? err);
        run.failed++;
      }
      run.done++;
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await addFirstLineColumn(campaignId);
    run.status = 'done';
  } catch (err) {
    console.error(`[first-lines] campaign ${campaignId} failed:`, err);
    run.status = 'failed';
    run.error = 'The run stopped. The lines written so far are saved; start it again to finish.';
  }
  run.finishedAt = new Date().toISOString();
}

/** {first_line} passes the placeholder check of the campaign once its leads have the field. */
async function addFirstLineColumn(campaignId: number): Promise<void> {
  const r = await dbPool.query<{ available_columns: string | null }>(`SELECT available_columns FROM campaigns WHERE id = $1`, [campaignId]);
  let cols: string[] = [];
  try {
    const parsed = r.rows[0]?.available_columns ? JSON.parse(r.rows[0].available_columns) : [];
    if (Array.isArray(parsed)) cols = parsed.filter((c): c is string => typeof c === 'string');
  } catch {
    cols = [];
  }
  if (cols.some((c) => c.toLowerCase() === FIRST_LINE_FIELD)) return;
  const json = JSON.stringify([...cols, FIRST_LINE_FIELD]);
  if (json.length > 2000) return;
  await dbPool.query(`UPDATE campaigns SET available_columns = $2 WHERE id = $1`, [campaignId, json]);
}

export interface FirstLineLead {
  recipientId: number;
  email: string;
  name: string | null;
  status: string;
  firstLine: string;
  source: string | null;
}

/** The campaign's leads with their lines (first 500) + whether the email uses {first_line}. */
export async function firstLinesOf(userId: number, campaignId: number) {
  const c = await dbPool.query<{ email_content: string; subject: string }>(
    `SELECT email_content, subject FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId],
  );
  if (!c.rows[0]) return null;
  const r = await dbPool.query<{ id: number; email: string; name: string | null; status: string; custom_fields: string | null }>(
    `SELECT id, email, name, status, custom_fields FROM recipients WHERE campaign_id = $1 ORDER BY id LIMIT 500`,
    [campaignId],
  );
  const leads: FirstLineLead[] = r.rows.map((row) => {
    const f = readFields(row.custom_fields);
    return {
      recipientId: row.id,
      email: row.email,
      name: row.name,
      status: row.status,
      firstLine: typeof f[FIRST_LINE_FIELD] === 'string' ? (f[FIRST_LINE_FIELD] as string) : '',
      source: typeof f[FIRST_LINE_SOURCE_FIELD] === 'string' ? (f[FIRST_LINE_SOURCE_FIELD] as string) : null,
    };
  });
  const usesPlaceholder = /\{\{?\s*first_line\s*\}?\}/i.test(`${c.rows[0].subject} ${c.rows[0].email_content}`);
  return { leads, usesPlaceholder, run: runFor(campaignId) };
}

export type SetLineResult = { ok: true; lead: FirstLineLead } | { ok: false; status: number; error: string };

/** The user edits one lead's line (only leads not sent yet). */
export async function setFirstLine(userId: number, campaignId: number, recipientId: number, rawLine: unknown): Promise<SetLineResult> {
  if (typeof rawLine !== 'string') return { ok: false, status: 400, error: 'Line must be text' };
  const line = rawLine.replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  if (line.length > FIRST_LINE_MAX) return { ok: false, status: 400, error: `Keep the line under ${FIRST_LINE_MAX} characters.` };
  const r = await dbPool.query<{ id: number; email: string; name: string | null; status: string; custom_fields: string | null }>(
    `SELECT rc.id, rc.email, rc.name, rc.status, rc.custom_fields FROM recipients rc JOIN campaigns c ON c.id = rc.campaign_id
      WHERE rc.id = $1 AND rc.campaign_id = $2 AND c.user_id = $3`,
    [recipientId, campaignId, userId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, status: 404, error: 'Lead not found' };
  if (row.status !== 'pending') return { ok: false, status: 409, error: 'This lead was already emailed; the line can no longer change.' };
  const json = withFirstLine(row.custom_fields, line, 'manual');
  if (!json) return { ok: false, status: 400, error: 'This lead has too much data to add a line.' };
  await dbPool.query(`UPDATE recipients SET custom_fields = $2 WHERE id = $1`, [recipientId, json]);
  await addFirstLineColumn(campaignId);
  return { ok: true, lead: { recipientId, email: row.email, name: row.name, status: row.status, firstLine: line, source: 'manual' } };
}
