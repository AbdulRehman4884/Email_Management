/**
 * Lead Engine API (use case UC-01, UC-02, UC-10, UC-11). Mounted at /api/lead-gen behind authMiddleware and
 * requireLeadGen (LEADGEN_ENABLED switch + plans.lead_gen_enabled). Shapes: lib/leadgen/types.ts.
 * Every query is scoped to req.user.id: another user's search / schedule / run / lead answers 404.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dbPool } from '../lib/db.js';
import { dailyLeadLimit } from '../lib/leadgen/access.js';
import { CATEGORIES, getCategory, resolveCategory } from '../lib/leadgen/categories.js';
import { focusFromPhrase, splitFocusList } from '../lib/leadgen/focus.js';
import { countActiveRuns, countLeadsFoundToday, MAX_ACTIVE_SEARCHES, MAX_CONCURRENT_RUNS } from '../lib/leadgen/leadStore.js';
import { computeNextRunAt, DEFAULT_TIMEZONE, isValidTimezone, localDateOf, maskToWeekdays, normalizeLocalTime, weekdaysToMask } from '../lib/leadgen/schedule.js';
import { startRun } from '../lib/leadgen/scheduler.js';
import { cancelRun } from '../lib/leadgen/taskQueue.js';
import {
  addLeadsToCampaign, CampaignNotEditableError, getLeadDetail, listLeads, saveLeadsToCrm, setLeadStatus,
} from '../lib/leadgen/workspace.js';
import type { RunDto, SavedSearchDto, ScheduleDto, Weekday } from '../lib/leadgen/types.js';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const id = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const uid = (req: Request) => req.user!.id;

function bad(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
}

// ── DTO mapping ──────────────────────────────────────────────────────────────

interface ScheduleRow {
  id: number;
  saved_search_id: number;
  frequency: 'daily' | 'weekly';
  run_at_local: string;
  timezone: string;
  weekdays_mask: number;
  next_run_at: string | null;
  last_run_at: string | null;
  is_paused: boolean;
  consecutive_failures: number;
}

function scheduleDto(s: ScheduleRow): ScheduleDto {
  return {
    id: s.id, savedSearchId: s.saved_search_id, frequency: s.frequency, runAtLocal: String(s.run_at_local).slice(0, 5), timezone: s.timezone,
    weekdays: maskToWeekdays(s.weekdays_mask), nextRunAt: s.next_run_at, lastRunAt: s.last_run_at, isPaused: s.is_paused,
    consecutiveFailures: s.consecutive_failures,
  };
}

const SEARCH_SELECT = `
  SELECT ss.*, row_to_json(sch.*) AS schedule
    FROM saved_searches ss LEFT JOIN search_schedules sch ON sch.saved_search_id = ss.id`;

function searchDto(r: Record<string, unknown>): SavedSearchDto {
  return {
    id: r.id as number, name: r.name as string, category: (r.category as string | null) ?? null, keywords: (r.keywords as string[]) ?? [],
    city: (r.city as string | null) ?? null, region: (r.region as string | null) ?? null, countryCode: (r.country_code as string | null)?.trim() ?? null,
    includePeople: r.include_people as boolean, targetPerRun: r.target_per_run as number, isActive: r.is_active as boolean,
    createdAt: r.created_at as string, schedule: r.schedule ? scheduleDto(r.schedule as ScheduleRow) : null,
  };
}

function runDto(r: Record<string, unknown>): RunDto {
  return {
    id: r.id as number, savedSearchId: (r.saved_search_id as number | null) ?? null, scheduleId: (r.schedule_id as number | null) ?? null,
    runDate: String(r.run_date).slice(0, 10), runType: r.run_type as RunDto['runType'], status: r.status as RunDto['status'],
    stats: (r.stats as RunDto['stats']) ?? {}, startedAt: (r.started_at as string | null) ?? null, completedAt: (r.completed_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

async function ownSearch(userId: number, searchId: number) {
  return (await dbPool.query(`${SEARCH_SELECT} WHERE ss.id = $1 AND ss.user_id = $2`, [searchId, userId])).rows[0] as Record<string, unknown> | undefined;
}

/** The user's timezone: from their schedules, else Asia/Karachi. */
async function userTimezone(userId: number): Promise<string> {
  const r = await dbPool.query<{ timezone: string }>(
    `SELECT sch.timezone FROM search_schedules sch JOIN saved_searches ss ON ss.id = sch.saved_search_id WHERE ss.user_id = $1 ORDER BY sch.id DESC LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.timezone ?? DEFAULT_TIMEZONE;
}

// ── Usage / categories ───────────────────────────────────────────────────────

export async function getUsage(req: Request, res: Response) {
  const userId = uid(req);
  const tz = typeof req.query.timezone === 'string' && isValidTimezone(req.query.timezone) ? req.query.timezone : await userTimezone(userId);
  const [today, limit, runs, active] = await Promise.all([
    countLeadsFoundToday(userId, tz),
    dailyLeadLimit(userId),
    countActiveRuns(userId),
    dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM saved_searches WHERE user_id = $1 AND is_active`, [userId]),
  ]);
  res.json({
    leadsToday: today, dailyLimit: limit, activeSearches: active.rows[0]?.n ?? 0, maxSearches: MAX_ACTIVE_SEARCHES,
    runningRuns: runs.running, queuedRuns: runs.queued, maxConcurrentRuns: MAX_CONCURRENT_RUNS, timezone: tz,
  });
}

export function getCategories(_req: Request, res: Response) {
  res.json({ categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label })) });
}

// ── Saved searches ───────────────────────────────────────────────────────────

const CreateSearchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(100).nullish(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  /** What the companies should do within the category: "AI automation, chatbots". Stored as keywords. */
  focus: z.string().trim().max(300).optional(),
  city: z.string().trim().min(2).max(120),
  region: z.string().trim().max(120).nullish(),
  countryCode: z.string().trim().length(2).nullish(),
  includePeople: z.boolean().optional(),
  targetPerRun: z.number().int().min(1).max(100).optional(),
});

export async function listSearches(req: Request, res: Response) {
  const r = await dbPool.query(`${SEARCH_SELECT} WHERE ss.user_id = $1 ORDER BY ss.created_at DESC, ss.id DESC`, [uid(req)]);
  res.json({ searches: r.rows.map(searchDto) });
}

export async function createSearch(req: Request, res: Response) {
  const parsed = CreateSearchSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const b = parsed.data;
  const userId = uid(req);
  // "dental clinics" -> category dentist. No match: keyword-only search with the words as typed (UC-01).
  const category = getCategory(b.category ?? undefined) ?? resolveCategory(b.category ?? b.keywords?.join(' '));
  // "IT companies working on AI automation" -> category it_company + focus "AI automation" (chat sends one phrase).
  const phraseFocus = category && b.category && !getCategory(b.category) ? focusFromPhrase(b.category, category) : '';
  const keywords = [...new Set([
    ...(b.keywords ?? []),
    ...splitFocusList(b.focus),
    ...(phraseFocus ? [phraseFocus] : []),
    ...(!category && b.category ? [b.category] : []),
  ])].slice(0, 10);
  if (!category && keywords.length === 0) return res.status(400).json({ error: 'Give a business category or at least one keyword.' });
  const active = (await dbPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM saved_searches WHERE user_id = $1 AND is_active`, [userId])).rows[0]?.n ?? 0;
  if (active >= MAX_ACTIVE_SEARCHES) {
    return res.status(429).json({ error: `You already have ${MAX_ACTIVE_SEARCHES} active lead searches. Pause or delete one first.`, code: 'LEADGEN_SEARCH_LIMIT' });
  }
  const label = category?.label ?? keywords[0]!;
  const city = b.city.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
  // Default name says what makes this search different (category, city, focus) and is unique for the user:
  // "IT and software companies in Lahore — app development", then " #2", " #3" for repeats.
  const focusText = category && keywords.length ? ` — ${keywords.join(', ')}` : '';
  const baseName = (b.name ?? `${label.charAt(0).toUpperCase()}${label.slice(1)} in ${city}${focusText}`).slice(0, 110);
  const taken = new Set(
    (await dbPool.query<{ name: string }>(`SELECT name FROM saved_searches WHERE user_id = $1 AND (name = $2 OR name LIKE $3)`, [userId, baseName, `${baseName} #%`]))
      .rows.map((r) => r.name)
  );
  let name = baseName;
  for (let n = 2; taken.has(name); n++) name = `${baseName} #${n}`;
  const ins = await dbPool.query<{ id: number }>(
    `INSERT INTO saved_searches (user_id, name, category, keywords, city, region, country_code, include_people, target_per_run)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id`,
    [userId, name, category?.key ?? null, JSON.stringify(keywords), city, b.region ?? null, b.countryCode?.toUpperCase() ?? null, b.includePeople ?? false, b.targetPerRun ?? 20]
  );
  res.status(201).json(searchDto((await ownSearch(userId, ins.rows[0]!.id))!));
}

const UpdateSearchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** New focus ("" clears it). Only for searches with a category. */
  focus: z.string().trim().max(300).optional(),
  includePeople: z.boolean().optional(),
  targetPerRun: z.number().int().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
});

export async function updateSearch(req: Request, res: Response) {
  const searchId = id(req.params.id);
  const parsed = UpdateSearchSchema.safeParse(req.body);
  if (!searchId) return res.status(404).json({ error: 'Not found' });
  if (!parsed.success) return bad(res, parsed.error);
  const b = parsed.data;
  const r = await dbPool.query(
    `UPDATE saved_searches SET name = COALESCE($3, name), include_people = COALESCE($4, include_people),
            target_per_run = COALESCE($5, target_per_run), is_active = COALESCE($6, is_active),
            keywords = CASE WHEN $7::jsonb IS NOT NULL AND category IS NOT NULL THEN $7::jsonb ELSE keywords END, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [searchId, uid(req), b.name ?? null, b.includePeople ?? null, b.targetPerRun ?? null, b.isActive ?? null,
      b.focus === undefined ? null : JSON.stringify(splitFocusList(b.focus))]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json(searchDto((await ownSearch(uid(req), searchId))!));
}

/** Deleting a search keeps the leads it found (workspace_leads.saved_search_id becomes null). A running run finishes. */
export async function deleteSearch(req: Request, res: Response) {
  const searchId = id(req.params.id);
  const r = searchId ? await dbPool.query(`DELETE FROM saved_searches WHERE id = $1 AND user_id = $2`, [searchId, uid(req)]) : null;
  if (!r?.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}

/** "Run now" (UC-01 step 5, UC-11): counts towards today's quota; max 2 runs at once. */
export async function runSearchNow(req: Request, res: Response) {
  const userId = uid(req);
  const searchId = id(req.params.id);
  const search = searchId ? await ownSearch(userId, searchId) : undefined;
  if (!search) return res.status(404).json({ error: 'Not found' });
  const runs = await countActiveRuns(userId);
  if (runs.running + runs.queued >= MAX_CONCURRENT_RUNS) {
    return res.status(429).json({ error: `You already have ${MAX_CONCURRENT_RUNS} lead searches running. Try again when one finishes.`, code: 'LEADGEN_RUN_LIMIT' });
  }
  const tz = (search.schedule as ScheduleRow | null)?.timezone ?? (await userTimezone(userId));
  const limit = await dailyLeadLimit(userId);
  if ((await countLeadsFoundToday(userId, tz)) >= limit) {
    return res.status(429).json({ error: `Today's limit of ${limit} new leads is reached. Runs continue tomorrow.`, code: 'LEADGEN_DAILY_LIMIT' });
  }
  const ins = await dbPool.query<{ id: number }>(
    `INSERT INTO scrape_runs (user_id, saved_search_id, run_date, run_type, status) VALUES ($1, $2, $3, 'manual', 'queued') RETURNING id`,
    [userId, searchId, localDateOf(new Date(), tz)]
  );
  const runId = ins.rows[0]!.id;
  await startRun(runId).catch(() => false);
  const run = (await dbPool.query(`SELECT * FROM scrape_runs WHERE id = $1`, [runId])).rows[0];
  res.status(201).json(runDto(run));
}

// ── Schedules ────────────────────────────────────────────────────────────────

const TimeString = z.string().trim().refine((v) => normalizeLocalTime(v) !== null, 'use HH:MM');
const Timezone = z.string().trim().refine(isValidTimezone, 'unknown timezone');
const Weekdays = z.array(z.enum(WEEKDAYS)).min(1).max(7);

const UpsertScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly']).optional(),
  runAtLocal: TimeString,
  timezone: Timezone.optional(),
  weekdays: Weekdays.optional(),
});

export async function upsertSchedule(req: Request, res: Response) {
  const userId = uid(req);
  const searchId = id(req.params.id);
  const parsed = UpsertScheduleSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const search = searchId ? await ownSearch(userId, searchId) : undefined;
  if (!search) return res.status(404).json({ error: 'Not found' });
  const b = parsed.data;
  const frequency = b.frequency ?? (b.weekdays ? 'weekly' : 'daily');
  const timing = {
    frequency, runAtLocal: normalizeLocalTime(b.runAtLocal)!, timezone: b.timezone ?? (await userTimezone(userId)),
    weekdaysMask: frequency === 'weekly' ? weekdaysToMask(b.weekdays as Weekday[] | undefined) : 127,
  };
  const next = computeNextRunAt(timing, new Date());
  const r = await dbPool.query<ScheduleRow>(
    `INSERT INTO search_schedules (saved_search_id, frequency, run_at_local, timezone, weekdays_mask, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (saved_search_id) DO UPDATE SET frequency = EXCLUDED.frequency, run_at_local = EXCLUDED.run_at_local,
       timezone = EXCLUDED.timezone, weekdays_mask = EXCLUDED.weekdays_mask, next_run_at = EXCLUDED.next_run_at,
       is_paused = false, consecutive_failures = 0
     RETURNING *`,
    [searchId, frequency, timing.runAtLocal, timing.timezone, timing.weekdaysMask, next.toISOString()]
  );
  await dbPool.query(`UPDATE saved_searches SET is_active = true, updated_at = now() WHERE id = $1`, [searchId]);
  res.json(scheduleDto(r.rows[0]!));
}

export async function listSchedules(req: Request, res: Response) {
  const r = await dbPool.query<ScheduleRow & { search_name: string }>(
    `SELECT sch.*, ss.name AS search_name FROM search_schedules sch JOIN saved_searches ss ON ss.id = sch.saved_search_id
      WHERE ss.user_id = $1 ORDER BY sch.next_run_at NULLS LAST`,
    [uid(req)]
  );
  res.json({ schedules: r.rows.map((s) => ({ ...scheduleDto(s), searchName: s.search_name })) });
}

const UpdateScheduleSchema = z.object({
  isPaused: z.boolean().optional(),
  frequency: z.enum(['daily', 'weekly']).optional(),
  runAtLocal: TimeString.optional(),
  timezone: Timezone.optional(),
  weekdays: Weekdays.optional(),
});

/** Pause / resume / change time. A run already going is not cancelled (UC-11). */
export async function updateSchedule(req: Request, res: Response) {
  const scheduleId = id(req.params.id);
  const parsed = UpdateScheduleSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const cur = scheduleId
    ? (await dbPool.query<ScheduleRow>(
        `SELECT sch.* FROM search_schedules sch JOIN saved_searches ss ON ss.id = sch.saved_search_id WHERE sch.id = $1 AND ss.user_id = $2`,
        [scheduleId, uid(req)]
      )).rows[0]
    : undefined;
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = parsed.data;
  const frequency = b.frequency ?? (b.weekdays ? 'weekly' : cur.frequency);
  const timing = {
    frequency,
    runAtLocal: b.runAtLocal ? normalizeLocalTime(b.runAtLocal)! : String(cur.run_at_local),
    timezone: b.timezone ?? cur.timezone,
    weekdaysMask: b.weekdays ? weekdaysToMask(b.weekdays as Weekday[]) : frequency === 'daily' ? 127 : cur.weekdays_mask,
  };
  const isPaused = b.isPaused ?? cur.is_paused;
  const timingChanged = b.runAtLocal !== undefined || b.timezone !== undefined || b.weekdays !== undefined || b.frequency !== undefined;
  const resumed = cur.is_paused && !isPaused;
  const next = timingChanged || resumed ? computeNextRunAt(timing, new Date()).toISOString() : cur.next_run_at;
  const r = await dbPool.query<ScheduleRow>(
    `UPDATE search_schedules SET frequency = $2, run_at_local = $3, timezone = $4, weekdays_mask = $5, is_paused = $6, next_run_at = $7,
            consecutive_failures = CASE WHEN $8 THEN 0 ELSE consecutive_failures END
      WHERE id = $1 RETURNING *`,
    [scheduleId, frequency, timing.runAtLocal, timing.timezone, timing.weekdaysMask, isPaused, next, resumed]
  );
  res.json(scheduleDto(r.rows[0]!));
}

export async function deleteSchedule(req: Request, res: Response) {
  const scheduleId = id(req.params.id);
  const r = scheduleId
    ? await dbPool.query(
        `DELETE FROM search_schedules sch USING saved_searches ss WHERE sch.id = $1 AND ss.id = sch.saved_search_id AND ss.user_id = $2`,
        [scheduleId, uid(req)]
      )
    : null;
  if (!r?.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export async function listRuns(req: Request, res: Response) {
  const searchId = id(req.query.savedSearchId);
  const limit = Math.min(100, id(req.query.limit) ?? 20);
  const r = await dbPool.query(
    `SELECT * FROM scrape_runs WHERE user_id = $1 AND ($2::int IS NULL OR saved_search_id = $2) ORDER BY created_at DESC, id DESC LIMIT $3`,
    [uid(req), searchId, limit]
  );
  res.json({ runs: r.rows.map(runDto) });
}

export async function getRun(req: Request, res: Response) {
  const runId = id(req.params.id);
  const r = runId ? (await dbPool.query(`SELECT * FROM scrape_runs WHERE id = $1 AND user_id = $2`, [runId, uid(req)])).rows[0] : undefined;
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(runDto(r));
}

export async function cancelRunHandler(req: Request, res: Response) {
  const runId = id(req.params.id);
  if (!runId) return res.status(404).json({ error: 'Not found' });
  const exists = (await dbPool.query(`SELECT status FROM scrape_runs WHERE id = $1 AND user_id = $2`, [runId, uid(req)])).rows[0];
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const ok = await cancelRun(runId, uid(req));
  if (!ok) return res.status(409).json({ error: `This run is already ${exists.status}.` });
  res.json({ ok: true });
}

// ── Leads ────────────────────────────────────────────────────────────────────

const csv = (v: unknown) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const flag = (v: unknown) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : undefined);

export async function listLeadsHandler(req: Request, res: Response) {
  const tiers = csv(req.query.tier)?.filter((t): t is 'hot' | 'warm' | 'cold' => ['hot', 'warm', 'cold'].includes(t));
  const statuses = csv(req.query.status)?.filter((s): s is 'new' | 'reviewed' | 'saved_to_crm' | 'in_campaign' | 'rejected' =>
    ['new', 'reviewed', 'saved_to_crm', 'in_campaign', 'rejected'].includes(s));
  const userId = uid(req);
  const result = await listLeads(userId, {
    savedSearchId: id(req.query.savedSearchId) ?? undefined,
    foundToday: flag(req.query.foundToday),
    tiers: tiers?.length ? tiers : undefined,
    statuses: statuses?.length ? statuses : undefined,
    hasEmail: flag(req.query.hasEmail),
    hasDecisionMaker: flag(req.query.hasDecisionMaker),
    matchesFocus: flag(req.query.matchesFocus),
    q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined,
    limit: id(req.query.limit) ?? 25,
    page: id(req.query.page) ?? 1,
    timezone: await userTimezone(userId),
  });
  res.json(result);
}

export async function getLeadHandler(req: Request, res: Response) {
  const leadId = id(req.params.id);
  const detail = leadId ? await getLeadDetail(uid(req), leadId) : null;
  if (!detail) return res.status(404).json({ error: 'Not found' });
  res.json(detail);
}

const LeadIdsSchema = z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(500) });

export async function rejectLeads(req: Request, res: Response) {
  const parsed = LeadIdsSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  res.json({ updated: await setLeadStatus(uid(req), parsed.data.leadIds, 'rejected') });
}

export async function reviewLeads(req: Request, res: Response) {
  const parsed = LeadIdsSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  res.json({ updated: await setLeadStatus(uid(req), parsed.data.leadIds, 'reviewed') });
}

export async function saveToCrm(req: Request, res: Response) {
  const parsed = LeadIdsSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  res.json(await saveLeadsToCrm(uid(req), parsed.data.leadIds));
}

const AddToCampaignSchema = LeadIdsSchema.extend({ campaignId: z.number().int().positive() });

export async function addToCampaign(req: Request, res: Response) {
  const parsed = AddToCampaignSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  try {
    res.json(await addLeadsToCampaign(uid(req), parsed.data.leadIds, parsed.data.campaignId));
  } catch (err) {
    if (err instanceof CampaignNotEditableError) return res.status(err.status === null ? 404 : 409).json({ error: err.message });
    throw err;
  }
}
