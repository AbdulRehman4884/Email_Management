/**
 * src/services/campaignCreationJob.service.ts
 *
 * Chat campaign creation, steps 4–5: research every link of every recipient and write one
 * unique email + subject per recipient (EMAIL_WRITER_PROMPT). Runs in the background, so a
 * long list does not time out the chat request; each chat message reads the progress.
 *
 * Every draft goes generate -> normalizeBody() -> validateEmail() (lib/emailRealism.ts). A failed draft is
 * written again with the failed checks as feedback, up to MAX_RETRIES times; after that, or when the writer
 * finds no usable fact ("skip"), the recipient goes to "needs review" and is not saved to the campaign.
 *
 * Storage: Redis when REDIS_URL is set (survives a restart: an unfinished job resumes on the
 * next message), else process memory. One job per user + chat session, kept 2 days.
 */

import { getRedisClient } from "../lib/redisClient.js";
import { createLogger } from "../lib/logger.js";
import { mcpClientService } from "./mcpClient.service.js";
import { getOpenAIService } from "./openai.service.js";
import { EMAIL_REWRITE_PROMPT, EMAIL_WRITER_PROMPT, FOLLOWUP_WRITER_PROMPT } from "../prompts/campaignCreation.prompt.js";
import { recipientKey, type CampaignRecipient, type LinkKind } from "../lib/campaignCreationTable.js";
import { bodyToHtml, firstSentence, isHardIssue, normalizeBody, phraseHits, signoffIn, splitBody, validateEmail, withSignoff, type ValidationContext } from "../lib/emailRealism.js";
import { SPAM_PHRASES } from "../config/emailRealism.config.js";
import type { AuthContext } from "../types/common.js";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const log = createLogger("campaignCreationJob");

const TTL_SECONDS = 2 * 24 * 3600;
const CONCURRENCY = 3;
/** Characters of fetched text per link given to the writer (a website with subpages gets more). */
const RESEARCH_CHARS: Record<LinkKind, number> = { website: 7000, job_post: 6000, linkedin: 3000, other: 3000 };
/** Openings / subjects of other recipients shown to the writer as "avoid". */
const AVOID_LIMIT = 15;
/** A draft that fails the checks is written again this many times, with the failed checks as feedback. */
const MAX_RETRIES = 3;
/** Research text kept per recipient (for rewrites and checks). */
const KEEP_RESEARCH_CHARS = 8000;
const SAVE_EVERY_MS = 1500;

export interface CampaignBrief {
  name: string;
  /** What the campaign is for and what the sender offers (may hold the sender's real results). */
  purpose: string;
  /** First name that signs every email. */
  senderName?: string;
  language: string;
  /** The chosen template's writing structure, once picked (personalize flow: the chosen mode / tone / CTA). */
  structure?: string;
  /** The user's master instruction: paragraphs and words every email keeps (checks use it too). */
  format?: { paragraphs?: { min: number; max: number }; words?: { min: number; max: number } };
  /** The user's own instructions, word for word: they win over every default writing rule. */
  userInstructions?: string;
  /** The user's own words on the subject lines (they win over the default subject rules). */
  subjectInstructions?: string;
  /** KPIs / percentages are allowed as proposed targets (the user asked for them). */
  targetNumbers?: boolean;
  /** The name under the sign-off, exactly as the user gave it (chat campaign creation). */
  signature?: string;
  /** Personalize flow: follow-up emails written after each first email (count = follow-ups, 0 = none). */
  sequence?: { type: string; count: number; breakup: boolean; short: boolean };
}

/** One follow-up of a recipient's sequence (sent in the same thread). */
export interface FollowUpEmail {
  body: string;
  bodyHtml: string;
}

export interface LinkResearch {
  url: string;
  kind: LinkKind;
  ok: boolean;
}

export interface GeneratedEmail {
  email: string;
  subject: string;
  /** Plain-text body: greeting, 2-3 paragraphs, sign-off + name (normalizeBody). */
  body: string;
  /** The HTML part saved for sending: plain <p> per paragraph, <br> in the signature. */
  bodyHtml: string;
  /** The research fact the opening is built on. */
  fact: string;
  /** The prospect's industry and its challenges the email is built on (shown in the review). */
  industry?: string;
  painPoints?: string[];
  /** high: built on a fetched link; medium: on the row's own data. */
  level: "high" | "medium" | "low";
  links: LinkResearch[];
  /** Row fields + fetched link text (kept for rewrites and checks). */
  research: string;
  /** The website's own opening text (tagline / About), for the "do not copy it" check. */
  aboutText?: string;
  /** Set when this recipient needs review: no usable fact, or the checks kept failing. Not saved to the campaign. */
  error?: string;
  /** The checks the last draft failed. */
  issues?: string[];
  /** Personalize flow: the follow-ups of this recipient's sequence. */
  followUps?: FollowUpEmail[];
}

export interface CreationJob {
  status: "ready" | "running" | "done" | "cancelled";
  /**
   * What the last background run did: write the emails, apply a change request to all of them, or
   * (personalize flow) rewrite each recipient's existing email to the chosen settings.
   */
  kind: "generate" | "rewrite" | "restyle" | "followups";
  /** Personalize flow: the email each recipient already has (by recipientKey), the base of "restyle". */
  existing?: Record<string, { subject: string; body: string }>;
  /** Automations: each recipient's uploaded row exactly as saved (by recipientKey), to save it again unchanged. */
  rawFields?: Record<string, { name: string | null; fields: Record<string, string> }>;
  instruction?: string;
  brief?: CampaignBrief;
  recipients: CampaignRecipient[];
  /** By recipientKey (the file row): the same email may be in several rows. */
  results: Record<string, GeneratedEmail>;
  /** Recipients (recipientKey) handled by the current run (rewrite runs count again from 0). */
  doneInRun: string[];
  updatedAt: string;
  /**
   * Chat campaign creation in the background: the draft campaign the emails are saved to as soon as each one is
   * written (save_csv_recipients), the recipients already saved and how many the backend added.
   */
  campaignId?: string;
  savedKeys?: string[];
  savedAdded?: number;
  saveError?: string;
  /** The user confirmed the start while emails were still being written: started as soon as the last one is saved. */
  autoStart?: boolean;
}

// ── Store ────────────────────────────────────────────────────────────────────

const memory = new Map<string, { job: CreationJob; expires: number }>();

export function jobKey(userId: string, sessionId: string): string {
  return `campaign-creation:${userId}:${sessionId}`;
}

export async function loadJob(key: string): Promise<CreationJob | undefined> {
  const live = running.get(key);
  if (live) return live.job;
  const redis = await getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as CreationJob) : undefined;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "loadJob: Redis read failed");
    }
  }
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) return hit.job;
  memory.delete(key);
  return undefined;
}

export async function saveJob(key: string, job: CreationJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(job), "EX", TTL_SECONDS);
      return;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "saveJob: Redis write failed — keeping it in memory");
    }
  }
  memory.set(key, { job, expires: Date.now() + TTL_SECONDS * 1000 });
}

export async function deleteJob(key: string): Promise<void> {
  const live = running.get(key);
  if (live) live.cancelled = true;
  memory.delete(key);
  const redis = await getRedisClient();
  if (redis) await redis.del(key).catch(() => undefined);
}

// ── Background runs ──────────────────────────────────────────────────────────

interface Run {
  job: CreationJob;
  cancelled: boolean;
}

const running = new Map<string, Run>();

export function isRunningHere(key: string): boolean {
  return running.has(key);
}

/** Starts (or resumes after a restart) the background run of this job. */
export function startRun(key: string, job: CreationJob, auth: AuthContext): void {
  if (running.has(key)) return;
  const run: Run = { job, cancelled: false };
  running.set(key, run);
  job.status = "running";
  void execute(key, run, auth)
    .catch((err) => {
      log.error({ key, err: err instanceof Error ? err.message : String(err) }, "campaign creation run failed");
    })
    .finally(() => {
      running.delete(key);
    });
}

export function cancelRun(key: string): void {
  const live = running.get(key);
  if (live) live.cancelled = true;
}

/** A token that expires within this window is renewed before the next recipient. */
const TOKEN_RENEW_BEFORE_MS = 2 * 60 * 1000;
/** Lifetime of a renewed token (same as the backend's short access token). */
const RENEWED_TOKEN_TTL = "15m";

/**
 * Bug 21: access tokens last 15 minutes, but a long list can take longer to write. The user's token was
 * verified when the job started; when it is about to expire, sign a new short token for the SAME user
 * (same claims, same JWT_SECRET as the backend). Otherwise the auth is returned unchanged.
 */
export function freshAuth(auth: AuthContext, now: number = Date.now()): AuthContext {
  const decoded = jwt.decode(auth.rawToken);
  if (!decoded || typeof decoded !== "object") return auth;
  const expMs = typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  if (expMs == null || expMs - now > TOKEN_RENEW_BEFORE_MS) return auth;
  const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = decoded;
  const rawToken = jwt.sign(claims, env.JWT_SECRET, { expiresIn: RENEWED_TOKEN_TTL });
  log.info({ userId: auth.userId }, "campaign creation: renewed the access token for a long run");
  return { ...auth, rawToken };
}

async function execute(key: string, run: Run, auth: AuthContext): Promise<void> {
  const { job } = run;
  // Bug 21: renewed in place when it is about to expire (shared by the parallel workers below).
  let currentAuth = auth;
  const todo = job.recipients.filter((r) => !job.doneInRun.includes(recipientKey(r)));
  let lastSave = 0;
  const persist = async (force = false) => {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    await saveJob(key, job);
  };
  await persist(true);

  let next = 0;
  const worker = async () => {
    while (!run.cancelled) {
      const recipient = todo[next++];
      if (!recipient) return;
      const id = recipientKey(recipient);
      try {
        currentAuth = freshAuth(currentAuth);
        const current = job.results[id];
        job.results[id] =
          job.kind === "rewrite" && current && current.body
            ? await rewriteEmail(current, recipient, job, job.instruction ?? "")
            : job.kind === "restyle"
              ? await restyleEmail(recipient, job, currentAuth)
              : job.kind === "followups"
                ? await followUpsOnly(recipient, job)
                : await writeEmail(recipient, job, currentAuth);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ key, row: recipient.row, err: message }, "campaign creation: recipient failed");
        if (job.kind !== "rewrite") job.results[id] = failed(recipient, "the email could not be written");
      }
      job.doneInRun.push(id);
      if (job.campaignId && !run.cancelled) void saveReady(key, job, currentAuth);
      await persist();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (job.campaignId && !run.cancelled) await saveReady(key, job, currentAuth);
  job.status = run.cancelled ? "cancelled" : "done";
  // Read in the same tick as the status change, so a confirm cannot slip in between (startWhenWritten).
  const autoStart = job.status === "done" && job.autoStart === true;
  await persist(true);
  log.info({ key, status: job.status, done: job.doneInRun.length }, "campaign creation run finished");
  if (autoStart && job.campaignId) await startConfirmed(job, freshAuth(currentAuth));
}

/**
 * The user's confirm arrived while emails were still being written: the run starts the campaign itself when the
 * last one is saved. Returns "later" then, or "now" when nothing is being written (the confirm starts it at once).
 */
export async function startWhenWritten(key: string, auth: AuthContext): Promise<{ when: "now" } | { when: "later"; done: number; total: number }> {
  let job = await currentJob(key);
  if (!job || !job.campaignId || job.status !== "running") return { when: "now" };
  // After a restart the run is resumed here (the confirm carries a fresh token).
  if (!running.has(key)) {
    startRun(key, job, auth);
    job = running.get(key)?.job ?? job;
  }
  // No await between the status check above and this flag: the run reads both in one tick.
  if (job.status !== "running") return { when: "now" };
  job.autoStart = true;
  void saveJob(key, job);
  log.info({ key, campaignId: job.campaignId }, "campaign creation: start confirmed — it starts when every email is written");
  return { when: "later", done: Math.min(job.recipients.length, job.doneInRun.length), total: job.recipients.length };
}

async function startConfirmed(job: CreationJob, auth: AuthContext): Promise<void> {
  if (!job.savedKeys?.length) {
    log.warn({ campaignId: job.campaignId }, "campaign creation: confirmed start skipped — no email could be saved");
    return;
  }
  try {
    const result = await mcpClientService.dispatch("start_campaign", { campaignId: job.campaignId }, auth);
    const data = (result.data ?? {}) as Record<string, unknown>;
    const ok = !result.isToolError && data.success !== false;
    log.info({ campaignId: job.campaignId, ok, data: ok ? undefined : data }, "campaign creation: confirmed start after the last email");
  } catch (err) {
    log.error({ campaignId: job.campaignId, err: err instanceof Error ? err.message : String(err) }, "campaign creation: confirmed start failed");
  }
}

// ── Saving to the draft campaign while the emails are written ────────────────

/** One save at a time per job (the workers and the chat flow both call it). */
const saveChains = new Map<string, Promise<void>>();

/** Every written email not saved yet goes to the job's draft campaign (each recipient with their own subject + email). */
export function saveReady(key: string, job: CreationJob, auth: AuthContext): Promise<void> {
  const next = (saveChains.get(key) ?? Promise.resolve())
    .then(() => flushSaves(key, job, auth))
    .catch((err) => {
      job.saveError = err instanceof Error ? err.message : String(err);
      log.warn({ key, err: job.saveError }, "campaign creation: saving written emails failed");
    });
  saveChains.set(key, next);
  return next;
}

async function flushSaves(key: string, job: CreationJob, auth: AuthContext): Promise<void> {
  if (!job.campaignId) return;
  const saved = new Set(job.savedKeys ?? []);
  const ready = job.recipients.filter((r) => {
    const e = job.results[recipientKey(r)];
    return e && !e.error && e.body && !saved.has(recipientKey(r));
  });
  if (ready.length === 0) return;
  const rows = ready.map((r) => {
    const e = job.results[recipientKey(r)]!;
    return {
      email: r.email,
      ...(r.name ? { name: r.name } : {}),
      ...(r.company ? { company: r.company } : {}),
      ai_subject: e.subject,
      ai_body: e.bodyHtml.replace(/\r?\n/g, " "),
    };
  });
  const result = await mcpClientService.dispatch("save_csv_recipients", { campaignId: job.campaignId, rows, allowDuplicates: true }, auth);
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (result.isToolError || data.success === false) {
    const error = (data.error && typeof data.error === "object" ? data.error : {}) as Record<string, unknown>;
    throw new Error(typeof error.message === "string" ? error.message : "saving the recipients failed");
  }
  const payload = (data.success === true && data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
  job.savedKeys = [...saved, ...ready.map((r) => recipientKey(r))];
  job.savedAdded = (job.savedAdded ?? 0) + (Number(payload.added) || 0);
  delete job.saveError;
  await saveJob(key, job);
}

/** The job as it is now: the running copy (the workers write to it), else the stored one. */
export async function currentJob(key: string): Promise<CreationJob | undefined> {
  return running.get(key)?.job ?? (await loadJob(key));
}

/** Links the job to its draft campaign and saves every email written so far; later ones are saved as they come. */
export async function attachCampaign(key: string, campaignId: string, auth: AuthContext): Promise<CreationJob | undefined> {
  const job = await currentJob(key);
  if (!job) return undefined;
  job.campaignId = campaignId;
  await saveJob(key, job);
  await saveReady(key, job, auth);
  return job;
}

function failed(recipient: CampaignRecipient, error: string): GeneratedEmail {
  return {
    email: recipient.email.toLowerCase(), subject: "", body: "", bodyHtml: "", fact: "", level: "low",
    links: recipient.links.map((l) => ({ ...l, ok: false })), research: "", error,
  };
}

// ── One recipient ────────────────────────────────────────────────────────────

/**
 * A bot check / CAPTCHA / login wall instead of the page (Upwork and Fiverr job pages answer with Cloudflare's
 * "Just a moment..."). Such text is not research: the link counts as failed and is never bypassed.
 */
export function isBlockedPage(title: string, content: string): boolean {
  const text = `${title}\n${content}`.toLowerCase();
  if (/just a moment|attention required|verify you are human|are you a robot|access denied|enable javascript and cookies|checking your browser|captcha/.test(text)) return true;
  // A short page that is mostly a Cloudflare ray id or a sign-in prompt.
  return content.length < 600 && /cloudflare ray id|log ?in to continue|sign in to continue|please log in|join to view/.test(text);
}

/** Text of every link of the recipient (website: homepage + about + services). Failed links are marked, not fatal. */
export async function researchLinks(
  recipient: CampaignRecipient,
  auth: AuthContext,
): Promise<Array<LinkResearch & { content: string }>> {
  const out: Array<LinkResearch & { content: string }> = [];
  for (const link of recipient.links) {
    try {
      const result = await mcpClientService.dispatch(
        "fetch_website_content",
        { url: link.url, includeSubpages: link.kind === "website" },
        auth,
      );
      const data = (result.data ?? {}) as Record<string, unknown>;
      const payload = (data.success === true && data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
      const content = typeof payload.content === "string" ? payload.content.trim() : "";
      const title = typeof payload.title === "string" ? payload.title : "";
      const ok = !result.isToolError && data.success !== false && content.length >= 80 && !isBlockedPage(title, content);
      out.push({ ...link, ok, content: ok ? content.slice(0, RESEARCH_CHARS[link.kind]) : "" });
    } catch (err) {
      log.debug({ url: link.url, err: (err as Error).message }, "researchLinks: fetch failed");
      out.push({ ...link, ok: false, content: "" });
    }
  }
  return out;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** Subjects are plain text: one line, no braces (the backend would read {x} as a placeholder), no trailing period. */
const cleanSubject = (s: string) => {
  const t = s.replace(/[\r\n]+/g, " ").replace(/[{}"]/g, "").replace(/\s+/g, " ").replace(/[.]+$/, "").trim().slice(0, 120);
  // Sentence case: the first letter is always a capital ("invoice workflow at Moore Recovery" → "Invoice workflow at Moore Recovery").
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Everything known about the recipient, as the checks read it: the row's fields + the fetched link text. */
function researchText(recipient: CampaignRecipient, fetched: Array<LinkResearch & { content: string }>): string {
  const row = Object.entries(recipient.fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const links = fetched.filter((r) => r.ok).map((r) => `[${r.kind}] ${r.url}\n${r.content}`).join("\n\n");
  return `${row}\n\n${links}`.slice(0, KEEP_RESEARCH_CHARS);
}

const firstName = (full: string | undefined) => (full ?? "").trim().split(/\s+/)[0] ?? "";

/** The checks' view of this recipient within the job. */
function checkContext(recipient: CampaignRecipient, job: CreationJob, research: string, aboutText: string | undefined): ValidationContext {
  const id = recipientKey(recipient);
  return {
    ...(recipient.firstName ? { recipientFirstName: recipient.firstName } : {}),
    ...(recipient.company ? { recipientCompany: recipient.company } : {}),
    senderFirstName: job.brief?.signature?.trim() || firstName(job.brief?.senderName),
    research,
    ...(aboutText ? { aboutText } : {}),
    senderFacts: job.brief?.purpose ?? "",
    ...(job.brief?.format ? { format: job.brief.format } : {}),
    ...(job.brief?.targetNumbers ? { targetNumbers: true } : {}),
    ...(job.brief?.subjectInstructions ? { subjectFree: true } : {}),
    ...(signoffIn(job.brief?.userInstructions) ? { signoff: signoffIn(job.brief?.userInstructions)! } : {}),
    others: Object.entries(job.results).filter(([k, r]) => k !== id && !r.error && r.body).map(([, r]) => ({ body: r.body, subject: r.subject })),
  };
}

type Draft = { status: "ok"; subject: string; body: string; fact: string; industry?: string; painPoints?: string[] } | { status: "skip"; reason: string };

function readDraft(answer: Record<string, unknown>): Draft {
  if (answer.status === "skip") return { status: "skip", reason: str(answer.reason, 300) || "no specific fact about this recipient" };
  return {
    status: "ok",
    subject: cleanSubject(str(answer.subject, 200)),
    body: normalizeBody(str(answer.body, 4000)),
    fact: str(answer.personalization_fact, 500),
    industry: str(answer.industry, 80),
    painPoints: Array.isArray(answer.pain_points) ? answer.pain_points.map((x) => str(x, 200)).filter(Boolean).slice(0, 3) : [],
  };
}

interface Checked {
  draft?: { subject: string; body: string; fact: string; industry?: string; painPoints?: string[] };
  /** The writer found no usable fact. */
  skip?: string;
  /** The checks the last draft failed (empty = passed). */
  issues: string[];
}

/**
 * generate -> normalize -> validate; written again with the failed checks as feedback up to MAX_RETRIES times.
 * Every attempt is logged (row, attempt, errors, status).
 */
async function draftUntilValid(
  ask: (feedback: string[] | undefined) => Promise<Record<string, unknown>>,
  ctx: ValidationContext,
  logFields: Record<string, unknown>,
): Promise<Checked> {
  let feedback: string[] | undefined;
  // The best attempt (fewest unusable problems, then fewest problems), not just the last one.
  let best: { draft: NonNullable<Checked["draft"]>; errors: string[] } | undefined;
  const score = (errors: string[]) => errors.filter(isHardIssue).length * 100 + errors.length;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const draft = readDraft(await ask(feedback));
    // The user asked for fewer paragraphs than the writer used (it likes a separate closing question): joined here.
    if (draft.status === "ok" && ctx.format?.paragraphs) draft.body = fitParagraphs(draft.body, ctx.format.paragraphs.max);
    // The sign-off the user asked for ("Regards,"), whatever the writer used.
    if (draft.status === "ok" && ctx.signoff) draft.body = withSignoff(draft.body, ctx.signoff);
    if (draft.status === "skip") {
      log.info({ ...logFields, attempt, status: "skip", reason: draft.reason }, "campaign email: writer skipped");
      return { skip: draft.reason, issues: [] };
    }
    const errors = !draft.subject || !draft.body ? ["the answer had no subject or body"] : validateEmail(draft, ctx);
    log.info({ ...logFields, attempt, errors, status: errors.length ? "failed_checks" : "ok" }, "campaign email: attempt checked");
    if (errors.length === 0) return { draft, issues: [] };
    if (!best || score(errors) < score(best.errors)) best = { draft, errors };
    feedback = errors;
  }
  return { ...(best ? { draft: best.draft } : {}), issues: best?.errors ?? feedback ?? [] };
}

/** Extra paragraphs joined into the last allowed one (greeting and signature unchanged). */
export function fitParagraphs(body: string, max: number): string {
  const { greeting, paragraphs, signature } = splitBody(body);
  if (max < 1 || paragraphs.length <= max) return body;
  const kept = [...paragraphs.slice(0, max - 1), paragraphs.slice(max - 1).join(" ")];
  return [greeting, ...kept, signature.join("\n")].filter(Boolean).join("\n\n");
}

const feedbackNote = (feedback: string[] | undefined) =>
  feedback ? { feedback: `Your previous draft failed these checks: ${feedback.join(" | ")}. Fix only these issues.` } : {};

function avoidList(ctx: ValidationContext): Array<{ opening: string; closing: string }> {
  return ctx.others.slice(-AVOID_LIMIT).map((o) => {
    const paras = splitBody(o.body).paragraphs;
    const sentences = (paras[paras.length - 1] ?? "").split(/(?<=[.!?])\s+/);
    return { opening: firstSentence(paras[0] ?? ""), closing: sentences[sentences.length - 1] ?? "" };
  });
}

/** What other prospects already got (problem sentence, KPI percentages): this email must differ. */
function alreadyUsed(job: CreationJob, self: string): Array<{ problem: string; percentages: string[] }> {
  return Object.entries(job.results)
    .filter(([k, r]) => k !== self && !r.error && r.body)
    .slice(-AVOID_LIMIT)
    .map(([, r]) => {
      const first = splitBody(r.body).paragraphs[0] ?? "";
      const sentences = first.split(/(?<=[.!?])\s+/);
      return { problem: sentences[1] ?? sentences[0] ?? "", percentages: r.body.match(/\d+(?:\.\d+)?\s?%/g) ?? [] };
    });
}

/** Industries and pain points already used in this campaign: a different industry must get its own problems. */
function usedPainPoints(job: CreationJob, self: string): Array<{ industry: string; pain_points: string[] }> {
  return Object.entries(job.results)
    .filter(([k, r]) => k !== self && r.industry && r.painPoints?.length)
    .slice(-AVOID_LIMIT)
    .map(([, r]) => ({ industry: r.industry!, pain_points: r.painPoints! }));
}

function toResult(
  recipient: CampaignRecipient,
  checked: Checked,
  base: Pick<GeneratedEmail, "links" | "research" | "aboutText">,
  fetchedText: string,
): GeneratedEmail {
  const email = recipient.email.toLowerCase();
  if (checked.skip !== undefined) {
    return { email, subject: "", body: "", bodyHtml: "", fact: "", level: "low", ...base, error: `no usable fact (${checked.skip})` };
  }
  const d = checked.draft ?? { subject: "", body: "", fact: "" };
  const fromLink = !!d.fact && fetchedText.toLowerCase().includes(d.fact.toLowerCase().slice(0, 40));
  const out: GeneratedEmail = {
    email, subject: d.subject, body: d.body, bodyHtml: d.body ? bodyToHtml(d.body) : "", fact: d.fact,
    ...(d.industry ? { industry: d.industry } : {}),
    ...(d.painPoints?.length ? { painPoints: d.painPoints } : {}),
    level: fromLink ? "high" : d.fact ? "medium" : "low", ...base,
  };
  if (checked.issues.length) {
    out.error = `did not pass the checks after ${MAX_RETRIES + 1} tries`;
    out.issues = checked.issues;
  }
  return out;
}

/** Research + one unique, checked email and subject for this recipient. */
export async function writeEmail(recipient: CampaignRecipient, job: CreationJob, auth: AuthContext): Promise<GeneratedEmail> {
  const openai = getOpenAIService();
  if (!openai) return failed(recipient, "AI is not configured on the server");
  const fetched = await researchLinks(recipient, auth);
  const research = researchText(recipient, fetched);
  const aboutText = fetched.find((r) => r.ok && r.kind === "website")?.content.slice(0, 600);
  const ctx = checkContext(recipient, job, research, aboutText);
  const base = { links: fetched.map(({ content: _content, ...l }) => l), research, ...(aboutText ? { aboutText } : {}) };

  const checked = await draftUntilValid(
    (feedback) =>
      openai.completeJson(
        EMAIL_WRITER_PROMPT,
        JSON.stringify({
          sender: { name: ctx.senderFirstName, offer_and_results: job.brief?.purpose ?? "" },
          ...(job.brief?.userInstructions ? { user_instructions: job.brief.userInstructions } : {}),
          ...(job.brief?.subjectInstructions ? { subject_instructions: job.brief.subjectInstructions } : {}),
          ...(job.brief?.targetNumbers ? { kpi_targets_allowed: true } : {}),
          campaign: { name: job.brief?.name, language: job.brief?.language },
          ...(job.brief?.structure ? { structure: job.brief.structure } : {}),
          recipient: { first_name: recipient.firstName, name: recipient.name, company: recipient.company, ...(recipient.industry ? { industry: recipient.industry } : {}), fields: recipient.fields },
          ...(job.brief?.format ? { format: job.brief.format } : {}),
          research: fetched.map((r) => ({ url: r.url, type: r.kind, fetched: r.ok, content: r.content })),
          avoid: avoidList(ctx),
          other_industries: usedPainPoints(job, recipientKey(recipient)),
          already_used: alreadyUsed(job, recipientKey(recipient)),
          ...feedbackNote(feedback),
        }),
        0.8,
        env.OPENAI_WRITER_MODEL,
      ),
    ctx,
    { row: recipient.row },
  );
  // Only style issues left after the retries: the email is still saved, so every recipient of the file gets one.
  const styleOnly = !!checked.draft && checked.issues.length > 0 && !checked.issues.some(isHardIssue);
  const result = toResult(recipient, styleOnly ? { ...checked, issues: [] } : checked, base, fetched.map((r) => r.content).join("\n"));
  if (styleOnly) {
    result.issues = checked.issues;
    log.info({ row: recipient.row, issues: checked.issues }, "campaign email: saved with style issues only");
  }
  return withFollowUps(result, recipient, job);
}

/**
 * A change request (or a template structure) applied to one email, checked like a new draft.
 * A rewrite that cannot pass keeps the working email and lists why in `issues`.
 */
export async function rewriteEmail(
  current: GeneratedEmail,
  recipient: CampaignRecipient,
  job: CreationJob,
  instruction: string,
): Promise<GeneratedEmail> {
  const openai = getOpenAIService();
  if (!openai || !current.body) return current;
  const ctx = checkContext(recipient, job, current.research, current.aboutText);
  const checked = await draftUntilValid(
    (feedback) =>
      openai.completeJson(
        EMAIL_REWRITE_PROMPT,
        JSON.stringify({
          sender: { first_name: ctx.senderFirstName, offer_and_results: job.brief?.purpose ?? "" },
          change_request: instruction,
          subject: current.subject,
          body: current.body,
          personalization_fact: current.fact,
          ...(current.industry ? { industry: current.industry, pain_points: current.painPoints ?? [] } : {}),
          ...(job.brief?.format ? { format: job.brief.format } : {}),
          ...feedbackNote(feedback),
        }),
        0.6,
        env.OPENAI_WRITER_MODEL,
      ),
    ctx,
    { row: recipient.row, rewrite: true },
  );
  if (checked.skip !== undefined || checked.issues.length) {
    return { ...current, issues: checked.issues.length ? checked.issues : [`the change could not be applied (${checked.skip})`] };
  }
  const base = { links: current.links, research: current.research, ...(current.aboutText ? { aboutText: current.aboutText } : {}) };
  const rewritten = toResult(recipient, checked, base, current.research);
  return withFollowUps(
    {
      ...rewritten,
      level: current.level,
      // The rewrite keeps the prospect's industry analysis.
      ...(rewritten.industry || !current.industry ? {} : { industry: current.industry }),
      ...(rewritten.painPoints?.length || !current.painPoints ? {} : { painPoints: current.painPoints }),
    },
    recipient,
    job,
  );
}

/**
 * Personalize flow: the recipient's existing email rewritten to the chosen settings (job.instruction) and checked
 * like a new draft. Its links are researched again so the checks know the facts; the old email is part of that
 * research (it was written from it). No existing email, or a rewrite that cannot pass → a new email is written.
 */
export async function restyleEmail(recipient: CampaignRecipient, job: CreationJob, auth: AuthContext): Promise<GeneratedEmail> {
  const openai = getOpenAIService();
  if (!openai) return failed(recipient, "AI is not configured on the server");
  const base = job.existing?.[recipientKey(recipient)];
  if (!base?.body.trim()) return writeEmail(recipient, job, auth);

  const fetched = await researchLinks(recipient, auth);
  const research = `${researchText(recipient, fetched)}\n\nEmail they already got:\n${base.subject}\n${base.body}`.slice(0, KEEP_RESEARCH_CHARS + 2000);
  const aboutText = fetched.find((r) => r.ok && r.kind === "website")?.content.slice(0, 600);
  const ctx = checkContext(recipient, job, research, aboutText);
  const checked = await draftUntilValid(
    (feedback) =>
      openai.completeJson(
        EMAIL_REWRITE_PROMPT,
        JSON.stringify({
          sender: { first_name: ctx.senderFirstName, offer_and_results: job.brief?.purpose ?? "" },
          change_request: job.instruction ?? job.brief?.structure ?? "",
          subject: base.subject,
          body: base.body,
          personalization_fact: "",
          recipient: { first_name: recipient.firstName, name: recipient.name, company: recipient.company, fields: recipient.fields },
          research: fetched.filter((r) => r.ok).map((r) => ({ url: r.url, type: r.kind, content: r.content })),
          ...feedbackNote(feedback),
        }),
        0.6,
      ),
    ctx,
    { row: recipient.row, restyle: true },
  );
  if (checked.skip !== undefined || checked.issues.length || !checked.draft) {
    log.info({ row: recipient.row }, "campaign email: restyle did not pass — writing a new email");
    return writeEmail(recipient, job, auth);
  }
  const links = fetched.map(({ content: _content, ...l }) => l);
  return withFollowUps(
    toResult(recipient, checked, { links, research, ...(aboutText ? { aboutText } : {}) }, fetched.map((r) => r.content).join("\n")),
    recipient,
    job,
  );
}

/**
 * Automations (campaign follow-ups): only the follow-ups of a recipient, written from the first email they get
 * (job.existing). The first email itself is not changed. No first email, or follow-ups that keep failing → error.
 */
export async function followUpsOnly(recipient: CampaignRecipient, job: CreationJob): Promise<GeneratedEmail> {
  const base = job.existing?.[recipientKey(recipient)];
  if (!base?.body.trim()) return failed(recipient, "no first email to follow up on");
  const email: GeneratedEmail = {
    email: recipient.email.toLowerCase(), subject: base.subject, body: base.body, bodyHtml: bodyToHtml(base.body),
    fact: "", level: "medium", links: [], research: "",
  };
  const out = await withFollowUps(email, recipient, job);
  const want = job.brief?.sequence?.count ?? 0;
  if ((out.followUps?.length ?? 0) < want) return { ...out, error: "the follow-ups did not pass the checks" };
  return out;
}

// ── Follow-ups (personalize flow) ────────────────────────────────────────────

/** Problems of one follow-up: plain text, greeting, one paragraph, length, sign-off with the sender's name, no spam. */
export function followUpIssues(body: string, senderFirstName: string, short: boolean): string[] {
  const issues: string[] = [];
  const { greeting, paragraphs, signature } = splitBody(body);
  if (!greeting) issues.push('start with a greeting line, e.g. "Hi Ali,"');
  if (paragraphs.length !== 1) issues.push(`write exactly one paragraph (found ${paragraphs.length})`);
  const words = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  const [min, max] = short ? [12, 40] : [18, 70];
  if (words < min || words > max) issues.push(`the paragraph has ${words} words; it must have ${min}–${max}`);
  const signed = signature.length >= 2 && (!senderFirstName || signature.slice(1).some((l) => l.toLowerCase().includes(senderFirstName.toLowerCase())));
  if (!signed) issues.push(`end with "Best," and the sender's first name "${senderFirstName}" on the next line`);
  if (/<\s*[a-z]+[\s>]|\*\*|https?:\/\/|www\.|[{}]|!|\.\.\.|…|\?\?/i.test(body)) issues.push('plain text only: no HTML, markdown, links, braces, "!", "..." or "??"');
  const banned = phraseHits(body, [...SPAM_PHRASES, "just following up", "bumping this", "circling back", "touch base", "reach out"]);
  if (banned.length) issues.push(`remove: ${banned.join(", ")}`);
  return issues;
}

/**
 * Adds the follow-ups to a written first email when the job asks for a sequence. One retry with the problems as
 * feedback; a sequence that still fails is left out (the first email is kept) and the reason is added to `issues`.
 */
async function withFollowUps(email: GeneratedEmail, recipient: CampaignRecipient, job: CreationJob): Promise<GeneratedEmail> {
  const seq = job.brief?.sequence;
  const { followUps: _old, ...rest } = email;
  if (!seq || seq.count < 1 || email.error || !email.body) return rest;
  const openai = getOpenAIService();
  if (!openai) return rest;
  const sender = firstName(job.brief?.senderName);
  let feedback: string[] | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const answer = await openai.completeJson(
        FOLLOWUP_WRITER_PROMPT,
        JSON.stringify({
          sender: { first_name: sender, offer: job.brief?.purpose ?? "" },
          recipient: { first_name: recipient.firstName, name: recipient.name, company: recipient.company, fields: recipient.fields },
          first_email: { subject: email.subject, body: email.body },
          sequence: seq,
          ...(job.brief?.structure ? { style: job.brief.structure } : {}),
          ...(feedback ? { feedback: `Fix these problems: ${feedback.join(" | ")}` } : {}),
        }),
        0.7,
      );
      const list = Array.isArray(answer.followups) ? (answer.followups as Array<Record<string, unknown>>) : [];
      const bodies = list.map((f) => normalizeBody(str(f.body, 2000))).filter(Boolean).slice(0, seq.count);
      const problems =
        bodies.length < seq.count
          ? [`write exactly ${seq.count} follow-ups (got ${bodies.length})`]
          : bodies.flatMap((b, i) => followUpIssues(b, sender, seq.short).map((p) => `follow-up ${i + 1}: ${p}`));
      log.info({ row: recipient.row, attempt, problems }, "campaign email: follow-ups checked");
      if (problems.length === 0) return { ...rest, followUps: bodies.map((b) => ({ body: b, bodyHtml: bodyToHtml(b) })) };
      feedback = problems;
    } catch (err) {
      log.warn({ row: recipient.row, err: (err as Error).message }, "campaign email: follow-ups failed");
      feedback = ["the answer could not be read"];
    }
  }
  return { ...rest, issues: [...(rest.issues ?? []), `follow-ups left out: ${(feedback ?? []).slice(0, 2).join("; ")}`] };
}
