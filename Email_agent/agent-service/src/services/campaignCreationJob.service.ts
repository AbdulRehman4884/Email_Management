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
import type { CampaignRecipient, LinkKind } from "../lib/campaignCreationTable.js";
import { bodyToHtml, firstSentence, normalizeBody, phraseHits, splitBody, validateEmail, type ValidationContext } from "../lib/emailRealism.js";
import { SPAM_PHRASES } from "../config/emailRealism.config.js";
import type { AuthContext } from "../types/common.js";

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
  kind: "generate" | "rewrite" | "restyle";
  /** Personalize flow: the email each recipient already has (by lower-cased email), the base of "restyle". */
  existing?: Record<string, { subject: string; body: string }>;
  instruction?: string;
  brief?: CampaignBrief;
  recipients: CampaignRecipient[];
  /** By lower-cased email. */
  results: Record<string, GeneratedEmail>;
  /** Emails handled by the current run (rewrite runs count again from 0). */
  doneInRun: string[];
  updatedAt: string;
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

async function execute(key: string, run: Run, auth: AuthContext): Promise<void> {
  const { job } = run;
  const todo = job.recipients.filter((r) => !job.doneInRun.includes(r.email.toLowerCase()));
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
      const id = recipient.email.toLowerCase();
      try {
        const current = job.results[id];
        job.results[id] =
          job.kind === "rewrite" && current && current.body
            ? await rewriteEmail(current, recipient, job, job.instruction ?? "")
            : job.kind === "restyle"
              ? await restyleEmail(recipient, job, auth)
              : await writeEmail(recipient, job, auth);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ key, row: recipient.row, err: message }, "campaign creation: recipient failed");
        if (job.kind !== "rewrite") job.results[id] = failed(recipient, "the email could not be written");
      }
      job.doneInRun.push(id);
      await persist();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  job.status = run.cancelled ? "cancelled" : "done";
  await persist(true);
  log.info({ key, status: job.status, done: job.doneInRun.length }, "campaign creation run finished");
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
const cleanSubject = (s: string) =>
  s.replace(/[\r\n]+/g, " ").replace(/[{}"]/g, "").replace(/\s+/g, " ").replace(/[.]+$/, "").trim().slice(0, 120);

/** Everything known about the recipient, as the checks read it: the row's fields + the fetched link text. */
function researchText(recipient: CampaignRecipient, fetched: Array<LinkResearch & { content: string }>): string {
  const row = Object.entries(recipient.fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const links = fetched.filter((r) => r.ok).map((r) => `[${r.kind}] ${r.url}\n${r.content}`).join("\n\n");
  return `${row}\n\n${links}`.slice(0, KEEP_RESEARCH_CHARS);
}

const firstName = (full: string | undefined) => (full ?? "").trim().split(/\s+/)[0] ?? "";

/** The checks' view of this recipient within the job. */
function checkContext(recipient: CampaignRecipient, job: CreationJob, research: string, aboutText: string | undefined): ValidationContext {
  const id = recipient.email.toLowerCase();
  return {
    ...(recipient.firstName ? { recipientFirstName: recipient.firstName } : {}),
    ...(recipient.company ? { recipientCompany: recipient.company } : {}),
    senderFirstName: firstName(job.brief?.senderName),
    research,
    ...(aboutText ? { aboutText } : {}),
    senderFacts: job.brief?.purpose ?? "",
    others: Object.values(job.results).filter((r) => r.email !== id && !r.error && r.body).map((r) => ({ body: r.body })),
  };
}

type Draft = { status: "ok"; subject: string; body: string; fact: string } | { status: "skip"; reason: string };

function readDraft(answer: Record<string, unknown>): Draft {
  if (answer.status === "skip") return { status: "skip", reason: str(answer.reason, 300) || "no specific fact about this recipient" };
  return {
    status: "ok",
    subject: cleanSubject(str(answer.subject, 200)),
    body: normalizeBody(str(answer.body, 4000)),
    fact: str(answer.personalization_fact, 500),
  };
}

interface Checked {
  draft?: { subject: string; body: string; fact: string };
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
  let last: Checked["draft"];
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const draft = readDraft(await ask(feedback));
    if (draft.status === "skip") {
      log.info({ ...logFields, attempt, status: "skip", reason: draft.reason }, "campaign email: writer skipped");
      return { skip: draft.reason, issues: [] };
    }
    last = draft;
    const errors = !draft.subject || !draft.body ? ["the answer had no subject or body"] : validateEmail(draft, ctx);
    log.info({ ...logFields, attempt, errors, status: errors.length ? "failed_checks" : "ok" }, "campaign email: attempt checked");
    if (errors.length === 0) return { draft, issues: [] };
    feedback = errors;
  }
  return { ...(last ? { draft: last } : {}), issues: feedback ?? [] };
}

const feedbackNote = (feedback: string[] | undefined) =>
  feedback ? { feedback: `Your previous draft failed these checks: ${feedback.join(" | ")}. Fix only these issues.` } : {};

function avoidList(ctx: ValidationContext): Array<{ opening: string }> {
  return ctx.others.slice(-AVOID_LIMIT).map((o) => ({ opening: firstSentence(splitBody(o.body).paragraphs[0] ?? "") }));
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
          sender: { first_name: ctx.senderFirstName, offer_and_results: job.brief?.purpose ?? "" },
          campaign: { name: job.brief?.name, language: job.brief?.language },
          ...(job.brief?.structure ? { structure: job.brief.structure } : {}),
          recipient: { first_name: recipient.firstName, name: recipient.name, company: recipient.company, fields: recipient.fields },
          research: fetched.map((r) => ({ url: r.url, type: r.kind, fetched: r.ok, content: r.content })),
          avoid: avoidList(ctx),
          ...feedbackNote(feedback),
        }),
        0.8,
      ),
    ctx,
    { row: recipient.row },
  );
  return withFollowUps(toResult(recipient, checked, base, fetched.map((r) => r.content).join("\n")), recipient, job);
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
          ...feedbackNote(feedback),
        }),
        0.6,
      ),
    ctx,
    { row: recipient.row, rewrite: true },
  );
  if (checked.skip !== undefined || checked.issues.length) {
    return { ...current, issues: checked.issues.length ? checked.issues : [`the change could not be applied (${checked.skip})`] };
  }
  const base = { links: current.links, research: current.research, ...(current.aboutText ? { aboutText: current.aboutText } : {}) };
  return withFollowUps({ ...toResult(recipient, checked, base, current.research), level: current.level }, recipient, job);
}

/**
 * Personalize flow: the recipient's existing email rewritten to the chosen settings (job.instruction) and checked
 * like a new draft. Its links are researched again so the checks know the facts; the old email is part of that
 * research (it was written from it). No existing email, or a rewrite that cannot pass → a new email is written.
 */
export async function restyleEmail(recipient: CampaignRecipient, job: CreationJob, auth: AuthContext): Promise<GeneratedEmail> {
  const openai = getOpenAIService();
  if (!openai) return failed(recipient, "AI is not configured on the server");
  const base = job.existing?.[recipient.email.toLowerCase()];
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
