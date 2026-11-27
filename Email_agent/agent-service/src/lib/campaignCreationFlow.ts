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
  INSTRUCTIONS_PROMPT,
  SCHEDULE_PARSE_PROMPT,
  TEMPLATE_SUGGEST_PROMPT,
} from "../prompts/campaignCreation.prompt.js";
import { guessLayout, layoutFromLlm, recipientKey, recipientsFromTable, type CampaignRecipient } from "./campaignCreationTable.js";
import {
  BODY_PLACEHOLDER,
  CAMPAIGN_CATEGORIES,
  DEFAULT_TEMPLATES,
  SUBJECT_PLACEHOLDER,
  templateInstruction,
  type CampaignTemplate,
} from "./campaignTemplates.js";
import {
  attachCampaign,
  cancelRun,
  currentJob,
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
import { liveCampaignCreation, type CampaignCreationState, type WritingInstructions } from "./campaignCreationContext.js";
import { createLogger } from "./logger.js";
import { scheduleLines, scheduleUpdateArgs, type ScheduleForm } from "./campaignScheduleForm.js";
import { CTAS, handlePersonalizeStep, MODES, personalizeBrief, savePersonalized, SEQUENCES, settingsLine, TONES } from "./personalizeEmailsFlow.js";
import { BACK_REPLY, CANCEL_REPLY, KEEP_REPLY, NUMBER_REPLY, understandReply, type StepGuide } from "./replyUnderstanding.js";
import { resolveToolArgs } from "./toolArgResolver.js";

const log = createLogger("campaignCreationFlow");

/** Recipients researched and written per campaign in chat (time and cost per row). */
export const MAX_RECIPIENTS = 200;

type Obj = Record<string, unknown>;
export type Patch = Partial<AgentGraphStateType>;

const CANCEL_RE = /^(cancel|stop|abort|exit|quit|band karo|band kr do|chhoro|chodo|rehne do|cancel kar do|cancel kr do)\b/i;
/** "back" / "previous step" / "peeche jao": one step back. */
export const BACK_RE = /^(?:go\s+)?back(?:\s+(?:one\s+step|a\s+step))?$|^previous(?:\s+step)?$|^(?:peeche|piche|wapas|wapis)(?:\s+(?:jao|jaao|chalo|ja))?$|^(?:pichla|pichle|pehle\s+wala|pehla\s+wala)\s+step(?:\s+(?:pa|par|pe))?(?:\s+(?:jao|jaao|chalo|ja))?$/i;
/** After going back: keep the answer already given and move on. */
export const KEEP_RE = /^(?:keep(?:\s+it)?|same|next|continue|aage|yehi|yahi|wahi|wohi|theek\s+hai|thik\s+hai)$/i;
/** Steps the user can go back from (the draft is created at "schedule"; "generating" is not an answer). */
const BACK_STEPS = new Set<CampaignCreationState["step"]>(["file", "purpose", "instructions", "subject_instructions", "sender", "review", "template_category", "template_pick", "template_review", "smtp"]);
const APPROVE_RE =
  /^(approve|approved|ok|okay|yes|yep|sure|confirm|looks good|good|great|perfect|theek|thik|theek hai|sahi|sahi hai|done|next|continue|go ahead|haan|han|ji)\b/i;
/** "upload again", "new file", "file dobara bhejta hun" — a corrected recipient file follows. */
const UPLOAD_AGAIN_RE =
  /^((re-?)?upload|send|attach)(\s+(it|the|a|my))?(\s+(corrected|new|fixed|another))?(\s+(file|sheet|csv|excel))?(\s+again)?$|^(new|another|corrected|fixed)\s+(file|sheet|csv)$|^file\s+(dobara|phir\s+se)\b|^dobara\s+(file|upload)\b/i;

// ── Entry points ─────────────────────────────────────────────────────────────

export function isCampaignCreationActive(state: AgentGraphStateType): boolean {
  return liveCampaignCreation(state.campaignCreation) !== undefined;
}

/**
 * "create campaign" (also the chat's "Create campaign" button) starts this flow. The old paths stay for a request that already gives the subject
 * and the body ("create campaign called X, subject Y, body Z").
 */
/**
 * "Create a draft called X, add the same recipients as campaign 465, and schedule it for tomorrow at 10am":
 * three actions in one message. Not done as one step yet — the agent says so plainly instead of turning the
 * whole sentence into the campaign name / email text and reporting success (QA P3 bug 61).
 */
export function isChainedCampaignRequest(message: string): boolean {
  return /\b(create|make|build|new)\b[^.!?]{0,80}\b(campaign|draft)\b/i.test(message) &&
    /\b(copy|add|use|same)\b[^.!?]{0,40}\b(recipients|contacts|list)\b/i.test(message) &&
    /\b(schedule|scheduled|send\s+it|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(message);
}

export function startsCampaignCreation(state: AgentGraphStateType): boolean {
  if (state.intent !== "create_campaign") return false;
  if (isChainedCampaignRequest(state.userMessage)) return false;
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

const EDIT_IN_CAMPAIGNS =
  "Seeing or changing the emails in chat: each email is saved to the draft campaign as soon as it is written; it is seen and changed on the Campaigns page.";

/** What each step asks and which replies it takes (the user may answer in their own words, any language). */
function campaignGuide(ctx: CampaignCreationState): StepGuide | undefined {
  const personalize = ctx.kind === "personalize";
  const back = !personalize && BACK_STEPS.has(ctx.step) ? [BACK_REPLY] : [];
  const flow = personalize ? "personalized emails" : "campaign creation";
  const base = { flow, step: ctx.step };
  const tail = [...back, CANCEL_REPLY];
  const keep = (has: unknown) => (has ? [KEEP_REPLY] : []);
  const list = (choices: Array<{ label: string; text?: string }>) => choices.map((c) => ({ label: c.label, ...(c.text ? { description: c.text } : {}) }));
  const yesNo = ["yes — yes", "no — no", "skip — use the default (no)", CANCEL_REPLY];

  switch (ctx.step) {
    case "name":
      return {
        ...base,
        question: "What should the campaign be called?",
        replies: ["<only the campaign name> — the name itself, without words around it like \"iska naam ... rakh do\" or \"call it\"", ...keep(ctx.name), CANCEL_REPLY],
      };
    case "file":
      return {
        ...base,
        question: "Upload the recipient file with the 📎 button (.csv, .xlsx or .xls). Any layout works.",
        replies: [...keep(ctx.file), ...tail],
        notPossible: ["Typing the recipients in the chat: the recipients come from an uploaded file (📎 button)."],
      };
    case "purpose":
      return {
        ...base,
        question: "What is this campaign for, and what do you offer? (used to write each person's email)",
        replies: ["<their answer, unchanged> — the purpose / offer in their own words", ...keep(ctx.purpose), ...tail],
      };
    case "instructions":
      return {
        ...base,
        question: "How should every email be written (structure, tone, length)? One instruction for all prospects; the AI adapts it to each prospect's industry.",
        replies: [
          "<their instructions, unchanged> — how the emails should be built, in their own words",
          "default — use the standard style (a template can be picked later)",
          ...keep(ctx.instructionsAsked),
          ...tail,
        ],
      };
    case "subject_instructions":
      return {
        ...base,
        question: "How should the subject lines be? One instruction for all prospects, or default.",
        replies: [
          "<their subject instructions, unchanged> — how the subject lines should be, in their own words",
          "default — the standard subject style",
          ...keep(ctx.subjectAsked),
          ...tail,
        ],
      };
    case "sender":
      return {
        ...base,
        question: "What name should sign the emails (exactly as it should appear under the sign-off)?",
        replies: ["<the name, unchanged> — a person's name or a company name, e.g. \"Your Name\" or \"Your Company Name\"", ...tail],
      };
    case "review":
      return {
        ...base,
        question: "Here are the written emails (numbered by recipient). Approve them, look at one, or say what to change.",
        replies: [
          "approve — the emails are fine, go on (agreement or praise counts)",
          "show all — list every recipient",
          "show <N> — show recipient N's full email",
          "regenerate <N> — write recipient N's email again",
          "<N>: <change> — change only recipient N's email, e.g. \"3: make it shorter\"",
          ...(canReupload(ctx) ? ["upload again — they will send a corrected recipient file"] : []),
          "<the change> — one change for EVERY email, e.g. \"make them more formal\" (only when they clearly ask to change all emails)",
          ...tail,
        ],
        notPossible: [
          personalize
            ? "Templates: there is no template step here; approve saves these emails."
            : "Choosing a template now: templates come right after approve.",
        ],
      };
    case "template_category":
      return {
        ...base,
        question: "What is this campaign related to? (picks the template ideas)",
        choices: CAMPAIGN_CATEGORIES.map((c) => ({ label: c })),
        replies: [NUMBER_REPLY, "<their own category> — a category that is not in the list", ...tail],
      };
    case "template_pick":
      return {
        ...base,
        question: "Pick a template (a writing structure for every email), or describe their own structure.",
        choices: (ctx.templateChoices ?? []).map((t) => ({ label: t.name, ...(t.reason ? { description: t.reason } : {}) })),
        replies: [
          NUMBER_REPLY,
          "<number> but <change> — that template with a change, e.g. \"2 but shorter\"",
          "<their own structure> — how each email should be built, in their words",
          ...tail,
        ],
      };
    case "template_review":
      return {
        ...base,
        question: "The template is applied (preview shown). Approve, change the structure, or pick another template number.",
        choices: (ctx.templateChoices ?? []).map((t) => ({ label: t.name })),
        replies: [
          "approve — the template is fine, go on (agreement or praise counts)",
          NUMBER_REPLY.replace("that option", "another template"),
          "<the change> — a change to the structure",
          ...tail,
        ],
      };
    case "smtp":
      return {
        ...base,
        question: "Which email account should send the campaign? (the box below can pick several)",
        choices: (ctx.smtpChoices ?? []).map((c) => ({ label: c.fromEmail })),
        replies: [NUMBER_REPLY, "<the email address> — that account", ...tail],
        notPossible: [EDIT_IN_CAMPAIGNS],
      };
    case "schedule":
      return {
        ...base,
        question: "When should the campaign be sent? (the box below sets start, speed, days, hours and stop)",
        replies: ["now — send as soon as they confirm", "<date and time, in their words> — e.g. \"tomorrow 10am\"", CANCEL_REPLY],
        notPossible: ["Going back: the draft campaign is already saved; earlier answers are changed on the Campaigns page.", EDIT_IN_CAMPAIGNS],
      };
    case "pick_campaign":
      return {
        ...base,
        question: "Which campaign's emails should be personalized?",
        choices: (ctx.campaignChoices ?? []).map((c) => ({ label: c.name, description: c.status })),
        replies: [NUMBER_REPLY, "<the campaign name> — that campaign", CANCEL_REPLY],
      };
    case "p_mode":
      return { ...base, question: "Writing mode?", choices: list(MODES), replies: [NUMBER_REPLY, "skip — the default (1)", CANCEL_REPLY] };
    case "p_tone":
      return { ...base, question: "Tone: whose voice?", choices: list(TONES), replies: [NUMBER_REPLY, "skip — the default (1)", CANCEL_REPLY] };
    case "p_cta":
      return { ...base, question: "Call to action: how should each email end?", choices: list(CTAS), replies: [NUMBER_REPLY, "skip — the default (1)", CANCEL_REPLY] };
    case "p_sequence":
      return { ...base, question: "Sequence type?", choices: list(SEQUENCES), replies: [NUMBER_REPLY, "skip — the default (1)", CANCEL_REPLY] };
    case "p_length":
      return {
        ...base,
        question: "How many emails per recipient: 1 (one email), 3 (first + 2 follow-ups) or 4 (first + 3 follow-ups)?",
        replies: ["1 — one email", "3 — three emails", "4 — four emails", CANCEL_REPLY],
        notPossible: ["Other counts (2, 5, ...): only 1, 3 or 4 emails."],
      };
    case "p_breakup":
      return { ...base, question: "Should the last follow-up be a polite \"breakup\" email (closes the loop, no pressure)?", replies: yesNo };
    case "p_short":
      return { ...base, question: "Keep the emails extra short?", replies: yesNo };
    default:
      return undefined;
  }
}

export async function handleCampaignCreation(state: AgentGraphStateType): Promise<Patch> {
  const out = await handleStep(state);
  return withProgress(out, state);
}

/** 📨 how many emails are ready; added under every question while they are written in the background. */
function progressLine(job: CreationJob): string {
  const total = job.recipients.length;
  const ok = Object.values(job.results).filter((e) => !e.error && e.body).length;
  const failed = Object.values(job.results).filter((e) => e.error).length;
  if (job.status === "running" || job.status === "ready") {
    return `📨 **${ok}/${total} emails ready** — still writing in the background; each one is saved to the draft campaign as soon as it is written. Just continue.`;
  }
  return `📨 **All ${total} emails are written** — ${ok} saved to the draft campaign${failed ? `, ${failed} need review (not saved)` : ""}.`;
}

async function withProgress(out: Patch, state: AgentGraphStateType): Promise<Patch> {
  const ctx = out.campaignCreation;
  if (!ctx?.background || ctx.step === "waiting" || typeof out.formattedResponse !== "string") return out;
  const key = jobKey(String(state.userId ?? "unknown"), String(state.sessionId ?? "unknown"));
  const job = await currentJob(key);
  if (!job) return out;
  // The agent restarted during the run: the writing goes on.
  const auth = authOf(state);
  if (job.status === "running" && !isRunningHere(key) && auth) startRun(key, job, auth);
  try {
    const env = JSON.parse(out.formattedResponse) as Obj;
    if (env.status !== "needs_input" || typeof env.message !== "string") return out;
    env.message = `${env.message}\n\n${progressLine(job)}`;
    return { ...out, formattedResponse: JSON.stringify(env) };
  } catch {
    return out;
  }
}

async function handleStep(state: AgentGraphStateType): Promise<Patch> {
  const ctx = liveCampaignCreation(state.campaignCreation);
  let msg = state.userMessage.trim();
  const key = jobKey(String(state.userId ?? "unknown"), String(state.sessionId ?? "unknown"));

  if (!ctx) return start(state);

  // The user's own words → the reply this step understands. A file, the schedule box or the sender box is an answer already.
  const answered = !!state.pendingCsvFile || !!state.scheduleChoice || !!state.senderChoice;
  const clear =
    CANCEL_RE.test(msg) || BACK_RE.test(msg) || KEEP_RE.test(msg) || (APPROVE_RE.test(msg) && msg.length <= 30);
  const guide = answered || clear ? undefined : campaignGuide(ctx);
  if (guide) {
    const understood = await understandReply(guide, msg);
    if (understood?.kind === "say") {
      return ctx.step === "schedule" ? askSchedule(state, ctx, understood.message) : ctx.step === "smtp" ? askSender(ctx, understood.message) : reply(ctx, understood.message);
    }
    if (understood?.kind === "reply") msg = understood.text;
  }

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
    if (ctx.kind !== "personalize" && !state.pendingCsvFile && BACK_RE.test(msg)) return await goBack(state, ctx, key);
    // A corrected file sent before the emails are written in the background replaces the recipients.
    const beforeWriting = ["purpose", "instructions", "subject_instructions", "sender", "review", "template_category", "template_pick", "template_review"].includes(ctx.step);
    if (state.pendingCsvFile && ctx.kind !== "personalize" && !ctx.background && beforeWriting) {
      return await receivedFile(state, ctx, key);
    }
    switch (ctx.step) {
      case "name":
        return askedName(ctx, msg);
      case "file":
        return await receivedFile(state, ctx, key);
      case "purpose":
        return await receivedPurpose(state, ctx, key, msg);
      case "instructions":
        return await receivedInstructions(state, ctx, key, msg);
      case "subject_instructions":
        return await receivedSubjectInstructions(state, ctx, key, msg);
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
      case "waiting":
        return await finishWhenReady(state, ctx, key, ctx.pendingFinish?.sendText ?? "now, as soon as you confirm", ctx.pendingFinish?.details);
      default:
        return reply(ctx, "Please answer the last question, or say **cancel** to stop.");
    }
  } catch (err) {
    log.error({ step: ctx.step, err: err instanceof Error ? err.message : String(err) }, "campaign creation step failed");
    return reply(ctx, "Something went wrong in this step. Please try again, or say **cancel** to stop.");
  }
}

// ── Replies ──────────────────────────────────────────────────────────────────

/** `back: true` → the chat shows a "Previous step" button under the question. */
function needsInput(message: string, ctx?: CampaignCreationState, form?: Obj): string {
  const back = ctx && ctx.kind !== "personalize" && BACK_STEPS.has(ctx.step);
  return JSON.stringify({ status: "needs_input", intent: "create_campaign", message, ...(form ? { form } : {}), ...(back ? { back: true } : {}) });
}

export function reply(ctx: CampaignCreationState, message: string, extra: Patch = {}): Patch {
  return {
    intent: "create_campaign",
    toolName: undefined,
    toolArgs: {},
    formattedResponse: needsInput(message, ctx),
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

/**
 * "create a campaign named QA-TEST AI write - do not use about a product update" → name "QA-TEST AI write -
 * do not use", topic "a product update". The name used to run to the end of the message (or the LLM cut it
 * to "QA-TEST AI" and put the rest in the body) — QA P3 bug 38. A quoted name is taken as it is.
 */
export function campaignNameAndTopic(message: string): { name?: string; topic?: string } {
  const quoted = /\b(?:called|named)\s+["“']([^"”']{1,255})["”']\s*(.*)$/i.exec(message);
  if (quoted) {
    const rest = /\b(?:about|regarding|on|for)\s+(.+?)[.!?]*$/i.exec(quoted[2] ?? "")?.[1];
    return { name: quoted[1]!.trim(), ...(rest ? { topic: rest.trim() } : {}) };
  }
  const m = /\b(?:called|named)\s+(.+?)(?:\s+(?:about|regarding|on\s+the\s+topic\s+of|to\s+(?:promote|announce|share))\s+(.+?)|\s+with\s+(?:the\s+)?(?:subject|body)\b.*)?[.!?]*$/i.exec(message);
  if (!m) return {};
  return { name: m[1]!.trim(), ...(m[2] ? { topic: m[2].trim() } : {}) };
}

function start(state: AgentGraphStateType): Patch {
  const ctx: CampaignCreationState = { step: "name", atIso: new Date().toISOString() };
  const llmName = fromLlm(state).name;
  // The words the user typed win over the LLM's reading of the name.
  const typed = campaignNameAndTopic(state.userMessage);
  // The LLM's name only when the user actually gave one ("named X", "name: X", "naam X", a quoted name):
  // "compaign create krni ha yar" is the request, never the name — then the name is asked.
  const gaveName = /\b(named|called|name|naam|titled?)\b|["“”']/i.test(state.userMessage);
  const named = typed.name || (gaveName && typeof llmName === "string" && llmName.trim()) || undefined;
  if (named && named.length <= 255) {
    const topic = typed.topic ? `Topic: **${typed.topic}**.\n\n` : "";
    return reply(
      { ...ctx, step: "file", name: named, ...(typed.topic ? { purpose: typed.topic } : {}) },
      `Campaign name: **${named}**.\n\n${topic}${FILE_QUESTION}`,
      clearOtherFlows(),
    );
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
  if (KEEP_RE.test(msg) && ctx.name) return reply({ ...ctx, step: "file" }, fileAgainQuestion(ctx));
  const name = msg.replace(/^["“']|["”']$/g, "").trim();
  if (!name) return reply(ctx, "**What should the campaign be called?**");
  if (name.length > 255) return reply(ctx, `That name is ${name.length} characters long. Please use at most 255 characters.`);
  return reply({ ...ctx, step: "file", name }, `Campaign name: **${name}**.\n\n${fileAgainQuestion(ctx)}`);
}

async function receivedFile(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const file = state.pendingCsvFile;
  if (!file && ctx.file && KEEP_RE.test(state.userMessage.trim()) && (await loadJob(key))?.recipients.length) {
    return reply({ ...ctx, step: "purpose" }, purposeAgainQuestion(ctx));
  }
  if (!file) return reply(ctx, `I need the file to continue.\n\n${fileAgainQuestion(ctx)}`);
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
  const { recipients: parsed, skipped, thinRows } = recipientsFromTable(table, layout);
  if (parsed.length === 0) {
    const why = skipped.slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join("; ");
    return reply({ ...ctx, step: "file" }, `I could not find any valid email address in **${file.filename}**${why ? ` (${why})` : ""}.\n\n${FILE_QUESTION}`, consumed);
  }
  // Rows with only an email (and maybe a name) give the writer nothing to write from: the file must be fixed,
  // regenerating would only fail again.
  const thin = new Set(thinRows);
  const all = parsed.filter((r) => !thin.has(r.row));
  if (all.length === 0) return reply({ ...ctx, step: "file" }, thinFileMessage(file.filename, parsed.length), consumed);
  const thinLine = thin.size
    ? `- **${thin.size}** row${thin.size === 1 ? "" : "s"} left out: only an email${thin.size === 1 ? "" : "s"} / name, nothing to write a personal email from (${rowList(thinRows)}). To include ${thin.size === 1 ? "it" : "them"}, add a company, role, website, LinkedIn or job link, or notes, and upload the file again.`
    : "";
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
    thinLine,
    overLimit ? `- **${overLimit}** more recipients left out: one chat campaign takes up to ${MAX_RECIPIENTS}. Upload the rest in a second campaign.` : "",
    `- Columns: ${summary.columns.slice(0, 8).join(", ")}${summary.columns.length > 8 ? " …" : ""}`,
    `- **${summary.withLinks}** recipients have links to research: ${count("website")} websites, ${count("job_post")} job posts, ${count("linkedin")} LinkedIn, ${count("other")} other`,
  ].filter(Boolean);

  // A corrected file at the template steps: the chosen template is tried again on the new rows (new samples).
  if (ctx.kind !== "personalize" && ctx.template && ctx.purpose && ctx.senderName && !ctx.background) {
    const tried = await applyTemplate(state, { ...ctx, file: summary }, key, ctx.template);
    return { ...tried, ...consumed, formattedResponse: prependMessage(tried.formattedResponse, lines.join("\n")) };
  }
  // A corrected file sent after the emails were written (a run already happened): same purpose and sender, write again right away.
  const sender = ctx.senderName ?? state.senderDefaults?.fromName?.trim();
  if (ctx.afterRun && ctx.purpose && sender) {
    const started = await startGeneration(state, { ...ctx, file: summary, senderName: sender }, key);
    return { ...started, ...consumed, formattedResponse: prependMessage(started.formattedResponse, lines.join("\n")) };
  }
  lines.push(
    "",
    "One question before I write the emails: **what is this campaign for, and what do you offer?**",
    "For example: *\"I'm a full-stack developer offering to build their app\"* or *\"We sell CRM software for real-estate agencies\"*.",
  );
  return reply({ ...ctx, step: "purpose", file: summary }, lines.join("\n"), consumed);
}

/** "rows 3, 7, 9 …" */
function rowList(rows: number[]): string {
  return `row${rows.length === 1 ? "" : "s"} ${rows.slice(0, 8).join(", ")}${rows.length > 8 ? " …" : ""}`;
}

function thinFileMessage(filename: string, count: number): string {
  return [
    `I can't write personal emails from **${filename}** yet: ${count === 1 ? "the row only has" : `all ${count} rows only have`} an email address (and maybe a name) — nothing about the person or their business to write from.`,
    "",
    "**Please fix the file and upload it again.** Each row needs at least one of these:",
    "- **company** name, or their **role / job title**",
    "- a **website**, **LinkedIn** profile or **job post** link (Upwork, Fiverr …)",
    "- **notes** about them (what they do, what they need)",
    "",
    "Then send the corrected file with the 📎 button (**.csv**, **.xlsx** or **.xls**), or say **cancel** to stop.",
  ].join("\n");
}

/** The intro above a reply's own message (the reply keeps its status). */
function prependMessage(formatted: unknown, intro: string): string {
  const parsed = JSON.parse(String(formatted)) as { message?: string };
  return JSON.stringify({ ...parsed, message: `${intro}\n\n${parsed.message ?? ""}` });
}

// ── Back: one step back, the earlier answer can be kept ──────────────────────

const KEEP_HINT = "say **keep** to keep it";

function fileAgainQuestion(ctx: CampaignCreationState): string {
  if (!ctx.file) return FILE_QUESTION;
  return `You uploaded **${ctx.file.fileName}** (**${ctx.file.recipients}** recipients). Send another file with the 📎 button to replace it, or ${KEEP_HINT}.`;
}

function purposeAgainQuestion(ctx: CampaignCreationState): string {
  const now = ctx.purpose ? `\n\nNow: *"${ctx.purpose.slice(0, 300)}"* — type a new one, or ${KEEP_HINT}.` : "";
  return `**What is this campaign for, and what do you offer?**${now}`;
}

async function goBack(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const back = (step: CampaignCreationState["step"], text: string, more: Partial<CampaignCreationState> = {}) =>
    reply({ ...ctx, ...more, step }, `Back one step.\n\n${text}`);
  switch (ctx.step) {
    case "name":
      return reply(ctx, "This is the first step, there is nothing before it. **What should the campaign be called?** (or say **cancel**)");
    case "file":
      return back("name", `**What should the campaign be called?**${ctx.name ? ` Now: **${ctx.name}** — type a new name, or ${KEEP_HINT}.` : ""}`);
    case "purpose":
      return back("file", fileAgainQuestion(ctx));
    case "instructions":
      return back("purpose", purposeAgainQuestion(ctx));
    case "subject_instructions":
      return back("instructions", instructionsAgainQuestion(ctx));
    case "sender":
      if (ctx.subjectAsked && ctx.kind !== "personalize") {
        return back("subject_instructions", `${SUBJECT_QUESTION}${ctx.subjectInstructions ? `\n\nNow: *"${ctx.subjectInstructions.slice(0, 300)}"* — type new ones, or ${KEEP_HINT}.` : ""}`);
      }
      return ctx.instructionsAsked && ctx.kind !== "personalize" ? back("instructions", instructionsAgainQuestion(ctx)) : back("purpose", purposeAgainQuestion(ctx));
    case "generating":
      return reply(ctx, "I'm writing the emails right now. Wait until they are done (send any message to see the progress), then you can go back — or say **cancel** to stop.");
    case "review":
      if (ctx.instructionsAsked && ctx.kind !== "personalize") {
        return back("instructions", `${instructionsAgainQuestion(ctx)}\n\nNew instructions write all emails again; **keep** goes back to the emails you have.`);
      }
      return back("purpose", `${purposeAgainQuestion(ctx)}\n\nA new purpose writes all emails again; **keep** goes back to the emails you have.`);
    case "template_category": {
      const job = await loadJob(key);
      if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
      return back("review", reviewText(job, "Your emails:", ctx));
    }
    case "template_pick":
      return back("template_category", categoryQuestion(ctx));
    case "template_review":
      return back("template_pick", `${templateList(ctx.category ?? "Other", ctx.templateChoices ?? DEFAULT_TEMPLATES)}\n\nThe emails now follow **${ctx.template?.name ?? "the template"}**; another choice rewrites them again.`);
    case "smtp":
      if (ctx.background) {
        return askSender(ctx, `The emails are already being written with **${ctx.template?.name ?? "the template"}**, so the template can't change now (say **cancel** to start again).\n\n${senderQuestion("this campaign")}`);
      }
      if (!ctx.template) return back("template_pick", templateList(ctx.category ?? "Other", ctx.templateChoices ?? DEFAULT_TEMPLATES));
      return back("template_review", await templatePreview(key, ctx.template));
    case "waiting":
      return reply(ctx, "The schedule is saved and the emails are being written; the confirmation comes next. Say **cancel** to stop (the draft campaign stays).");
    case "schedule":
      return askSchedule(
        state,
        ctx,
        `The draft campaign **${ctx.name ?? ""}** is already created with its recipients, so the earlier steps can't be changed from here. Edit it on the Campaigns page, or set when it should be sent below.\n\n${SCHEDULE_QUESTION}`,
      );
    default:
      return reply(ctx, "Please answer the last question, or say **cancel** to stop.");
  }
}

// ── Step 4: research + write (background) ────────────────────────────────────

async function receivedPurpose(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  if (KEEP_RE.test(msg) && ctx.purpose) {
    // Emails already written for this purpose: back to them, nothing is written again.
    const job = ctx.afterRun ? await loadJob(key) : undefined;
    if (job && Object.keys(job.results).length > 0) return reply({ ...ctx, step: "review" }, reviewText(job, "Purpose kept. Your emails:", ctx));
    msg = ctx.purpose;
  }
  if (msg.length < 3) return reply(ctx, "Please tell me in a sentence what this campaign is for and what you offer.");
  const purpose = /^skip$/i.test(msg) ? `Inferred from the campaign name "${ctx.name ?? ""}"` : msg.slice(0, 4000);
  // Once per campaign: the master writing instruction every email follows (personalize has its own settings).
  if (ctx.kind !== "personalize" && !ctx.instructionsAsked) return reply({ ...ctx, step: "instructions", purpose }, INSTRUCTIONS_QUESTION);
  return senderOrWrite(state, { ...ctx, purpose }, key);
}

/** The sender's name (asked when the account has none), then the emails are written. */
async function senderOrWrite(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const purpose = ctx.purpose ?? "";
  const sender = state.senderDefaults?.fromName?.trim() || ctx.senderName;
  // Every email is signed by a person: ask for the name when the account has none.
  if (!sender) {
    return reply({ ...ctx, step: "sender", purpose }, "**What name should sign the emails?** Exactly as it should appear under the sign-off (e.g. *Your Name* or *Your Company Name*).");
  }
  if (ctx.kind === "personalize") return startGeneration(state, { ...ctx, purpose, senderName: sender }, key);
  return reply({ ...ctx, step: "template_category", purpose, senderName: sender }, categoryQuestion(ctx));
}

export const INSTRUCTIONS_QUESTION = [
  "**How should every email be written?** Give me your instructions once — structure, tone, length. For example:",
  "*One paragraph: a real problem of their industry, how our service solves it, the value for them, then ask for a short call.*",
  "",
  "I'll read every row, work out each prospect's industry and its real challenges, and adapt your instructions to each company — one file can mix any industries.",
  "Write as much as you like — I follow all of it. Or reply **default** to use my standard style.",
].join("\n");

const DEFAULT_INSTRUCTIONS_RE = /^(default|standard|skip|no|none|nahi|nahin|koi nahi|aap dekh lo|tum dekh lo|your choice)$/i;

/** The user's instruction → structure + length / paragraphs (INSTRUCTIONS_PROMPT); without the LLM the words are the structure. */
export async function readInstructions(text: string): Promise<WritingInstructions> {
  const base: WritingInstructions = { text: text.slice(0, 4000), structure: text.slice(0, 4000) };
  const openai = getOpenAIService();
  if (!openai) return base;
  try {
    const a = await openai.completeJson(INSTRUCTIONS_PROMPT, JSON.stringify({ instructions: text.slice(0, 4000) }), 0);
    const range = (v: unknown, lo: number, hi: number): { min: number; max: number } | undefined => {
      if (!v || typeof v !== "object") return undefined;
      const o = v as Obj;
      const min = Math.round(Number(o.min));
      const max = Math.round(Number(o.max));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < lo || max > hi || min > max) return undefined;
      return { min, max };
    };
    const structure = typeof a.structure === "string" && a.structure.trim() ? a.structure.trim().slice(0, 3000) : base.structure;
    const paragraphs = range(a.paragraphs, 1, 5);
    let words = range(a.words, 30, 200);
    // A cap ("not more than 90 words") is not a narrow band: at least 40 words of room.
    if (words && words.max - words.min < 40) words = { min: Math.max(30, words.max - 40), max: words.max };
    return { ...base, structure, ...(paragraphs ? { paragraphs } : {}), ...(words ? { words } : {}), ...(a.target_numbers === true ? { targetNumbers: true } : {}) };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "reading the writing instructions failed — using the words as they are");
    return base;
  }
}

function instructionsAgainQuestion(ctx: CampaignCreationState): string {
  const now = ctx.instructionsAsked ? `\n\nNow: ${ctx.instructions ? `*"${ctx.instructions.text.slice(0, 300)}"*` : "**default**"} — type new instructions, or ${KEEP_HINT}.` : "";
  return `${INSTRUCTIONS_QUESTION}${now}`;
}

async function receivedInstructions(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  if (KEEP_RE.test(msg) && ctx.instructionsAsked) {
    // Emails already written to these instructions: back to them, nothing is written again.
    const job = ctx.afterRun ? await loadJob(key) : undefined;
    if (job && Object.keys(job.results).length > 0) return reply({ ...ctx, step: "review" }, reviewText(job, "Instructions kept. Your emails:", ctx));
    return afterInstructions(state, ctx, key);
  }
  if (DEFAULT_INSTRUCTIONS_RE.test(msg)) {
    const { instructions: _old, ...rest } = ctx;
    return afterInstructions(state, { ...rest, instructionsAsked: true }, key);
  }
  if (msg.length < 8) return reply(ctx, `Please describe how the emails should be written, or reply **default**.\n\n${INSTRUCTIONS_QUESTION}`);
  const instructions = await readInstructions(msg);
  return afterInstructions(state, { ...ctx, instructions, instructionsAsked: true }, key);
}

export const SUBJECT_QUESTION = [
  "**How should the subject lines be?** Tell me in your own words — e.g. *short, with the company name and the problem, no questions*.",
  "Or reply **default**: a short, professional subject with the company name and the value (e.g. *Faster Volunteer Onboarding for Dovetail Agency*).",
].join("\n");

/** Once per campaign, after the email instructions: the subject-line instructions. */
function afterInstructions(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> | Patch {
  if (ctx.kind !== "personalize" && !ctx.subjectAsked) return reply({ ...ctx, step: "subject_instructions" }, SUBJECT_QUESTION);
  return senderOrWrite(state, ctx, key);
}

async function receivedSubjectInstructions(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  if (KEEP_RE.test(msg) && ctx.subjectAsked) return senderOrWrite(state, ctx, key);
  if (DEFAULT_INSTRUCTIONS_RE.test(msg)) {
    const { subjectInstructions: _old, ...rest } = ctx;
    return senderOrWrite(state, { ...rest, subjectAsked: true }, key);
  }
  if (msg.length < 3) return reply(ctx, `Please describe the subject lines you want, or reply **default**.\n\n${SUBJECT_QUESTION}`);
  return senderOrWrite(state, { ...ctx, subjectInstructions: msg.slice(0, 1500), subjectAsked: true }, key);
}

async function receivedSender(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const name = msg.replace(/^["“']|["”']$/g, "").trim();
  if (!/^[\p{L}][\p{L}\p{N} .,'&()|—–-]{0,59}$/u.test(name)) return reply(ctx, "Please send just the name that should sign the emails (e.g. *Your Name* or *Your Company Name*).");
  if (ctx.kind === "personalize") return startGeneration(state, { ...ctx, senderName: name }, key);
  return reply({ ...ctx, step: "template_category", senderName: name }, categoryQuestion(ctx));
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
    language: "English",
    ...(ctx.instructions ? { structure: ctx.instructions.structure } : {}),
    ...(ctx.instructions && (ctx.instructions.paragraphs || ctx.instructions.words)
      ? { format: { ...(ctx.instructions.paragraphs ? { paragraphs: ctx.instructions.paragraphs } : {}), ...(ctx.instructions.words ? { words: ctx.instructions.words } : {}) } }
      : {}),
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
      `Got it. I'm now reading every row, working out each prospect's industry and its real challenges, researching every link and writing **one email and subject for each of the ${job.recipients.length} recipients**${ctx.instructions ? " — following your instructions" : ""}.`,
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
  return job.recipients.map((r, i) => ({ n: i + 1, r, e: job.results[recipientKey(r)] }));
}

/** One email exactly as it will be sent (plain text), quoted. */
function emailBlock(n: number, r: CampaignRecipient, e: GeneratedEmail): string {
  const who = r.name ? `${r.name} — ${r.email}` : r.email;
  const quote = (text: string) => text.split("\n").map((l) => `> ${l}`).join("\n");
  const followUps = (e.followUps ?? []).flatMap((f, i) => ["", `**Follow-up ${i + 1}:**`, "", quote(f.body)]);
  const industry = e.industry ? [`*Industry: ${e.industry}${e.painPoints?.length ? ` — challenges: ${e.painPoints.join("; ")}` : ""}*`] : [];
  return [`**#${n} ${who}**${r.company ? ` (${r.company})` : ""} · personalization: ${e.level}`, ...industry, `**Subject:** ${e.subject}`, "", quote(e.body), ...followUps].join("\n");
}

/** The writer found nothing about this person in their row or links: writing again cannot help, the file must be fixed. */
function isDataProblem(e: GeneratedEmail | undefined): boolean {
  return !!e?.error && e.error.startsWith("no usable fact");
}

/** "Create campaign" can take a corrected file; "personalize" works on an existing campaign (no file). */
const canReupload = (ctx: CampaignCreationState) => ctx.kind !== "personalize";

/** Why a recipient needs review, its last draft if there is one, and what helps. */
function needsReviewBlock(n: number, r: CampaignRecipient, e: GeneratedEmail | undefined, ctx: CampaignCreationState): string {
  const why = e?.issues?.length ? e.issues.slice(0, 4).map((i) => `- ${i}`).join("\n") : `- ${e?.error ?? "no email yet"}`;
  const fix = isDataProblem(e)
    ? canReupload(ctx)
      ? `\nWriting it again will not help: **row ${r.row} of your file has nothing about this person to write from.** Add their company, role, website, LinkedIn or job link, or notes to that row and say **upload again** — or leave it out (it is not saved).`
      : "\nThere is nothing about this person to write from, so writing it again will not help. It is left out (not saved)."
    : `\nSay **regenerate ${n}**, or **${n}: <what to change>**.`;
  return [
    `**#${n} ${r.email} needs review** (${e?.error ?? "no email yet"}). Not saved to the campaign unless fixed:`,
    why,
    e?.body ? `\nLast draft:\n${e.body.split("\n").map((l) => `> ${l}`).join("\n")}` : "",
    fix,
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

/**
 * The choices after a review, with real recipient numbers (an email that exists), and only the ones that make sense:
 * no "approve" when no email was written, "upload again" when rows of the file have nothing to write from.
 * "Generate personalized emails" saves after the review (no template step).
 */
function reviewOptions(ctx: CampaignCreationState, job: CreationJob): string {
  const items = ordered(job);
  const ok = items.filter((x) => x.e && !x.e.error);
  const failed = items.filter((x) => !x.e || x.e.error);
  const dataFailed = failed.filter((x) => isDataProblem(x.e));
  const lines = ["**What next?**"];
  if (ok.length) {
    const n = ok[0]!.n;
    const left = failed.length ? ` (the ${failed.length} that need${failed.length === 1 ? "s" : ""} review ${failed.length === 1 ? "is" : "are"} left out)` : "";
    lines.push(
      `- **approve** — ${ctx.kind === "personalize" ? "save these emails to a new draft campaign" : "keep these emails and choose a template"}${left}`,
      `- **show ${n}** — see recipient #${n}'s full email${items.length > 1 ? " · **show all** — list every recipient and subject" : ""}`,
      `- **regenerate ${n}** — write #${n}'s email again`,
      `- **${n}: make it shorter** — change only #${n}'s email`,
    );
  }
  if (failed.length) lines.push(`- **show ${failed[0]!.n}** — see why #${failed[0]!.n} needs review`);
  if (dataFailed.length && canReupload(ctx)) {
    lines.push(`- **upload again** — add details to ${rowList(dataFailed.map((x) => x.r.row))} of your file and send it again`);
  }
  const retry = failed.find((x) => !isDataProblem(x.e));
  if (!ok.length && retry) lines.push(`- **regenerate ${retry.n}** — try writing #${retry.n}'s email again`);
  if (ok.length) lines.push("- or just type a change for **all** emails (e.g. *make them more formal*, *mention our free trial*)");
  else lines.push("- **cancel** — stop creating this campaign");
  return lines.join("\n");
}

function reviewText(job: CreationJob, header: string, ctx: CampaignCreationState): string {
  const items = ordered(job);
  const ok = items.filter((x) => x.e && !x.e.error);
  const failedItems = items.filter((x) => !x.e || x.e.error);
  const levels = (l: string) => ok.filter((x) => x.e!.level === l).length;
  const links = ok.flatMap((x) => x.e!.links);
  const badLinks = links.filter((l) => !l.ok).length;
  const samples = sampleIndexes(items);
  const dataFailed = failedItems.filter((x) => isDataProblem(x.e));
  const lines = [
    ok.length
      ? `${header} Each recipient has their **own email and subject**, written from their row and their links.`
      : `**No email could be written.**${dataFailed.length === items.length && canReupload(ctx) ? " The rows in your file have nothing about these people to write from — please add their company, role, website, LinkedIn or job link, or notes, and say **upload again**." : ""}`,
    "",
    `- **${ok.length}** emails written · personalization: ${levels("high")} high, ${levels("medium")} medium, ${levels("low")} low`,
    links.length ? `- Links researched: **${links.length - badLinks}/${links.length}** opened${badLinks ? ` (${badLinks} could not be opened — blocked, login needed or empty; those emails use the row data)` : ""}` : "- No links in the file — the emails use the row data only",
    failedItems.length
      ? `- **${failedItems.length}** need review (${failedItems.slice(0, 5).map((x) => `#${x.n} ${x.e?.error ? x.e.error.split(" (")[0] : "no email"}`).join("; ")}${failedItems.length > 5 ? " …" : ""}) — say **show N** to see why; they are left out unless fixed`
      : "",
    "",
    samples.length ? "**Samples:**" : "",
    "",
    ...samples.flatMap((n) => {
      const x = items[n - 1]!;
      return [emailBlock(x.n, x.r, x.e!), ""];
    }),
    reviewOptions(ctx, job),
  ].filter((l) => l !== "");
  return lines.join("\n\n").replace(/\n\n(> )/g, "\n$1").replace(/(\*\*Subject:\*\* [^\n]*)\n\n\n?/g, "$1\n\n");
}

async function reviewing(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  const items = ordered(job);
  const at = (n: number) => (n >= 1 && n <= items.length ? items[n - 1] : undefined);

  if (APPROVE_RE.test(msg) && msg.length <= 30) {
    if (!items.some((x) => x.e && !x.e.error)) return reply(ctx, ["No email is written yet, so there is nothing to approve.", "", reviewOptions(ctx, job)].join("\n"));
    if (ctx.kind === "personalize") return savePersonalized(state, ctx, key);
    // The emails already follow the user's own instructions: no template step, straight to the sender and schedule.
    if (ctx.instructions) return createAndSave(state, { ...ctx, template: { name: "Your instructions", structure: ctx.instructions.structure } }, key);
    return reply({ ...ctx, step: "template_category" }, categoryQuestion(ctx));
  }

  // A corrected file: the next upload replaces the recipients and the emails are written again.
  if (canReupload(ctx) && UPLOAD_AGAIN_RE.test(msg)) {
    return reply(
      { ...ctx, step: "file" },
      `Send the corrected file with the 📎 button. I'll keep the name **${ctx.name ?? ""}** and your purpose, and write the emails again.\n\n${FILE_QUESTION}`,
    );
  }

  if (/^(show|see|view|list)\s+(all|every)|^all emails$|^sab(\s+\w+)?\s+(dikhao|dikha do)$/i.test(msg)) {
    const lines = items.slice(0, 200).map((x) => `${x.n}. ${x.r.email}${x.e?.industry ? ` (${x.e.industry})` : ""} — ${x.e && !x.e.error ? x.e.subject : "*(no email)*"}`);
    return reply(ctx, [`**All ${items.length} recipients:**`, "", ...lines, "", "Say **show N** for a full email.", "", reviewOptions(ctx, job)].join("\n"));
  }

  const show = msg.match(/^(?:show|see|view|open|email)\s*#?(\d{1,4})$/i) ?? msg.match(/^#?(\d{1,4})(?:\s+(?:dikhao|dikha do|show))?$/i);
  if (show) {
    const x = at(Number(show[1]));
    if (!x) return reply(ctx, `There is no recipient #${show[1]}. Choose 1–${items.length}.`);
    if (!x.e || x.e.error) return reply(ctx, [needsReviewBlock(x.n, x.r, x.e, ctx), "", reviewOptions(ctx, job)].join("\n"));
    return reply(ctx, [emailBlock(x.n, x.r, x.e), "", reviewOptions(ctx, job)].join("\n"));
  }

  const auth = authOf(state);
  const regen =
    msg.match(/^(?:regenerate|redo|rewrite|re-?write|dobara(?:\s+(?:likho|banao))?)\s*#?(\d{1,4})$/i) ??
    msg.match(/^#?(\d{1,4})\s+(?:regenerate|redo|dobara(?:\s*(?:likho|banao|likh do))?)$/i);
  if (regen) {
    const x = at(Number(regen[1]));
    if (!x) return reply(ctx, `There is no recipient #${regen[1]}. Choose 1–${items.length}.`);
    if (!auth) return reply(ctx, "Please sign in again — I could not write the email.");
    job.results[recipientKey(x.r)] = await writeEmail(x.r, job, auth);
    await saveJob(key, job);
    const e = job.results[recipientKey(x.r)]!;
    return reply(ctx, [e.error ? needsReviewBlock(x.n, x.r, e, ctx) : `New email for #${x.n}:\n\n${emailBlock(x.n, x.r, e)}`, "", reviewOptions(ctx, job)].join("\n"));
  }

  const one = msg.match(/^#?(\d{1,4})\s*[:\-–,)]\s*(.{3,})$/) ?? msg.match(/^#?(\d{1,4})\s+(?:ko|ka|ki|wali|wala)\s+(.{3,})$/i);
  if (one) {
    const x = at(Number(one[1]));
    if (!x) return reply(ctx, `There is no recipient #${one[1]}. Choose 1–${items.length}.`);
    if (!x.e?.body) return reply(ctx, `#${x.n} has no draft yet. Say **regenerate ${x.n}** first.`);
    const before = x.e;
    const after = await rewriteEmail(before, x.r, job, one[2]!.trim());
    job.results[recipientKey(x.r)] = after.issues?.length && !before.error ? { ...before } : after;
    await saveJob(key, job);
    if (after.issues?.length && after.body === before.body) {
      return reply(ctx, [`I could not apply that to #${x.n} without breaking the email rules:`, ...after.issues.slice(0, 4).map((i) => `- ${i}`), "", "The email stays as it was.", "", reviewOptions(ctx, job)].join("\n"));
    }
    return reply(ctx, ["Updated:", "", emailBlock(x.n, x.r, job.results[recipientKey(x.r)]!), "", reviewOptions(ctx, job)].join("\n"));
  }

  // A question or a request to see something is not a change for every email.
  if (/\btemplates?\b/i.test(msg) && !/\b(make|change|write|rewrite|use|follow|like)\b/i.test(msg)) {
    const next = ctx.kind === "personalize" ? "There is no template step here — say **approve** to save these emails." : "Templates come after the emails: say **approve** and I'll show you the templates.";
    return reply(ctx, [`${next} Nothing was changed.`, "", reviewOptions(ctx, job)].join("\n"));
  }
  if (/^(what|which|where|why|how|who|kya|kahan|kaun|kyun|kis|show|see|view|open|list|dikhao|dikha)\b/i.test(msg)) {
    return reply(ctx, [
      `I didn't change anything — that didn't look like a change for the emails. To change all ${job.recipients.length} email${job.recipients.length === 1 ? "" : "s"}, type the change (e.g. *make them more formal*).`,
      "",
      reviewOptions(ctx, job),
    ].join("\n"));
  }

  if (msg.length >= 4) {
    if (!auth) return reply(ctx, "Please sign in again — I could not change the emails.");
    job.kind = "rewrite";
    job.instruction = msg.slice(0, 1000);
    job.doneInRun = [];
    startRun(key, job, auth);
    return reply({ ...ctx, step: "generating", afterRun: "review" }, `Applying "**${job.instruction}**" to all ${job.recipients.length} emails (each stays personal and is checked again). Send any message to check the progress.`);
  }
  return reply(ctx, reviewOptions(ctx, job));
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
    "Now the **template** — how every email is laid out (each one stays personal). I'll show you 2 sample emails with it before writing the rest.",
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
  return reply({ ...ctx, step: "template_pick", category, templateChoices: choices }, templateList(category, choices));
}

/** The template choices: the suggested ones first, then the defaults. */
function templateList(category: string, choices: CampaignTemplate[]): string {
  const suggested = Math.max(0, choices.length - DEFAULT_TEMPLATES.length);
  return [
    `Campaign type: **${category}**. Templates you can use:`,
    "",
    ...choices.map((t, i) => `${i + 1}. **${t.name}**${t.reason ? ` — ${t.reason}` : ""}${i < suggested ? " *(suggested for this campaign)*" : i === suggested && suggested > 0 ? " *(default templates from here)*" : ""}`),
    "",
    "Reply with a **number**, or **describe your own structure** (e.g. *start with their project, then one past project of mine, ask for a call*),",
    "or a number with changes (e.g. *2 but shorter*).",
  ].join("\n");
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

/** Emails written as a preview of a template before the rest are written. */
const SAMPLE_COUNT = 3;

/** The writer's brief: the campaign, the template structure and the user's own instructions (they win). */
function briefFor(ctx: CampaignCreationState, template: CampaignTemplate): NonNullable<CreationJob["brief"]> {
  const structure = ctx.instructions
    ? `${template.structure}\nThe user's own instructions (they win where they differ): ${ctx.instructions.structure}`
    : template.structure;
  const format = ctx.instructions && (ctx.instructions.paragraphs || ctx.instructions.words)
    ? { ...(ctx.instructions.paragraphs ? { paragraphs: ctx.instructions.paragraphs } : {}), ...(ctx.instructions.words ? { words: ctx.instructions.words } : {}) }
    : undefined;
  return {
    name: ctx.name ?? "",
    purpose: ctx.purpose ?? "",
    ...(ctx.senderName ? { senderName: ctx.senderName } : {}),
    language: "English",
    structure,
    ...(format ? { format } : {}),
    ...(ctx.instructions?.text ? { userInstructions: ctx.instructions.text } : {}),
    ...(ctx.subjectInstructions ? { subjectInstructions: ctx.subjectInstructions } : {}),
    ...(ctx.instructions?.targetNumbers ? { targetNumbers: true } : {}),
    ...(ctx.senderName ? { signature: ctx.senderName } : {}),
  };
}

/** The template is tried on the first recipients (written and checked); nothing is saved yet. */
async function applyTemplate(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, template: CampaignTemplate): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not write the sample emails.");
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  job.brief = briefFor(ctx, template);
  job.kind = "generate";
  job.results = {};
  job.doneInRun = [];
  for (const r of job.recipients.slice(0, SAMPLE_COUNT)) {
    // One after the other, so the second sample is checked against the first (no repeated opening or subject).
    job.results[recipientKey(r)] = await writeEmail(r, job, auth);
  }
  await saveJob(key, job);
  return reply({ ...ctx, step: "template_review", template }, samplePreview(job, template));
}

function samplePreview(job: CreationJob, template: CampaignTemplate): string {
  const samples = ordered(job).filter((x) => x.e);
  const total = job.recipients.length;
  return [
    `Template **${template.name}**. ${samples.length === 1 ? "A sample email" : `${samples.length} sample emails`}, exactly as they will be sent — plain text, no design:`,
    "",
    ...samples.flatMap((x) => [x.e && !x.e.error ? emailBlock(x.n, x.r, x.e) : needsReviewBlock(x.n, x.r, x.e, { step: "template_review", atIso: "" }), ""]),
    `Reply **approve** to write all **${total}** emails with this template — they are written in the background while you choose the email account and the schedule, and each one is saved to the draft campaign as soon as it is ready.`,
    "Or tell me what to change in the structure, or pick another template number.",
  ].join("\n");
}

/** Template approved: the rest of the emails are written in the background; the draft campaign is created right away. */
async function startBackground(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not start writing the emails.");
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  if (!isRunningHere(key) && job.status !== "done") {
    // The samples are kept; only the other recipients are written.
    job.doneInRun = Object.keys(job.results);
    startRun(key, job, auth);
  }
  return createDraft(state, { ...ctx, background: true }, key);
}

/** The draft campaign (sender from the box, the default or the only account); every written email is saved to it. */
async function createDraft(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not create the campaign.");
  let campaignId = ctx.campaignId;
  if (!campaignId) {
    const created = await callTool(
      "create_campaign",
      { name: ctx.name, subject: SUBJECT_PLACEHOLDER, body: BODY_PLACEHOLDER, bodyFormat: "html", ...senderArgs(ctx, state.senderDefaults?.smtpSettingsId) },
      auth,
    );
    if (!created.ok) {
      if (created.code === "SMTP_SELECTION_REQUIRED") {
        const choices = (Array.isArray(created.details.choices) ? created.details.choices : []) as Array<{ id: number; fromEmail: string; fromName?: string }>;
        return askSender({ ...ctx, step: "smtp", smtpChoices: choices }, senderQuestion("this campaign"));
      }
      return reply({ ...ctx, step: "template_review" }, `I could not create the campaign: ${created.message}\n\nThe emails are still being written. Reply **approve** to try creating the campaign again, or **cancel**.`);
    }
    const id = created.data.id;
    campaignId = typeof id === "number" ? String(id) : typeof id === "string" ? id : undefined;
    if (!campaignId) return reply(ctx, "The campaign was created but I did not get its ID back. Please check your campaign list.");
  }
  const job = await attachCampaign(key, campaignId, auth);
  const total = job?.recipients.length ?? 0;
  return askSchedule(
    state,
    { ...ctx, step: "schedule", campaignId, saved: { added: total, rejected: 0, failedEmails: 0 } },
    [`Draft campaign **${ctx.name}** created. Every email is saved to it as soon as it is written.`, "", SCHEDULE_QUESTION].join("\n"),
    { activeCampaignId: campaignId },
  );
}

/** Waiting for the last emails: a progress box the chat refreshes by itself; the approval follows when all are written. */
function waitingReply(ctx: CampaignCreationState, job: CreationJob, before = ""): Patch {
  const total = job.recipients.length;
  const doneCount = Math.min(total, job.doneInRun.length);
  const status = `The schedule is saved. I'm still writing the emails: **${doneCount}/${total}** done. I'll show the confirmation here as soon as all of them are written — you don't need to type anything.`;
  const message = before ? `${before}\n\n${status}` : status;
  return reply(ctx, message, { formattedResponse: needsInput(message, ctx, { kind: "progress", done: doneCount, total }) });
}

/** After the schedule: the approval once every email is written and saved; until then the waiting step. */
async function finishWhenReady(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, sendText: string, details?: string[]): Promise<Patch> {
  const auth = authOf(state);
  let job = await currentJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). The draft campaign stays on the Campaigns page.", ctx.campaignId ? { activeCampaignId: ctx.campaignId } : {});
  if (job.status === "running" && !isRunningHere(key) && auth) {
    startRun(key, job, auth);
    job = (await currentJob(key)) ?? job;
  }
  // Still writing: the confirmation now, no waiting. A confirm starts the campaign by itself once the last email is saved.
  if (job.status === "running") {
    if (auth && ctx.campaignId) job = (await attachCampaign(key, ctx.campaignId, auth)) ?? job;
    const failedEmails = Object.values(job.results).filter((e) => e.error).length;
    return finish(state, { ...ctx, saved: { added: job.savedAdded ?? 0, rejected: 0, failedEmails } }, key, sendText, details);
  }
  const waitCtx: CampaignCreationState = { ...ctx, step: "waiting", pendingFinish: { sendText, ...(details ? { details } : {}) } };
  if (job.status === "ready") return waitingReply(waitCtx, job);
  // Everything is written: the last ones saved too, then the approval.
  if (auth && ctx.campaignId) job = (await attachCampaign(key, ctx.campaignId, auth)) ?? job;
  const added = job.savedAdded ?? 0;
  const failedEmails = Object.values(job.results).filter((e) => e.error).length;
  if (added === 0) {
    return done(
      [
        `No email could be saved to **${ctx.name}**${job.saveError ? ` (${job.saveError})` : ""}. The draft campaign stays on the Campaigns page, nothing was sent.`,
        failedEmails ? `${failedEmails} recipient${failedEmails === 1 ? "" : "s"} need review — most often the file has nothing about them to write from. Add details to the file and say **create campaign** again.` : "",
      ].filter(Boolean).join("\n\n"),
      ctx.campaignId ? { activeCampaignId: ctx.campaignId } : {},
    );
  }
  return finish(state, { ...ctx, saved: { added, rejected: 0, failedEmails } }, key, sendText, details);
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
  if (APPROVE_RE.test(msg) && msg.length <= 30) return ctx.kind === "personalize" ? createAndSave(state, ctx, key) : startBackground(state, ctx, key);
  // The samples showed rows with nothing to write from: the corrected file comes next (same template).
  if (canReupload(ctx) && !ctx.background && UPLOAD_AGAIN_RE.test(msg)) {
    return reply({ ...ctx, step: "file" }, `Send the corrected file with the 📎 button. I'll keep the name, purpose and the **${ctx.template?.name ?? "chosen"}** template and show new samples.

${FILE_QUESTION}`);
  }
  if (/^#?\d{1,2}\b/.test(msg)) return pickedTemplate(state, ctx, key, msg);
  if (msg.length < 3 || !ctx.template) return reply(ctx, "Reply **approve** to continue, or tell me what to change in the structure.");
  return applyTemplate(state, ctx, key, { name: `${ctx.template.name} (edited)`, structure: `${ctx.template.structure} Also: ${msg.slice(0, 400)}` });
}

// ── Step 7: create the draft, save recipients, schedule ──────────────────────

export const SCHEDULE_QUESTION =
  "**When should it be sent?** Set it in the box below and press **Confirm schedule** — or reply **now**, or a date and time (e.g. *tomorrow 10am*, *kal subah 9 baje*, *15 Nov 3pm*).";

/** The email account question; the chat shows the sender box under it (several accounts / aliases can be picked). */
export function senderQuestion(what: string): string {
  return [
    `**Which email account should send ${what}?**`,
    "Pick one or more in the box below and press **Confirm sender**. Several accounts take turns sending (each sends at most 20 emails a day). You can also reply with the email address.",
  ].join("\n");
}

export function askSender(ctx: CampaignCreationState, message: string): Patch {
  return reply(ctx, message, { formattedResponse: needsInput(message, ctx, { kind: "sender" }) });
}

/** create_campaign's sender fields: the accounts (and aliases) from the sender box, else one account. */
export function senderArgs(ctx: CampaignCreationState, fallbackId?: number | null): Record<string, unknown> {
  if (ctx.smtpSettingIds?.length) {
    return { smtpSettingIds: ctx.smtpSettingIds, ...(ctx.aliasIds?.length ? { aliasIds: ctx.aliasIds } : {}) };
  }
  const id = ctx.smtpSettingsId ?? fallbackId ?? undefined;
  return id ? { smtpSettingsId: id } : {};
}

/** A schedule-step reply: the chat shows the schedule box (start, per day, days, hours, stop) under it. */
export function askSchedule(state: AgentGraphStateType, ctx: CampaignCreationState, message: string, extra: Patch = {}): Patch {
  const smtpSettingsId = ctx.smtpSettingsId ?? state.senderDefaults?.smtpSettingsId;
  const form: ScheduleForm = { kind: "schedule", recipientCount: ctx.saved?.added ?? 0, ...(smtpSettingsId ? { smtpSettingsId } : {}) };
  return reply(ctx, message, { ...extra, formattedResponse: needsInput(message, ctx, form as unknown as Obj) });
}

async function createAndSave(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not create the campaign.");
  const job = await loadJob(key);
  if (!job) return done("I lost this campaign's data (it may have expired). Say **create campaign** to start again.");
  if (!ctx.template) return reply({ ...ctx, step: "template_pick" }, "Please choose a template first.");

  let campaignId = ctx.campaignId;
  if (!campaignId) {
    const created = await callTool(
      "create_campaign",
      {
        name: ctx.name,
        subject: SUBJECT_PLACEHOLDER,
        body: BODY_PLACEHOLDER,
        bodyFormat: "html",
        ...senderArgs(ctx, state.senderDefaults?.smtpSettingsId),
      },
      auth,
    );
    if (!created.ok) {
      if (created.code === "SMTP_SELECTION_REQUIRED") {
        const choices = (Array.isArray(created.details.choices) ? created.details.choices : []) as Array<{ id: number; fromEmail: string; fromName?: string }>;
        return askSender({ ...ctx, step: "smtp", smtpChoices: choices }, senderQuestion("this campaign"));
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

  const saved = await callTool("save_csv_recipients", { campaignId, rows, allowDuplicates: true }, auth);
  if (!saved.ok) return reply(ctx, `The draft campaign is created, but saving the recipients failed: ${saved.message}\n\nReply **approve** to try saving again, or **cancel**.`, { activeCampaignId: campaignId });
  const added = Number(saved.data.added) || 0;
  const rejected = Number(saved.data.rejected) || 0;
  const notAdded = rows.length - added;

  return askSchedule(
    state,
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
  const what = ctx.kind === "personalize" ? "these emails" : "this campaign";
  // The sender box: one or more accounts (sends rotate), optionally only some aliases.
  if (state.senderChoice) {
    const ids = [...new Set(state.senderChoice.smtpSettingIds)];
    if (choices.length > 0 && ids.some((id) => !choices.some((c) => c.id === id))) {
      return askSender(ctx, `That account is not one of the accounts I can use. Please choose again.\n\n${senderQuestion(what)}`);
    }
    const chosen = { ...ctx, smtpSettingsId: ids[0]!, smtpSettingIds: ids, aliasIds: [...new Set(state.senderChoice.aliasIds)] };
    if (ctx.kind === "personalize") return savePersonalized(state, { ...chosen, step: "review" }, key);
    if (ctx.background) return createDraft(state, chosen, key);
    return createAndSave(state, { ...chosen, step: "template_review" }, key);
  }
  const n = Number(msg.match(/^#?(\d{1,2})$/)?.[1]);
  const pick = (n >= 1 ? choices[n - 1] : undefined) ?? choices.find((c) => msg.toLowerCase().includes(c.fromEmail.toLowerCase()));
  if (!pick) return askSender(ctx, `Please choose the account in the box below, or reply with its email address.\n\n${senderQuestion(what)}`);
  if (ctx.kind === "personalize") return savePersonalized(state, { ...ctx, step: "review", smtpSettingsId: pick.id }, key);
  if (ctx.background) return createDraft(state, { ...ctx, smtpSettingsId: pick.id }, key);
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

  // The schedule box: every setting is saved on the draft, then the start is confirmed.
  if (state.scheduleChoice) {
    const choice = state.scheduleChoice;
    const fields = scheduleUpdateArgs(choice, (local) => zonedToIso(local, timeZone));
    if (!fields.ok) return askSchedule(state, ctx, `${fields.error}\n\n${SCHEDULE_QUESTION}`);
    const saved = await callTool("update_campaign", { campaignId: ctx.campaignId, ...fields.args }, auth);
    if (!saved.ok) return askSchedule(state, ctx, `I could not save that schedule: ${saved.message}\n\n${SCHEDULE_QUESTION}`);
    const sendText = choice.startAt ? `**${choice.startAt.replace("T", " ")}** (${timeZone})` : "now, as soon as you confirm";
    return ctx.background ? finishWhenReady(state, ctx, key, sendText, scheduleLines(choice, timeZone)) : finish(state, ctx, key, sendText, scheduleLines(choice, timeZone));
  }

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
  if (status === "unclear") return askSchedule(state, ctx, `I could not read a time from that. ${SCHEDULE_QUESTION}`);

  let sendText = "now, as soon as you confirm";
  if (status === "scheduled") {
    const iso = zonedToIso(local, timeZone);
    if (!iso) return askSchedule(state, ctx, `I could not read a time from that. ${SCHEDULE_QUESTION}`);
    if (new Date(iso).getTime() <= Date.now() + 60_000) return askSchedule(state, ctx, `**${local}** (${timeZone}) has already passed. Please give a time in the future.`);
    const updated = await callTool("update_campaign", { campaignId: ctx.campaignId, scheduledAt: iso }, auth);
    if (!updated.ok) return askSchedule(state, ctx, `I could not set that time: ${updated.message}\n\n${SCHEDULE_QUESTION}`);
    sendText = `**${local}** (${timeZone})`;
  }
  return ctx.background ? finishWhenReady(state, ctx, key, sendText) : finish(state, ctx, key, sendText);
}

// ── Step 8: summary + confirmation (approval card) ───────────────────────────

function senderLine(ctx: CampaignCreationState, fallback: string): string {
  const emails = (ctx.smtpSettingIds ?? []).map((id) => ctx.smtpChoices?.find((c) => c.id === id)?.fromEmail).filter((e): e is string => !!e);
  const aliases = ctx.aliasIds?.length ? ` (${ctx.aliasIds.length} selected alias${ctx.aliasIds.length === 1 ? "" : "es"})` : "";
  if (emails.length > 1) return `${emails.map((e) => `**${e}**`).join(", ")} — they take turns${aliases}`;
  return `**${emails[0] ?? fallback}**${aliases}`;
}

async function finish(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, sendText: string, scheduleDetails?: string[]): Promise<Patch> {
  const job = await loadJob(key);
  const written = job ? Object.values(job.results).filter((e) => !e.error) : [];
  const low = written.filter((e) => e.level === "low").length;
  const badLinks = written.flatMap((e) => e.links).filter((l) => !l.ok).length;
  const sender = ctx.smtpChoices?.find((c) => c.id === ctx.smtpSettingsId)?.fromEmail ?? state.senderDefaults?.fromEmail ?? "your default email account";
  const saved = ctx.saved ?? { added: 0, rejected: 0, failedEmails: 0 };
  // Emails still being written in the background: confirm now, the campaign starts when the last one is saved.
  const writing = !!job && ctx.background === true && job.status === "running";
  const total = job?.recipients.length ?? 0;
  const doneCount = Math.min(total, job?.doneInRun.length ?? 0);
  const summary = [
    `**Ready to ${sendText.startsWith("now") ? "start" : "schedule"} "${ctx.name}"**`,
    "",
    ...(writing
      ? [`- Emails: **${doneCount}/${total}** written so far — the rest are being written in the background and saved to the campaign one by one.`]
      : []),
    `- Recipients: **${saved.added}** saved${writing ? " so far" : ""}${ctx.file?.skipped ? `, ${ctx.file.skipped} rows skipped in the file` : ""}${saved.failedEmails ? `, ${saved.failedEmails} need review (not saved)` : ""}`,
    `- Emails: **${written.length}** personalized emails and subjects${low ? ` (${low} with little data to personalize)` : ""}${badLinks ? `, ${badLinks} links could not be opened` : ""}`,
    ...(job && ctx.background
      ? job.recipients
          .map((r) => ({ r, e: job.results[recipientKey(r)] }))
          .filter((x) => x.e?.error)
          .slice(0, 10)
          .map((x) => `- Not saved (needs review): ${x.r.email}${x.r.company ? ` (${x.r.company})` : ""} — ${x.e!.error}${x.e!.issues?.length ? `: ${x.e!.issues.slice(0, 2).join("; ")}` : ""}`)
      : []),
    ctx.kind === "personalize" ? `- Settings: ${settingsLine(ctx.personalize)}` : `- Template: **${ctx.template?.name ?? "—"}**`,
    `- Sender: ${senderLine(ctx, sender)}`,
    ...(scheduleDetails ?? [`- Send: ${sendText}`]),
    ...(ctx.kind === "personalize" && /running|in_progress|scheduled/i.test(ctx.source?.status ?? "")
      ? [`\n**${ctx.source?.name}** is still ${ctx.source?.status} and sends its own email to the same people. Pause it if they should only get these emails.`]
      : []),
    "",
    writing
      ? "Nothing is sent until you confirm. You can confirm now: the campaign starts by itself as soon as every email is written — you don't need to wait here."
      : "Nothing is sent until you confirm.",
  ].join("\n");
  // A running job keeps writing and saving; it is cleaned up by its TTL.
  if (!writing) await deleteJob(key);
  return {
    intent: "start_campaign",
    toolName: "start_campaign",
    toolArgs: { campaignId: ctx.campaignId, ...(writing ? { writingJobKey: key } : {}) },
    crmAction: { confirmText: summary, requiresApproval: true },
    campaignCreation: undefined,
    activeCampaignId: ctx.campaignId,
  };
}
