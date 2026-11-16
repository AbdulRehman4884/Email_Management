/**
 * src/lib/campaignCreationFlow.ts
 *
 * Chat campaign creation ("create campaign"), in the user's fixed order:
 *   1. "create campaign"        → the flow starts
 *   2. campaign name            → asked
 *   3. recipient file           → asked (📎, .csv / .xlsx / .xls)
 *   4. file read row by row (every column; structured or not), every link of every row researched
 *      (company website pages, job posts, LinkedIn, other links) → one unique email per recipient
 *   5. one subject per recipient, written from that recipient's own email → review / change / regenerate
 *   6. template (a writing structure, not a design): what the campaign is about → suggested + default
 *      structures → pick / describe / change; every email is rewritten to it and checked again
 *   7. schedule: now or a date and time
 *   8. confirmation: summary + approval card → start (or schedule) the campaign
 *
 * How every recipient gets their own email without a backend change: each recipient row is saved
 * with two extra columns, ai_subject and ai_body. The campaign subject is {{ai_subject}} and its body is
 * only {{ai_body}}; the backend fills both from each recipient's row when sending. Every email is a plain
 * 1-to-1 email (lib/emailRealism.ts): greeting, 2–3 short paragraphs, one question, sign-off with a first name.
 *
 * Before step 4 the flow asks one question — what the campaign is for and what the sender offers —
 * because a personalized email has to connect the recipient's needs to the sender's offer.
 */

import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { AuthContext } from "../types/common.js";
import { asUserId } from "../types/common.js";
import { mcpClientService } from "../services/mcpClient.service.js";
import { getOpenAIService } from "../services/openai.service.js";
import {
  COLUMN_READER_PROMPT,
  SCHEDULE_PARSE_PROMPT,
  TEMPLATE_SUGGEST_PROMPT,
} from "../prompts/campaignCreation.prompt.js";
import { guessLayout, layoutFromLlm, recipientsFromTable, type CampaignRecipient } from "./campaignCreationTable.js";
import {
  BODY_PLACEHOLDER,
  CAMPAIGN_CATEGORIES,
  DEFAULT_TEMPLATES,
  SUBJECT_PLACEHOLDER,
  templateInstruction,
  type CampaignTemplate,
} from "./campaignTemplates.js";
import {
  cancelRun,
  deleteJob,
  isRunningHere,
  jobKey,
  loadJob,
  rewriteEmail,
  saveJob,
  startRun,
  writeEmail,
  type CreationJob,
  type GeneratedEmail,
} from "../services/campaignCreationJob.service.js";
import { liveCampaignCreation, type CampaignCreationState } from "./campaignCreationContext.js";
import { createLogger } from "./logger.js";
import { handlePersonalizeStep, personalizeBrief, savePersonalized, settingsLine } from "./personalizeEmailsFlow.js";
import { resolveToolArgs } from "./toolArgResolver.js";

const log = createLogger("campaignCreationFlow");

/** Recipients researched and written per campaign in chat (time and cost per row). */
export const MAX_RECIPIENTS = 200;

type Obj = Record<string, unknown>;
export type Patch = Partial<AgentGraphStateType>;

const CANCEL_RE = /^(cancel|stop|abort|exit|quit|band karo|band kr do|chhoro|chodo|rehne do|cancel kar do|cancel kr do)\b/i;
const APPROVE_RE =
  /^(approve|approved|ok|okay|yes|yep|sure|confirm|looks good|good|great|perfect|theek|thik|theek hai|sahi|sahi hai|done|next|continue|go ahead|haan|han|ji)\b/i;

// ── Entry points ─────────────────────────────────────────────────────────────

export function isCampaignCreationActive(state: AgentGraphStateType): boolean {
  return liveCampaignCreation(state.campaignCreation) !== undefined;
}

/**
 * "create campaign" (also the chat's "Create campaign" button) starts this flow. The old paths stay for a request that already gives the subject
 * and the body ("create campaign called X, subject Y, body Z").
 */
export function startsCampaignCreation(state: AgentGraphStateType): boolean {
  if (state.intent !== "create_campaign") return false;
  // An AI wizard / campaign draft / sender choice already in progress keeps its own path.
  if (state.pendingAiCampaignStep !== undefined || state.pendingCampaignDraft !== undefined || state.pendingSmtpSelectionAction) return false;
  const args = fromLlm(state);
  const given = (field: "subject" | "body") =>
    (typeof args[field] === "string" && (args[field] as string).trim() !== "") || new RegExp(`\\b${field}\\b`, "i").test(state.userMessage);
  return !(given("subject") && given("body"));
}

/** name / subject / body the LLM read from the request (they come inside its "filters"). */
function fromLlm(state: AgentGraphStateType): Record<string, unknown> {
  return resolveToolArgs("create_campaign", { extractedArgs: state.llmExtractedArgs, activeCampaignId: state.activeCampaignId }) as Record<string, unknown>;
}

export async function handleCampaignCreation(state: AgentGraphStateType): Promise<Patch> {
  const ctx = liveCampaignCreation(state.campaignCreation);
  const msg = state.userMessage.trim();
  const key = jobKey(String(state.userId ?? "unknown"), String(state.sessionId ?? "unknown"));

  if (!ctx) return start(state);

  if (CANCEL_RE.test(msg) && msg.length <= 40 && !state.pendingCsvFile) {
    cancelRun(key);
    await deleteJob(key);
    if (ctx.kind === "personalize") {
      const made = ctx.campaignId ? ` The new draft **${ctx.name ?? ""}** stays as a draft (nothing was sent).` : "";
      return done(`Stopped. **${ctx.source?.name ?? "The campaign"}** was not changed.${made}`, ctx.campaignId ? { activeCampaignId: ctx.campaignId } : {});
    }
    const created = ctx.campaignId
      ? `The draft campaign **${ctx.name ?? ""}** was already created and stays as a draft (nothing was sent).`
      : "Nothing was created.";
    return done(`Campaign creation stopped. ${created}`, ctx.campaignId ? { activeCampaignId: ctx.campaignId } : {});
  }

  // "create campaign" again in the middle of the flow: not an answer.
  if (/^(create|new|start|make)\s+(a\s+)?(new\s+)?campaign$|^(new\s+)?campaign\s+(banao|bana do)$/i.test(msg)) {
    if (ctx.step === "name") return start(state);
    return reply(ctx, `You're already creating **${ctx.name ?? "a campaign"}**. Answer the last question to continue, or say **cancel** to stop it first.`);
  }

  try {
    if (ctx.kind === "personalize") {
      const answered = await handlePersonalizeStep(state, ctx, key, msg);
      if (answered) return answered;
    }
    switch (ctx.step) {
      case "name":
        return askedName(ctx, msg);
      case "file":
        return await receivedFile(state, ctx, key);
      case "purpose":
        return await receivedPurpose(state, ctx, key, msg);
      case "sender":
        return await receivedSender(state, ctx, key, msg);
      case "generating":
        return await whileGenerating(state, ctx, key);
      case "review":
        return await reviewing(state, ctx, key, msg);
      case "template_category":
        return await choseCategory(ctx, key, msg);
      case "template_pick":
        return await pickedTemplate(state, ctx, key, msg);
      case "template_review":
        return await reviewedTemplate(state, ctx, key, msg);
      case "smtp":
        return await choseSmtp(state, ctx, key, msg);
      case "schedule":
        return await chosenSchedule(state, ctx, key, msg);
      default:
        return reply(ctx, "Please answer the last question, or say **cancel** to stop.");
    }
  } catch (err) {
    log.error({ step: ctx.step, err: err instanceof Error ? err.message : String(err) }, "campaign creation step failed");
    return reply(ctx, "Something went wrong in this step. Please try again, or say **cancel** to stop.");
  }
}

// ── Replies ──────────────────────────────────────────────────────────────────

function needsInput(message: string): string {
  return JSON.stringify({ status: "needs_input", intent: "create_campaign", message });
}

export function reply(ctx: CampaignCreationState, message: string, extra: Patch = {}): Patch {
  return {
    intent: "create_campaign",
    toolName: undefined,
    toolArgs: {},
    formattedResponse: needsInput(message),
    campaignCreation: { ...ctx, atIso: new Date().toISOString() },
    ...extra,
  };
}

export function done(message: string, extra: Patch = {}): Patch {
  return {
    intent: "create_campaign",
    toolName: undefined,
    toolArgs: {},
    formattedResponse: JSON.stringify({ status: "success", intent: "create_campaign", message }),
    campaignCreation: undefined,
    ...extra,
  };
}

export function authOf(state: AgentGraphStateType): AuthContext | undefined {
  if (!state.rawToken) return undefined;
  return { userId: state.userId ?? asUserId("unknown"), rawToken: state.rawToken };
}

/** The tool's own payload ({ success, data } envelopes unwrapped), or the backend error message. */
export async function callTool(name: Parameters<typeof mcpClientService.dispatch>[0], args: Obj, auth: AuthContext): Promise<{ ok: true; data: Obj } | { ok: false; code: string; message: string; details: Obj }> {
  const result = await mcpClientService.dispatch(name, args, auth);
  const data = (result.data ?? {}) as Obj;
  if (result.isToolError || data.success === false) {
    const error = (data.error && typeof data.error === "object" ? data.error : {}) as Obj;
    const details = (error.details && typeof error.details === "object" ? error.details : {}) as Obj;
    // The backend's own reason ("Subject is required", "Failed to process file ...") is in details.
    const reason = [details.error, details.message].find((v): v is string => typeof v === "string" && v.trim() !== "");
    const base = typeof error.message === "string" ? error.message : "The request failed.";
    return {
      ok: false,
      code: typeof error.code === "string" ? error.code : "",
      message: reason ? `${reason.trim()} (${base})` : base,
      details,
    };
  }
  const payload = (data.success === true && data.data && typeof data.data === "object" ? data.data : data) as Obj;
  return { ok: true, data: payload };
}

// ── Steps 1–3: start, name, file ─────────────────────────────────────────────

const FILE_QUESTION = [
  "Please upload your recipient file with the 📎 button (**.csv**, **.xlsx** or **.xls**, up to 10 MB).",
  "",
  "Any layout works, with or without headers. I read **every column of every row**: emails, names, companies, roles, notes,",
  "and every link — company websites, job posts (Upwork, Fiverr, LinkedIn Jobs …), LinkedIn profiles — to write each person their own email.",
].join("\n");

function start(state: AgentGraphStateType): Patch {
  const ctx: CampaignCreationState = { step: "name", atIso: new Date().toISOString() };
  const llmName = fromLlm(state).name;
  const named =
    (typeof llmName === "string" && llmName.trim()) ||
    state.userMessage.match(/\b(?:called|named)\s+["“']?(.+?)["”']?\s*$/i)?.[1]?.trim();
  if (named && named.length <= 255) {
    return reply({ ...ctx, step: "file", name: named }, `Campaign name: **${named}**.\n\n${FILE_QUESTION}`, clearOtherFlows());
  }
  return reply(ctx, "Let's create your campaign. **What should the campaign be called?**", clearOtherFlows());
}

/** The old campaign wizards must not answer while this flow runs. */
export function clearOtherFlows(): Patch {
  return {
    pendingCampaignDraft: undefined,
    pendingCampaignStep: undefined,
    pendingAiCampaignStep: undefined,
    pendingAiCampaignData: undefined,
    pendingCsvData: undefined,
    // A contact enrichment left open would take the uploaded file.
    pendingEnrichmentStep: undefined,
    pendingEnrichmentData: undefined,
    pendingEnrichmentAction: undefined,
    pendingOutreachDraft: undefined,
  };
}

function askedName(ctx: CampaignCreationState, msg: string): Patch {
  const name = msg.replace(/^["“']|["”']$/g, "").trim();
  if (!name) return reply(ctx, "**What should the campaign be called?**");
  if (name.length > 255) return reply(ctx, `That name is ${name.length} characters long. Please use at most 255 characters.`);
  return reply({ ...ctx, step: "file", name }, `Campaign name: **${name}**.\n\n${FILE_QUESTION}`);
}

async function receivedFile(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const file = state.pendingCsvFile;
  if (!file) return reply(ctx, `I need the file to continue.\n\n${FILE_QUESTION}`);
  const consumed: Patch = { pendingCsvFile: undefined, pendingCsvData: undefined };
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not read the file.", consumed);

  const read = await callTool("read_table_file", { fileContent: file.fileContent, filename: file.filename }, auth);
  if (!read.ok) return reply(ctx, `${read.message}\n\n${FILE_QUESTION}`, consumed);
  const table = Array.isArray(read.data.table) ? (read.data.table as string[][]) : [];
  if (table.length === 0) return reply(ctx, `The file **${file.filename}** is empty.\n\n${FILE_QUESTION}`, consumed);

  // Column meanings: the LLM reads the first rows (header or not); the values decide when it is unsure.
  let layout = guessLayout(table);
  const openai = getOpenAIService();
  if (openai) {
    try {
      layout = layoutFromLlm(await openai.completeJson(COLUMN_READER_PROMPT, JSON.stringify({ rows: table.slice(0, 8) }), 0), table);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "column reading failed — using the value-based guess");
    }
  }
  const { recipients: all, skipped } = recipientsFromTable(table, layout);
  if (all.length === 0) {
    const why = skipped.slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join("; ");
    return reply(ctx, `I could not find any valid email address in **${file.filename}**${why ? ` (${why})` : ""}.\n\n${FILE_QUESTION}`, consumed);
  }
  const recipients = all.slice(0, MAX_RECIPIENTS);
  const overLimit = all.length - recipients.length;

  const job: CreationJob = { status: "ready", kind: "generate", recipients, results: {}, doneInRun: [], updatedAt: "" };
  await saveJob(key, job);

  const summary = {
    fileName: file.filename,
    totalRows: Number(read.data.totalRows) || table.length,
    recipients: recipients.length,
    skipped: skipped.length,
    skippedSample: skipped.slice(0, 5).map((s) => `row ${s.row}: ${s.reason}`),
    columns: layout.columns.map((c) => `${c.label} (${c.kind.replace(/_/g, " ")})`),
    withLinks: recipients.filter((r) => r.links.length > 0).length,
    overLimit,
  };
  const links = recipients.flatMap((r) => r.links);
  const count = (k: string) => links.filter((l) => l.kind === k).length;
  const lines = [
    `I read **${file.filename}** row by row.`,
    "",
    `- **${recipients.length}** recipients with a valid email`,
    skipped.length ? `- **${skipped.length}** rows skipped (${summary.skippedSample.slice(0, 3).join("; ")}${skipped.length > 3 ? " …" : ""})` : "",
    overLimit ? `- **${overLimit}** more recipients left out: one chat campaign takes up to ${MAX_RECIPIENTS}. Upload the rest in a second campaign.` : "",
    `- Columns: ${summary.columns.slice(0, 8).join(", ")}${summary.columns.length > 8 ? " …" : ""}`,
    `- **${summary.withLinks}** recipients have links to research: ${count("website")} websites, ${count("job_post")} job posts, ${count("linkedin")} LinkedIn, ${count("other")} other`,
    "",
    "One question before I write the emails: **what is this campaign for, and what do you offer?**",
    "For example: *\"I'm a full-stack developer offering to build their app\"* or *\"We sell CRM software for real-estate agencies\"*.",
  ].filter(Boolean);
  return reply({ ...ctx, step: "purpose", file: summary }, lines.join("\n"), consumed);
}

// ── Step 4: research + write (background) ────────────────────────────────────

async function receivedPurpose(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  if (msg.length < 3) return reply(ctx, "Please tell me in a sentence what this campaign is for and what you offer.");
  const purpose = /^skip$/i.test(msg) ? `Inferred from the campaign name "${ctx.name ?? ""}"` : msg.slice(0, 1000);
  const sender = state.senderDefaults?.fromName?.trim();
  // Every email is signed by a person: ask for the name when the account has none.
  if (!sender) {
    return reply({ ...ctx, step: "sender", purpose }, "**What first name should sign the emails?** (e.g. *Bassam*)");
  }
  return startGeneration(state, { ...ctx, purpose, senderName: sender }, key);
}

async function receivedSender(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const name = msg.replace(/^["“']|["”']$/g, "").trim();
  if (!/^[\p{L}][\p{L} .'-]{0,40}$/u.test(name)) return reply(ctx, "Please send just the first name that should sign the emails (e.g. *Bassam*).");
  return startGeneration(state, { ...ctx, senderName: name }, key);
}

export async function startGeneration(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not start writing the emails.");
  const job = await loadJob(key);
  if ((!job || job.recipients.length === 0) && ctx.kind === "personalize") {
    return done("I lost the campaign's recipients (they may have expired). Say **generate personalized emails** to start again.");
  }
  if (!job || job.recipients.length === 0) return reply({ ...ctx, step: "file" }, `I lost the uploaded recipients. Please upload the file again.\n\n${FILE_QUESTION}`);

  job.brief = {
    name: ctx.name ?? "",
    purpose: ctx.purpose ?? "",
    ...(ctx.senderName ? { senderName: ctx.senderName } : {}),
    language: "English, unless the purpose asks for another language",
    ...(ctx.kind === "personalize" ? personalizeBrief(ctx.personalize) : {}),
  };
  job.kind = "generate";
  job.results = {};
  job.doneInRun = [];
  startRun(key, job, auth);
  const minutes = Math.max(1, Math.round((job.recipients.length * 25) / 3 / 60));
  return reply(
    { ...ctx, step: "generating", afterRun: "review" },
    [
      `Got it. I'm now researching every link and writing **one email and subject for each of the ${job.recipients.length} recipients**.`,
      "",
      `This takes about **${minutes} minute${minutes === 1 ? "" : "s"}**. Send any message (e.g. **status**) to see the progress — I'll show you samples as soon as it's done.`,
    ].join("\n"),
  );
}

async function whileGenerating(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  // The agent restarted during the run: continue where it stopped.
  if (job.status === "running" && !isRunningHere(key)) {
    const auth = authOf(state);
    if (auth) startRun(key, job, auth);
  }
  if (job.status === "running" || job.status === "ready") {
    const doneCount = job.doneInRun.length;
    const what = job.kind === "rewrite" ? "Rewriting the emails" : "Researching links and writing the emails";
    return reply(ctx, `${what}: **${doneCount}/${job.recipients.length}** done. Send another message in a bit to check again, or **cancel** to stop.`);
  }
  if (ctx.afterRun === "template_review" && ctx.template) {
    return reply({ ...ctx, step: "template_review" }, await templatePreview(key, ctx.template));
  }
  return reply({ ...ctx, step: "review" }, reviewText(job, job.kind === "rewrite" ? `Your change was applied to all emails.` : "All emails are written.", ctx));
}

// ── Step 5: review emails + subjects ─────────────────────────────────────────

function ordered(job: CreationJob): Array<{ n: number; r: CampaignRecipient; e: GeneratedEmail | undefined }> {
  return job.recipients.map((r, i) => ({ n: i + 1, r, e: job.results[r.email.toLowerCase()] }));
}

/** One email exactly as it will be sent (plain text), quoted. */
function emailBlock(n: number, r: CampaignRecipient, e: GeneratedEmail): string {
  const who = r.name ? `${r.name} — ${r.email}` : r.email;
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const followUps = (e.followUps ?? []).flatMap((f, i) => ["", `**Follow-up ${i + 1}:**`, "", quote(f.body)]);
  return [`**#${n} ${who}**${r.company ? ` (${r.company})` : ""} · personalization: ${e.level}`, `**Subject:** ${e.subject}`, "", quote(e.body), ...followUps].join("\n");
}

/** Why a recipient needs review, and its last draft if there is one. */
function needsReviewBlock(n: number, r: CampaignRecipient, e: GeneratedEmail | undefined): string {
  const why = e?.issues?.length ? e.issues.slice(0, 4).map((i) => `- ${i}`).join("\n") : `- ${e?.error ?? "no email yet"}`;
  return [
    `**#${n} ${r.email} needs review** (${e?.error ?? "no email yet"}). Not saved to the campaign unless fixed:`,
    why,
    e?.body ? `\nLast draft:\n${e.body.split("\n").map((l) => `> ${l}`).join("\n")}` : "",
    `\nSay **regenerate ${n}**, or **${n}: <what to change>**.`,
  ].filter(Boolean).join("\n");
}

/** Three samples from different kinds of recipients (high / medium / low personalization first). */
function sampleIndexes(items: ReturnType<typeof ordered>): number[] {
  const okItems = items.filter((x) => x.e && !x.e.error);
  const picked: number[] = [];
  for (const level of ["high", "medium", "low"] as const) {
    const hit = okItems.find((x) => x.e!.level === level && !picked.includes(x.n));
    if (hit) picked.push(hit.n);
  }
  for (const x of okItems) {
    if (picked.length >= 3) break;
    if (!picked.includes(x.n)) picked.push(x.n);
  }
  return picked.slice(0, 3).sort((a, b) => a - b);
}

const REVIEW_OPTIONS = [
  "**What next?**",
  "- **approve** — keep these emails and choose a template",
  "- **show 7** — see recipient #7's full email · **show all** — list every recipient and subject",
  "- **regenerate 7** — write #7's email again",
  "- **7: make it shorter** — change only #7's email",
  "- or just type a change for **all** emails (e.g. *make them more formal*, *mention our free trial*)",
].join("\n");

/** "Generate personalized emails" saves after the review (no template step). */
function reviewOptions(ctx: CampaignCreationState): string {
  return ctx.kind === "personalize"
    ? REVIEW_OPTIONS.replace("keep these emails and choose a template", "save these emails to a new draft campaign")
    : REVIEW_OPTIONS;
}

function reviewText(job: CreationJob, header: string, ctx?: CampaignCreationState): string {
  const items = ordered(job);
  const ok = items.filter((x) => x.e && !x.e.error);
  const failedItems = items.filter((x) => !x.e || x.e.error);
  const levels = (l: string) => ok.filter((x) => x.e!.level === l).length;
  const links = ok.flatMap((x) => x.e!.links);
  const badLinks = links.filter((l) => !l.ok).length;
  const lines = [
    `${header} Each recipient has their **own email and subject**, written from their row and their links.`,
    "",
    `- **${ok.length}** emails written · personalization: ${levels("high")} high, ${levels("medium")} medium, ${levels("low")} low`,
    links.length ? `- Links researched: **${links.length - badLinks}/${links.length}** opened${badLinks ? ` (${badLinks} could not be opened — blocked, login needed or empty; those emails use the row data)` : ""}` : "- No links in the file — the emails use the row data only",
    failedItems.length
      ? `- **${failedItems.length}** need review (${failedItems.slice(0, 5).map((x) => `#${x.n} ${x.e?.error ? x.e.error.split(" (")[0] : "no email"}`).join("; ")}${failedItems.length > 5 ? " …" : ""}) — say **show N** to see why; they are left out unless fixed`
      : "",
    "",
    "**Samples:**",
    "",
    ...sampleIndexes(items).flatMap((n) => {
      const x = items[n - 1]!;
      return [emailBlock(x.n, x.r, x.e!), ""];
    }),
    ctx ? reviewOptions(ctx) : REVIEW_OPTIONS,
  ].filter((l) => l !== "");
  return lines.join("\n\n").replace(/\n\n(> )/g, "\n$1").replace(/(\*\*Subject:\*\* [^\n]*)\n\n\n?/g, "$1\n\n");
}

async function reviewing(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  const items = ordered(job);
  const at = (n: number) => (n >= 1 && n <= items.length ? items[n - 1] : undefined);

  if (APPROVE_RE.test(msg) && msg.length <= 30) {
    if (!items.some((x) => x.e && !x.e.error)) return reply(ctx, "No email is written yet, so there is nothing to approve. Try **regenerate 1** or type a change.");
    if (ctx.kind === "personalize") return savePersonalized(state, ctx, key);
    return reply({ ...ctx, step: "template_category" }, categoryQuestion(ctx));
  }

  if (/^(show|see|view|list)\s+(all|every)|^all emails$|^sab(\s+\w+)?\s+(dikhao|dikha do)$/i.test(msg)) {
    const lines = items.slice(0, 200).map((x) => `${x.n}. ${x.r.email} — ${x.e && !x.e.error ? x.e.subject : "*(no email)*"}`);
    return reply(ctx, [`**All ${items.length} recipients:**`, "", ...lines, "", "Say **show N** for a full email.", "", reviewOptions(ctx)].join("\n"));
  }

  const show = msg.match(/^(?:show|see|view|open|email)\s*#?(\d{1,4})$/i) ?? msg.match(/^#?(\d{1,4})(?:\s+(?:dikhao|dikha do|show))?$/i);
  if (show) {
    const x = at(Number(show[1]));
    if (!x) return reply(ctx, `There is no recipient #${show[1]}. Choose 1–${items.length}.`);
    if (!x.e || x.e.error) return reply(ctx, [needsReviewBlock(x.n, x.r, x.e), "", reviewOptions(ctx)].join("\n"));
    return reply(ctx, [emailBlock(x.n, x.r, x.e), "", reviewOptions(ctx)].join("\n"));
  }

  const auth = authOf(state);
  const regen =
    msg.match(/^(?:regenerate|redo|rewrite|re-?write|dobara(?:\s+(?:likho|banao))?)\s*#?(\d{1,4})$/i) ??
    msg.match(/^#?(\d{1,4})\s+(?:regenerate|redo|dobara(?:\s*(?:likho|banao|likh do))?)$/i);
  if (regen) {
    const x = at(Number(regen[1]));
    if (!x) return reply(ctx, `There is no recipient #${regen[1]}. Choose 1–${items.length}.`);
    if (!auth) return reply(ctx, "Please sign in again — I could not write the email.");
    job.results[x.r.email.toLowerCase()] = await writeEmail(x.r, job, auth);
    await saveJob(key, job);
    const e = job.results[x.r.email.toLowerCase()]!;
    return reply(ctx, [e.error ? needsReviewBlock(x.n, x.r, e) : `New email for #${x.n}:\n\n${emailBlock(x.n, x.r, e)}`, "", reviewOptions(ctx)].join("\n"));
  }

  const one = msg.match(/^#?(\d{1,4})\s*[:\-–,)]\s*(.{3,})$/) ?? msg.match(/^#?(\d{1,4})\s+(?:ko|ka|ki|wali|wala)\s+(.{3,})$/i);
  if (one) {
    const x = at(Number(one[1]));
    if (!x) return reply(ctx, `There is no recipient #${one[1]}. Choose 1–${items.length}.`);
    if (!x.e?.body) return reply(ctx, `#${x.n} has no draft yet. Say **regenerate ${x.n}** first.`);
    const before = x.e;
    const after = await rewriteEmail(before, x.r, job, one[2]!.trim());
    job.results[x.r.email.toLowerCase()] = after.issues?.length && !before.error ? { ...before } : after;
    await saveJob(key, job);
    if (after.issues?.length && after.body === before.body) {
      return reply(ctx, [`I could not apply that to #${x.n} without breaking the email rules:`, ...after.issues.slice(0, 4).map((i) => `- ${i}`), "", "The email stays as it was.", "", reviewOptions(ctx)].join("\n"));
    }
    return reply(ctx, ["Updated:", "", emailBlock(x.n, x.r, job.results[x.r.email.toLowerCase()]!), "", reviewOptions(ctx)].join("\n"));
  }

  if (msg.length >= 4) {
    if (!auth) return reply(ctx, "Please sign in again — I could not change the emails.");
    job.kind = "rewrite";
    job.instruction = msg.slice(0, 1000);
    job.doneInRun = [];
    startRun(key, job, auth);
    return reply({ ...ctx, step: "generating", afterRun: "review" }, `Applying "**${job.instruction}**" to all ${job.recipients.length} emails (each stays personal and is checked again). Send any message to check the progress.`);
  }
  return reply(ctx, reviewOptions(ctx));
}

// ── Step 6: template ─────────────────────────────────────────────────────────

function guessCategory(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/\b(job|proposal|upwork|fiverr|freelanc|hire|hiring|developer|offering to build|services?)\b/.test(t)) return "Job / Proposal";
  if (/\b(discount|offer|sale|promo|deal|% off)\b/.test(t)) return "Promotion";
  if (/\b(event|webinar|meetup|conference|invite)\b/.test(t)) return "Event";
  if (/\b(newsletter|monthly update|digest)\b/.test(t)) return "Newsletter";
  if (/\b(launch|announce|new feature|introducing)\b/.test(t)) return "Announcement";
  if (/\b(follow[\s-]?up|check in|reconnect)\b/.test(t)) return "Follow-up";
  return undefined;
}

function categoryQuestion(ctx: CampaignCreationState): string {
  const guess = guessCategory(`${ctx.purpose ?? ""} ${ctx.name ?? ""}`);
  return [
    "Emails approved. Now the **template** (how each email is laid out — the text stays personal).",
    "",
    "**What is this campaign related to?**",
    ...CAMPAIGN_CATEGORIES.map((c, i) => `${i + 1}. ${c}${c === guess ? " ← my guess from your purpose" : ""}`),
    "",
    "Reply with the number or the name.",
  ].join("\n");
}

async function choseCategory(ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const n = Number(msg.match(/^#?(\d)\b/)?.[1]);
  const byName = CAMPAIGN_CATEGORIES.find((c) => c.toLowerCase().split(/[\s/]+/).some((w) => w.length > 2 && msg.toLowerCase().includes(w)));
  const category = (n >= 1 && n <= CAMPAIGN_CATEGORIES.length ? CAMPAIGN_CATEGORIES[n - 1] : undefined) ?? byName ?? (msg.length >= 3 ? msg.slice(0, 80) : undefined);
  if (!category) return reply(ctx, categoryQuestion(ctx));

  const suggested = await suggestTemplates(ctx, category, key);
  const choices = [...suggested, ...DEFAULT_TEMPLATES];
  const lines = [
    `Campaign type: **${category}**. Templates you can use:`,
    "",
    ...choices.map((t, i) => `${i + 1}. **${t.name}**${t.reason ? ` — ${t.reason}` : ""}${i < suggested.length ? " *(suggested for this campaign)*" : i === suggested.length ? " *(default templates from here)*" : ""}`),
    "",
    "Reply with a **number**, or **describe your own structure** (e.g. *start with their project, then one past project of mine, ask for a call*),",
    "or a number with changes (e.g. *2 but shorter*).",
  ];
  return reply({ ...ctx, step: "template_pick", category, templateChoices: choices }, lines.join("\n"));
}

async function suggestTemplates(ctx: CampaignCreationState, category: string, key: string): Promise<CampaignTemplate[]> {
  const openai = getOpenAIService();
  if (!openai) return [];
  const job = await loadJob(key);
  const sample = job
    ? Object.values(job.results).filter((e) => !e.error).slice(0, 3).map((e) => e.fact)
    : [];
  try {
    const answer = await openai.completeJson(
      TEMPLATE_SUGGEST_PROMPT,
      JSON.stringify({ campaign: { name: ctx.name, purpose: ctx.purpose, category }, recipients: sample }),
      0.5,
    );
    const list = Array.isArray(answer.suggestions) ? (answer.suggestions as Obj[]) : [];
    return list
      .map((s) => ({
        name: typeof s.name === "string" ? s.name.trim().slice(0, 60) : "",
        reason: typeof s.reason === "string" ? s.reason.trim().slice(0, 160) : "",
        structure: typeof s.structure === "string" ? s.structure.trim().slice(0, 600) : "",
      }))
      .filter((t) => t.name && t.structure)
      .slice(0, 2);
  } catch (err) {
    log.warn({ err: (err as Error).message }, "template suggestions failed — showing the defaults only");
    return [];
  }
}

/** Rewrites every email to the template's structure (each is checked again), then shows the preview. */
async function applyTemplate(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, template: CampaignTemplate): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not apply the template.");
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  if (job.brief) job.brief.structure = template.structure;
  job.kind = "rewrite";
  job.instruction = templateInstruction(template);
  job.doneInRun = [];
  startRun(key, job, auth);
  // Show the preview right away, as before; only a very long list falls back to "send a message to check".
  const until = Date.now() + TEMPLATE_WAIT_MS;
  while (Date.now() < until && isRunningHere(key)) await new Promise((r) => setTimeout(r, 250));
  if (!isRunningHere(key)) return reply({ ...ctx, step: "template_review", template }, await templatePreview(key, template));
  return reply(
    { ...ctx, step: "generating", afterRun: "template_review", template },
    `Applying the **${template.name}** template to all ${job.recipients.length} emails. Send any message in a bit to see the preview.`,
  );
}

/** How long a template choice waits for the emails to be rewritten before answering. */
const TEMPLATE_WAIT_MS = 90_000;

async function templatePreview(key: string, template: CampaignTemplate): Promise<string> {
  const job = await loadJob(key);
  const items = job ? ordered(job).filter((x) => x.e && !x.e.error).slice(0, 2) : [];
  const review = job ? ordered(job).filter((x) => !x.e || x.e.error).length : 0;
  return [
    `Template **${template.name}** is applied. These are the emails exactly as they will be sent — plain text, no design:`,
    "",
    ...items.flatMap((x) => [emailBlock(x.n, x.r, x.e!), ""]),
    review ? `*${review} recipient(s) need review and will be left out — say **cancel** and start again if you want to fix them first.*\n` : "",
    "Reply **approve** to continue, tell me what to change in the structure, or pick another number.",
  ].filter((l) => l !== "").join("\n");
}

async function pickedTemplate(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const choices = ctx.templateChoices ?? DEFAULT_TEMPLATES;
  const m = msg.match(/^#?(\d{1,2})\b\s*[,:.\-–]?\s*(?:but|lekin|par|and|aur|with)?\s*(.*)$/i);
  if (m) {
    const picked = choices[Number(m[1]) - 1];
    if (!picked) return reply(ctx, `Please choose a number from 1 to ${choices.length}, or describe your own structure.`);
    const change = (m[2] ?? "").trim();
    const template = change.length >= 3 ? { name: `${picked.name} (edited)`, structure: `${picked.structure} Also: ${change}` } : picked;
    return applyTemplate(state, ctx, key, template);
  }
  if (msg.length >= 4) return applyTemplate(state, ctx, key, { name: "Your structure", structure: msg.slice(0, 600) });
  return reply(ctx, `Please choose a number from 1 to ${choices.length}, or describe your own structure.`);
}

async function reviewedTemplate(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  if (APPROVE_RE.test(msg) && msg.length <= 30) return createAndSave(state, ctx, key);
  if (/^#?\d{1,2}\b/.test(msg)) return pickedTemplate(state, ctx, key, msg);
  if (msg.length < 3 || !ctx.template) return reply(ctx, "Reply **approve** to continue, or tell me what to change in the structure.");
  return applyTemplate(state, ctx, key, { name: `${ctx.template.name} (edited)`, structure: `${ctx.template.structure} Also: ${msg.slice(0, 400)}` });
}

// ── Step 7: create the draft, save recipients, schedule ──────────────────────

const SCHEDULE_QUESTION = "**When should it be sent?** Reply **now**, or a date and time (e.g. *tomorrow 10am*, *kal subah 9 baje*, *15 Nov 3pm*).";

async function createAndSave(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not create the campaign.");
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  if (!ctx.template) return reply({ ...ctx, step: "template_pick" }, "Please choose a template first.");

  let campaignId = ctx.campaignId;
  if (!campaignId) {
    const smtpId = ctx.smtpSettingsId ?? state.senderDefaults?.smtpSettingsId;
    const created = await callTool(
      "create_campaign",
      {
        name: ctx.name,
        subject: SUBJECT_PLACEHOLDER,
        body: BODY_PLACEHOLDER,
        bodyFormat: "html",
        ...(smtpId ? { smtpSettingsId: smtpId } : {}),
      },
      auth,
    );
    if (!created.ok) {
      if (created.code === "SMTP_SELECTION_REQUIRED") {
        const choices = (Array.isArray(created.details.choices) ? created.details.choices : []) as Array<{ id: number; fromEmail: string; fromName?: string }>;
        return reply(
          { ...ctx, step: "smtp", smtpChoices: choices },
          ["**Which email account should send this campaign?**", "", ...choices.map((c, i) => `${i + 1}. **${c.fromEmail}**${c.fromName ? ` (${c.fromName})` : ""}`), "", "Reply with the number or the email address."].join("\n"),
        );
      }
      return reply(ctx, `I could not create the campaign: ${created.message}\n\nFix it and reply **approve** to try again, or **cancel**.`);
    }
    const id = created.data.id;
    campaignId = typeof id === "number" ? String(id) : typeof id === "string" ? id : undefined;
    if (!campaignId) return reply(ctx, "The campaign was created but I did not get its ID back. Please check your campaign list.");
    ctx = { ...ctx, campaignId };
  }

  // Each recipient's own subject and email go in as row columns; the campaign's {{ai_subject}} / {{ai_body}} use them.
  const items = ordered(job);
  const rows = items
    .filter((x) => x.e && !x.e.error)
    .map((x) => ({
      email: x.r.email,
      ...(x.r.name ? { name: x.r.name } : {}),
      ...(x.r.company ? { company: x.r.company } : {}),
      ai_subject: x.e!.subject,
      ai_body: x.e!.bodyHtml.replace(/\r?\n/g, " "),
    }));
  const failedEmails = items.length - rows.length;
  if (rows.length === 0) return reply(ctx, "There are no written emails to save. Go back with **regenerate N**, or **cancel**.");

  const saved = await callTool("save_csv_recipients", { campaignId, rows }, auth);
  if (!saved.ok) return reply(ctx, `The draft campaign is created, but saving the recipients failed: ${saved.message}\n\nReply **approve** to try saving again, or **cancel**.`, { activeCampaignId: campaignId });
  const added = Number(saved.data.added) || 0;
  const rejected = Number(saved.data.rejected) || 0;
  const notAdded = rows.length - added;

  return reply(
    { ...ctx, step: "schedule", saved: { added, rejected, failedEmails } },
    [
      `Draft campaign **${ctx.name}** created and **${added}** recipients saved, each with their own subject and email.`,
      notAdded > 0 ? `- ${notAdded} not added (unsubscribed / bounced before, duplicates, or invalid).` : "",
      failedEmails > 0 ? `- ${failedEmails} left out because they need review (no usable fact, or the email did not pass the checks).` : "",
      "",
      SCHEDULE_QUESTION,
    ].filter(Boolean).join("\n"),
    { activeCampaignId: campaignId },
  );
}

async function choseSmtp(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const choices = ctx.smtpChoices ?? [];
  const n = Number(msg.match(/^#?(\d{1,2})$/)?.[1]);
  const pick = (n >= 1 ? choices[n - 1] : undefined) ?? choices.find((c) => msg.toLowerCase().includes(c.fromEmail.toLowerCase()));
  if (!pick) return reply(ctx, `Please reply with a number from 1 to ${choices.length}, or the email address.`);
  if (ctx.kind === "personalize") return savePersonalized(state, { ...ctx, step: "review", smtpSettingsId: pick.id }, key);
  return createAndSave(state, { ...ctx, step: "template_review", smtpSettingsId: pick.id }, key);
}

/** Wall clock of `date` in `timeZone`: "YYYY-MM-DD HH:mm". */
export function wallClock(date: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "2026-11-12 10:00" in Asia/Karachi → "2026-11-12T05:00:00.000Z". Undefined when not a valid time. */
export function zonedToIso(local: string, timeZone: string): string | undefined {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return undefined;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let ts = asUtc;
  for (let i = 0; i < 2; i++) {
    const shown = wallClock(new Date(ts), timeZone);
    const s = shown.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/)!;
    const shownUtc = Date.UTC(Number(s[1]), Number(s[2]) - 1, Number(s[3]), Number(s[4]), Number(s[5]));
    ts += asUtc - shownUtc;
  }
  return wallClock(new Date(ts), timeZone) === `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` ? new Date(ts).toISOString() : undefined;
}

async function chosenSchedule(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth || !ctx.campaignId) return reply(ctx, "Please sign in again — I could not schedule the campaign.");
  const timeZone = state.clientTimezone || "Asia/Karachi";

  let status: "now" | "scheduled" | "unclear" = /^(now|abhi|right now|foran|immediately|send now|abhi bhej do)\b/i.test(msg) ? "now" : "unclear";
  let local = "";
  if (status === "unclear") {
    const openai = getOpenAIService();
    if (openai) {
      const now = new Date();
      const answer = await openai.completeJson(
        SCHEDULE_PARSE_PROMPT,
        JSON.stringify({ message: msg, now: `${wallClock(now, timeZone)} (${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(now)})`, timezone: timeZone }),
        0,
      );
      if (answer.status === "now") status = "now";
      else if (answer.status === "scheduled" && typeof answer.local === "string") {
        status = "scheduled";
        local = answer.local.trim();
      }
    } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(msg)) {
      status = "scheduled";
      local = msg.replace("T", " ");
    }
  }
  if (status === "unclear") return reply(ctx, `I could not read a time from that. ${SCHEDULE_QUESTION}`);

  let sendText = "now, as soon as you confirm";
  if (status === "scheduled") {
    const iso = zonedToIso(local, timeZone);
    if (!iso) return reply(ctx, `I could not read a time from that. ${SCHEDULE_QUESTION}`);
    if (new Date(iso).getTime() <= Date.now() + 60_000) return reply(ctx, `**${local}** (${timeZone}) has already passed. Please give a time in the future.`);
    const updated = await callTool("update_campaign", { campaignId: ctx.campaignId, scheduledAt: iso }, auth);
    if (!updated.ok) return reply(ctx, `I could not set that time: ${updated.message}\n\n${SCHEDULE_QUESTION}`);
    sendText = `**${local}** (${timeZone})`;
  }
  return finish(state, ctx, key, sendText);
}

// ── Step 8: summary + confirmation (approval card) ───────────────────────────

async function finish(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, sendText: string): Promise<Patch> {
  const job = await loadJob(key);
  const written = job ? Object.values(job.results).filter((e) => !e.error) : [];
  const low = written.filter((e) => e.level === "low").length;
  const badLinks = written.flatMap((e) => e.links).filter((l) => !l.ok).length;
  const sender = ctx.smtpChoices?.find((c) => c.id === ctx.smtpSettingsId)?.fromEmail ?? state.senderDefaults?.fromEmail ?? "your default email account";
  const saved = ctx.saved ?? { added: 0, rejected: 0, failedEmails: 0 };
  const summary = [
    `**Ready to ${sendText.startsWith("now") ? "start" : "schedule"} "${ctx.name}"**`,
    "",
    `- Recipients: **${saved.added}** saved${ctx.file?.skipped ? `, ${ctx.file.skipped} rows skipped in the file` : ""}${saved.failedEmails ? `, ${saved.failedEmails} without an email` : ""}`,
    `- Emails: **${written.length}** personalized emails and subjects${low ? ` (${low} with little data to personalize)` : ""}${badLinks ? `, ${badLinks} links could not be opened` : ""}`,
    ctx.kind === "personalize" ? `- Settings: ${settingsLine(ctx.personalize)}` : `- Template: **${ctx.template?.name ?? "—"}**`,
    `- Sender: **${sender}**`,
    `- Send: ${sendText}`,
    ...(ctx.kind === "personalize" && /running|in_progress|scheduled/i.test(ctx.source?.status ?? "")
      ? [`\n**${ctx.source?.name}** is still ${ctx.source?.status} and sends its own email to the same people. Pause it if they should only get these emails.`]
      : []),
    "",
    "Nothing is sent until you confirm.",
  ].join("\n");
  await deleteJob(key);
  return {
    intent: "start_campaign",
    toolName: "start_campaign",
    toolArgs: { campaignId: ctx.campaignId },
    crmAction: { confirmText: summary, requiresApproval: true },
    campaignCreation: undefined,
    activeCampaignId: ctx.campaignId,
  };
}
