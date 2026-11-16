/**
 * src/lib/personalizeEmailsFlow.ts
 *
 * "Generate personalized emails" (chat button): one personal email (and, if chosen, its follow-ups) for every
 * recipient of an EXISTING campaign, written by the agent itself (the backend has no generation endpoint).
 *
 *   1. which campaign?           → every campaign is listed, whatever its status (draft, running, paused, completed …)
 *   2. mode → tone → CTA → sequence type → emails per recipient → breakup email? → short emails?   (each asked)
 *   3. right after the last choice (no more questions): every recipient's EXISTING email (their own ai_subject /
 *      ai_body, else the campaign's subject / body with their row filled in) is rewritten to the settings in the
 *      background ("restyle"), links researched again, checked like a new email; no existing email → a new one.
 *      The offer and the signing name come from those emails / the account.
 *   4. review                    → the same review as "create campaign"
 *   5. save                      → a NEW draft campaign "<name> (personalized)" with the same recipients and sender;
 *                                  every row gets ai_subject / ai_body (+ ai_followup_N), the follow-ups become the
 *                                  campaign's follow-up templates. The chosen campaign is never changed (the backend
 *                                  cannot edit a sent or running campaign's recipients).
 *   6. schedule + confirmation   → the same steps as "create campaign"
 *
 * It runs inside the campaign creation state (campaignCreation.kind = "personalize"), so routing, cancel,
 * progress messages and review work exactly as in that flow.
 */

import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import { getOpenAIService } from "../services/openai.service.js";
import { COLUMN_READER_PROMPT } from "../prompts/campaignCreation.prompt.js";
import { guessLayout, layoutFromLlm, recipientsFromTable } from "./campaignCreationTable.js";
import { BODY_PLACEHOLDER, SUBJECT_PLACEHOLDER } from "./campaignTemplates.js";
import { loadJob, saveJob, startRun, type CampaignBrief, type CreationJob } from "../services/campaignCreationJob.service.js";
import { htmlToBody, splitBody } from "./emailRealism.js";
import type { CampaignCreationState, PersonalizeSettings } from "./campaignCreationContext.js";
import {
  MAX_RECIPIENTS,
  authOf,
  callTool,
  clearOtherFlows,
  done,
  reply,
  type Patch,
} from "./campaignCreationFlow.js";
import { createLogger } from "./logger.js";

const log = createLogger("personalizeEmailsFlow");

type Obj = Record<string, unknown>;

// ── Choices (keys = the generate_personalized_emails tool's values) ─────────

interface Choice {
  key: string;
  label: string;
  /** What the writer is told. */
  text: string;
}

export const MODES: Choice[] = [
  { key: "low_promotional_plaintext", label: "Plain text, low-promotional", text: "Plain, low-key 1-to-1 email with no selling language." },
  { key: "executive_direct", label: "Executive / direct", text: "Direct and to the point, written for a busy decision maker." },
  { key: "friendly_human", label: "Friendly & human", text: "Warm and conversational, like a message to a friendly contact." },
  { key: "value_first", label: "Value first", text: "Lead with one useful idea or insight for them before mentioning the offer." },
];

export const TONES: Choice[] = [
  { key: "founder_style", label: "Founder style", text: "Tone: a founder writing personally, first person, honest and brief." },
  { key: "consultant_style", label: "Consultant style", text: "Tone: a consultant who has seen this problem before, calm and expert." },
  { key: "executive_direct", label: "Executive direct", text: "Tone: executive, short sentences, no small talk." },
  { key: "friendly_human", label: "Friendly human", text: "Tone: friendly and relaxed, still professional." },
  { key: "technical_advisor", label: "Technical advisor", text: "Tone: a technical advisor, precise, names the technical detail." },
  { key: "concise_enterprise", label: "Concise enterprise", text: "Tone: concise and formal enough for a large company." },
];

export const CTAS: Choice[] = [
  { key: "reply_cta", label: "Ask for a short reply", text: "Closing question: ask for a quick reply (e.g. \"Is this on your list this quarter?\")." },
  { key: "soft_meeting_cta", label: "Soft meeting ask", text: "Closing question: suggest a short call without pressure (e.g. \"Worth a quick 15-minute chat?\")." },
  { key: "direct_cta", label: "Direct meeting ask", text: "Closing question: ask directly for a call time (e.g. \"Are you free Tuesday or Wednesday for 15 minutes?\")." },
  { key: "curiosity_cta", label: "Curiosity question", text: "Closing question: a curiosity question about their situation." },
  { key: "value_cta", label: "Offer something useful", text: "Closing question: offer to send something useful (an idea, an example) and ask if they want it." },
  { key: "no_pressure_cta", label: "No pressure", text: "Closing question: a no-pressure question (e.g. \"Open to hearing more?\")." },
];

export const SEQUENCES: Choice[] = [
  { key: "cold_outreach", label: "Cold outreach", text: "They do not know the sender yet." },
  { key: "warm_followup", label: "Warm follow-up", text: "There was some earlier contact; friendlier." },
  { key: "reengagement", label: "Re-engagement", text: "They went quiet a while ago; give a fresh reason to talk." },
  { key: "founder_outreach", label: "Founder outreach", text: "Founder to founder, very direct." },
];

const SKIP_RE = /^(skip|default|any|koi bhi|kuch bhi|aap dekh lo|tum dekh lo)$/i;
const YES_RE = /^(yes|y|yeah|yep|haan|han|ji|ok|okay|sure|theek|thik|1)\b/i;
const NO_RE = /^(no|n|nope|nahi|nahin|na|mat|2)\b/i;

function choiceList(title: string, choices: Choice[]): string {
  return [title, "", ...choices.map((c, i) => `${i + 1}. **${c.label}**${i === 0 ? " *(default)*" : ""}`), "", "Reply with the number or the name (**skip** = default)."].join("\n");
}

/** A number, a label / key word, or skip (→ the first choice). */
function pick(msg: string, choices: Choice[]): Choice | undefined {
  const t = msg.trim().toLowerCase();
  if (SKIP_RE.test(t)) return choices[0];
  const n = Number(t.match(/^#?(\d{1,2})\b/)?.[1]);
  if (n >= 1 && n <= choices.length) return choices[n - 1];
  return (
    choices.find((c) => t === c.label.toLowerCase() || t === c.key.replace(/_/g, " ")) ??
    choices.find((c) => c.label.toLowerCase().split(/[\s/,&-]+/).some((w) => w.length > 3 && t.includes(w)))
  );
}

const nameOf = (choices: Choice[], key: string | undefined) => choices.find((c) => c.key === key)?.label ?? "—";

const QUESTIONS = {
  p_mode: () => choiceList("**1/7 — Mode:** how should the emails read?", MODES),
  p_tone: () => choiceList("**2/7 — Tone:** whose voice?", TONES),
  p_cta: () => choiceList("**3/7 — Call to action:** how should each email end?", CTAS),
  p_sequence: () => choiceList("**4/7 — Sequence type:**", SEQUENCES),
  p_length: () =>
    [
      "**5/7 — How many emails per recipient?**",
      "",
      "- **1** — just one email",
      "- **3** — the first email + 2 follow-ups",
      "- **4** — the first email + 3 follow-ups",
      "",
      "Reply **1**, **3** or **4**.",
    ].join("\n"),
  p_breakup: () => "**6/7 — Should the last follow-up be a polite \"breakup\" email** (closes the loop, no pressure)? Reply **yes** or **no**.",
  p_short: () => "**7/7 — Keep the emails extra short?** Reply **yes** or **no**.",
};

// ── Entry ────────────────────────────────────────────────────────────────────

/** "Generate personalized emails": list every campaign and ask which one. */
export async function startPersonalize(state: AgentGraphStateType): Promise<Patch> {
  const base: CampaignCreationState = { step: "pick_campaign", kind: "personalize", atIso: new Date().toISOString() };
  const auth = authOf(state);
  if (!auth) return done("Please sign in again — I could not load your campaigns.");
  const listed = await callTool("get_all_campaigns", {}, auth);
  const raw = listed.ok ? (Array.isArray(listed.data) ? listed.data : Array.isArray(listed.data.campaigns) ? listed.data.campaigns : Object.values(listed.data)) : [];
  const campaigns = (raw as Obj[])
    .filter((c) => c && typeof c === "object" && (typeof c.id === "string" || typeof c.id === "number"))
    .map((c) => ({ id: String(c.id), name: typeof c.name === "string" ? c.name : `Campaign ${String(c.id)}`, status: typeof c.status === "string" ? c.status : "" }));
  if (!listed.ok) return done(`I could not load your campaigns: ${listed.message}`);
  if (campaigns.length === 0) return done("You have no campaigns yet. Say **create campaign** to make one — it writes a personal email for every recipient too.");
  const shown = campaigns.slice(0, 50);
  return reply(
    { ...base, campaignChoices: shown },
    [
      "Let's write a personal email for every recipient of one of your campaigns. **Which campaign?** (any status)",
      "",
      ...shown.map((c, i) => `${i + 1}. **${c.name}** — ${c.status || "unknown"}`),
      campaigns.length > shown.length ? `\n…and ${campaigns.length - shown.length} more: reply with the name.` : "",
      "",
      "Reply with the number or the name.",
    ].filter((l) => l !== "").join("\n"),
    clearOtherFlows(),
  );
}

/** The personalize steps; the shared steps (purpose, sender, generating, review, smtp, schedule) stay in campaignCreationFlow. */
export async function handlePersonalizeStep(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch | undefined> {
  const s = ctx.personalize ?? {};
  switch (ctx.step) {
    case "pick_campaign":
      return pickedCampaign(state, ctx, key, msg);
    case "p_mode": {
      const c = pick(msg, MODES);
      return c ? ask({ ...ctx, personalize: { ...s, mode: c.key } }, "p_tone") : reply(ctx, QUESTIONS.p_mode());
    }
    case "p_tone": {
      const c = pick(msg, TONES);
      return c ? ask({ ...ctx, personalize: { ...s, tone: c.key } }, "p_cta") : reply(ctx, QUESTIONS.p_tone());
    }
    case "p_cta": {
      const c = pick(msg, CTAS);
      return c ? ask({ ...ctx, personalize: { ...s, cta: c.key } }, "p_sequence") : reply(ctx, QUESTIONS.p_cta());
    }
    case "p_sequence": {
      const c = pick(msg, SEQUENCES);
      return c ? ask({ ...ctx, personalize: { ...s, sequenceType: c.key } }, "p_length") : reply(ctx, QUESTIONS.p_sequence());
    }
    case "p_length": {
      const n = SKIP_RE.test(msg) ? 1 : Number(msg.match(/\b([134])\b/)?.[1]);
      if (![1, 3, 4].includes(n)) return reply(ctx, QUESTIONS.p_length());
      // One email has no follow-ups, so there is no breakup email to ask about.
      return n === 1
        ? ask({ ...ctx, personalize: { ...s, length: 1, breakup: false } }, "p_short")
        : ask({ ...ctx, personalize: { ...s, length: n } }, "p_breakup");
    }
    case "p_breakup":
    case "p_short": {
      const yes = YES_RE.test(msg) ? true : NO_RE.test(msg) || SKIP_RE.test(msg) ? false : undefined;
      if (yes === undefined) return reply(ctx, QUESTIONS[ctx.step]());
      if (ctx.step === "p_breakup") return ask({ ...ctx, personalize: { ...s, breakup: yes } }, "p_short");
      return settingsDone(state, { ...ctx, personalize: { ...s, short: yes } }, key);
    }
    default:
      return undefined;
  }
}

function ask(ctx: CampaignCreationState, step: keyof typeof QUESTIONS): Patch {
  return reply({ ...ctx, step }, QUESTIONS[step]());
}

// ── Step 1: the campaign and its recipients ──────────────────────────────────

/** Recipients who replied, bounced, complained or unsubscribed are not written to again. */
const SKIP_STATUSES = new Set(["failed", "bounced", "complained", "unsubscribed", "replied"]);

async function pickedCampaign(state: AgentGraphStateType, ctx: CampaignCreationState, key: string, msg: string): Promise<Patch> {
  const choices = ctx.campaignChoices ?? [];
  const n = Number(msg.match(/^#?(\d{1,3})$/)?.[1]);
  const t = msg.toLowerCase().trim();
  const chosen =
    (n >= 1 ? choices[n - 1] : undefined) ??
    choices.find((c) => c.name.toLowerCase() === t) ??
    choices.find((c) => t.length >= 3 && c.name.toLowerCase().includes(t));
  if (!chosen) return reply(ctx, `Please reply with a number from 1 to ${choices.length}, or the campaign name.`);
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not read the campaign.");

  const got = await callTool("get_campaign_recipients", { campaignId: chosen.id, limit: MAX_RECIPIENTS * 3 }, auth);
  if (!got.ok) return reply(ctx, `I could not read **${chosen.name}**: ${got.message}\n\nPick another campaign, or **cancel**.`);
  const campaign = (got.data.campaign ?? {}) as Obj;
  const all = (Array.isArray(got.data.recipients) ? got.data.recipients : []) as Obj[];
  const eligible = all.filter((r) => typeof r.email === "string" && !r.repliedAt && !SKIP_STATUSES.has(String(r.status ?? "").toLowerCase()));
  if (eligible.length === 0) {
    const why = all.length === 0 ? "has no recipients" : "has no recipients left to write to (all replied, bounced or unsubscribed)";
    return reply(ctx, `**${chosen.name}** ${why}. Pick another campaign, or **cancel**.`);
  }

  // The recipients' uploaded rows become a table, read like an uploaded file (same columns, links, names).
  const keys = [...new Set(eligible.flatMap((r) => Object.keys((r.customFields ?? {}) as Obj)))].filter((k) => !/^ai_/i.test(k) && !/^(email|name)$/i.test(k));
  const header = ["email", "name", ...keys];
  const table = [header, ...eligible.map((r) => [String(r.email), typeof r.name === "string" ? r.name : "", ...keys.map((k) => String(((r.customFields ?? {}) as Obj)[k] ?? ""))])];
  let layout = guessLayout(table);
  const openai = getOpenAIService();
  if (openai) {
    try {
      layout = layoutFromLlm(await openai.completeJson(COLUMN_READER_PROMPT, JSON.stringify({ rows: table.slice(0, 8) }), 0), table);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "column reading failed — using the value-based guess");
    }
  }
  // The columns keep the campaign's own names (they are saved again on the new copy); only their meaning comes from the reader.
  layout = { ...layout, hasHeader: true, columns: layout.columns.map((c) => ({ ...c, label: header[c.index] ?? c.label })) };
  const { recipients: read, skipped } = recipientsFromTable(table, layout);
  const recipients = read.slice(0, MAX_RECIPIENTS);
  if (recipients.length === 0) return reply(ctx, `I found no valid email address in **${chosen.name}**. Pick another campaign, or **cancel**.`);

  // The email each recipient already has: their own ai_subject / ai_body (written earlier), else the campaign's
  // subject and body with their row filled in. "Generate" rewrites exactly these to the chosen settings.
  const byEmail = new Map(eligible.map((r) => [String(r.email).toLowerCase(), r]));
  const existing: NonNullable<CreationJob["existing"]> = {};
  let signer: string | undefined;
  for (const r of recipients) {
    const raw = byEmail.get(r.email.toLowerCase());
    const cf = ((raw?.customFields ?? {}) as Record<string, unknown>);
    const own = typeof cf.ai_body === "string" && cf.ai_body.trim() ? { subject: String(cf.ai_subject ?? ""), html: cf.ai_body } : undefined;
    const html = own?.html ?? fillPlaceholders(String(campaign.body ?? ""), r, typeof raw?.name === "string" ? raw.name : undefined, cf);
    const subject = own?.subject || fillPlaceholders(String(campaign.subject ?? ""), r, typeof raw?.name === "string" ? raw.name : undefined, cf);
    const body = htmlToBody(html).trim();
    if (!body || /\{\{\s*ai_body\s*\}\}/i.test(body)) continue;
    existing[r.email.toLowerCase()] = { subject: subject.replace(/\{\{?\s*ai_subject\s*\}?\}/gi, "").trim(), body };
    signer ??= signerOf(body);
  }

  const job: CreationJob = { status: "ready", kind: "restyle", recipients, existing, results: {}, doneInRun: [], updatedAt: "" };
  await saveJob(key, job);

  const status = typeof campaign.status === "string" ? campaign.status : chosen.status;
  const source = {
    id: chosen.id,
    name: typeof campaign.name === "string" && campaign.name ? campaign.name : chosen.name,
    status,
    smtpSettingsId: typeof campaign.smtpSettingsId === "number" ? campaign.smtpSettingsId : null,
  };
  const purpose = purposeFromCampaign(String(campaign.subject ?? ""), String(campaign.body ?? ""));
  const links = recipients.flatMap((r) => r.links).length;
  const left = all.length - eligible.length;
  const over = read.length - recipients.length;
  return reply(
    {
      ...ctx,
      step: "p_mode",
      source,
      name: `${source.name} (personalized)`.slice(0, 255),
      purpose: purpose ?? offerFromEmails(existing) ?? `Inferred from the campaign name "${source.name}"`,
      ...(signer ? { senderName: signer } : {}),
      file: {
        fileName: source.name,
        totalRows: all.length,
        recipients: recipients.length,
        skipped: skipped.length + left,
        skippedSample: [],
        columns: layout.columns.map((c) => c.label),
        withLinks: recipients.filter((r) => r.links.length > 0).length,
        overLimit: over,
      },
    },
    [
      `**${source.name}** (${status || "unknown status"}): **${recipients.length}** recipients to write to${links ? `, ${links} links to research` : ""}.`,
      left ? `- ${left} left out (already replied, bounced or unsubscribed).` : "",
      over ? `- ${over} more left out: one run writes up to ${MAX_RECIPIENTS}.` : "",
      "",
      "This campaign itself is not changed: the emails go into a **new draft copy** with the same recipients and sender.",
      "",
      "A few choices first.",
      "",
      QUESTIONS.p_mode(),
    ].filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "").join("\n"),
  );
}

/** The campaign's own subject + text as "what the sender offers"; none when it only holds placeholders. */
export function purposeFromCampaign(subject: string, body: string): string | undefined {
  const text = body
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\{\{?\s*ai_(subject|body)\s*\}?\}/gi, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  const sub = subject.replace(/\{\{?\s*ai_(subject|body)\s*\}?\}/gi, "").trim();
  if (text.replace(/\{\{?[^}]*\}?\}/g, "").trim().split(/\s+/).length < 8) return undefined;
  return `What the existing campaign email says (use it only for what the sender offers; do not copy it): subject "${sub}". ${text}`.slice(0, 1500);
}

/** {{name}}, {first_name}, {{company}} … of a campaign text filled from one recipient's row; unknown ones are dropped. */
export function fillPlaceholders(text: string, r: { email: string; firstName?: string; company?: string }, name: string | undefined, fields: Record<string, unknown>): string {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === "string" || typeof v === "number") values[k.toLowerCase()] = String(v);
  values.email = r.email;
  if (name) values.name = name;
  const first = r.firstName ?? name?.split(/\s+/)[0];
  if (first) values.first_name = values.firstname = first;
  if (r.company) values.company ??= r.company;
  return text.replace(/\{\{?\s*([a-z0-9_ ]+?)\s*\}?\}/gi, (_m, k: string) => (/^ai_/i.test(k) ? _m : values[k.toLowerCase().replace(/\s+/g, "_")] ?? ""));
}

/** The first name under the sign-off of an existing email ("Best,\nBassam" → "Bassam"). */
function signerOf(body: string): string | undefined {
  const sig = splitBody(body).signature;
  const name = sig[sig.length - 1]?.trim().split(/\s+/)[0];
  return sig.length >= 2 && name && /^[\p{L}][\p{L}'-]{1,30}$/u.test(name) ? name : undefined;
}

/** When the campaign itself only holds {{ai_body}}: the offer as the recipients' existing emails describe it. */
function offerFromEmails(existing: NonNullable<CreationJob["existing"]>): string | undefined {
  const sample = Object.values(existing).slice(0, 2).map((e) => splitBody(e.body).paragraphs.join(" ")).filter(Boolean);
  return sample.length ? `What the sender offers, as their earlier emails to these recipients say (do not copy them): ${sample.join(" | ")}`.slice(0, 1500) : undefined;
}

// ── Step 2 done → rewrite every existing email to the settings, right away ────

async function settingsDone(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not start writing the emails.");
  const job = await loadJob(key);
  if (!job || job.recipients.length === 0) return done("I lost the campaign's recipients (they may have expired). Say **generate personalized emails** to start again.");

  const senderName = state.senderDefaults?.fromName?.trim() || ctx.senderName || "";
  const brief = personalizeBrief(ctx.personalize);
  job.brief = {
    name: ctx.name ?? "",
    purpose: ctx.purpose ?? "",
    ...(senderName ? { senderName } : {}),
    language: "English, unless the existing emails are in another language",
    ...brief,
  };
  job.kind = "restyle";
  job.instruction = `Rewrite this email to these settings, keeping what is specific to this recipient: ${brief.structure ?? ""}`;
  job.results = {};
  job.doneInRun = [];
  startRun(key, job, auth);

  const withEmail = Object.keys(job.existing ?? {}).length;
  const fresh = job.recipients.length - withEmail;
  return reply(
    { ...ctx, step: "generating", afterRun: "review", ...(senderName ? { senderName } : {}) },
    [
      `Settings saved: ${settingsLine(ctx.personalize)}.`,
      "",
      `Rewriting the existing email of **${withEmail}** recipient${withEmail === 1 ? "" : "s"} to these settings${fresh > 0 ? `, and writing a new one for **${fresh}** who had none` : ""}${brief.sequence ? `, with ${brief.sequence.count} follow-ups each` : ""}.`,
      "",
      "Send any message (e.g. **status**) to see the progress — I'll show you samples as soon as it's done.",
    ].join("\n"),
  );
}

export function settingsLine(s: PersonalizeSettings | undefined): string {
  if (!s) return "—";
  const emails = s.length && s.length > 1 ? `${s.length} emails per recipient${s.breakup ? " (last one a breakup email)" : ""}` : "1 email per recipient";
  return [
    `mode **${nameOf(MODES, s.mode)}**`,
    `tone **${nameOf(TONES, s.tone)}**`,
    `CTA **${nameOf(CTAS, s.cta)}**`,
    `**${nameOf(SEQUENCES, s.sequenceType)}**`,
    emails,
    s.short ? "extra short" : "normal length",
  ].join(", ");
}

/** The writer's instructions for these settings (CampaignBrief.structure + sequence). */
export function personalizeBrief(s: PersonalizeSettings | undefined): Pick<CampaignBrief, "structure" | "sequence"> {
  if (!s) return {};
  const text = (choices: Choice[], k: string | undefined) => choices.find((c) => c.key === k)?.text;
  const structure = [
    text(MODES, s.mode),
    text(TONES, s.tone),
    text(CTAS, s.cta),
    text(SEQUENCES, s.sequenceType) ? `Relationship: ${text(SEQUENCES, s.sequenceType)}` : undefined,
    s.short ? "Keep it short: about 50–70 words between the greeting and the sign-off." : undefined,
  ].filter(Boolean).join(" ");
  const count = s.length && s.length > 1 ? s.length - 1 : 0;
  return {
    ...(structure ? { structure } : {}),
    ...(count ? { sequence: { type: s.sequenceType ?? "cold_outreach", count, breakup: !!s.breakup, short: !!s.short } } : {}),
  };
}

// ── Step 5: save to a new draft campaign ─────────────────────────────────────

/** custom_fields is varchar(5000) in the backend; keep each row's JSON under this. */
const MAX_CUSTOM_FIELDS_CHARS = 4800;

/** One recipient row: its original columns + the written email; too-long original columns are dropped first. */
export function buildRow(
  fields: Record<string, string>,
  email: string,
  name: string | undefined,
  written: Record<string, string>,
): { row: Record<string, string>; trimmed: boolean } {
  const original: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (/^(email|e-mail|name)$/i.test(k) || /^ai_/i.test(k) || v === email) continue;
    original[k] = v;
  }
  let trimmed = false;
  const size = () => JSON.stringify({ ...original, ...written }).length;
  while (size() > MAX_CUSTOM_FIELDS_CHARS && Object.keys(original).length > 0) {
    const longest = Object.keys(original).sort((a, b) => original[b]!.length - original[a]!.length)[0]!;
    delete original[longest];
    trimmed = true;
  }
  return { row: { email, ...(name ? { name } : {}), ...original, ...written }, trimmed };
}

export async function savePersonalized(state: AgentGraphStateType, ctx: CampaignCreationState, key: string): Promise<Patch> {
  const auth = authOf(state);
  if (!auth) return reply(ctx, "Please sign in again — I could not save the emails.");
  const job = await loadJob(key);
  if (!job) return done("I lost these emails (they may have expired). Say **generate personalized emails** to start again.");

  let campaignId = ctx.campaignId;
  if (!campaignId) {
    const smtpId = ctx.smtpSettingsId ?? ctx.source?.smtpSettingsId ?? state.senderDefaults?.smtpSettingsId;
    const created = await callTool(
      "create_campaign",
      { name: ctx.name, subject: SUBJECT_PLACEHOLDER, body: BODY_PLACEHOLDER, bodyFormat: "html", ...(smtpId ? { smtpSettingsId: smtpId } : {}) },
      auth,
    );
    if (!created.ok) {
      if (created.code === "SMTP_SELECTION_REQUIRED") {
        const choices = (Array.isArray(created.details.choices) ? created.details.choices : []) as Array<{ id: number; fromEmail: string; fromName?: string }>;
        return reply(
          { ...ctx, step: "smtp", smtpChoices: choices },
          ["**Which email account should send these emails?**", "", ...choices.map((c, i) => `${i + 1}. **${c.fromEmail}**${c.fromName ? ` (${c.fromName})` : ""}`), "", "Reply with the number or the email address."].join("\n"),
        );
      }
      return reply(ctx, `I could not create the new draft campaign: ${created.message}\n\nReply **approve** to try again, or **cancel**.`);
    }
    const id = created.data.id;
    campaignId = typeof id === "number" ? String(id) : typeof id === "string" ? id : undefined;
    if (!campaignId) return reply(ctx, "The campaign was created but I did not get its ID back. Please check your campaign list.");
    ctx = { ...ctx, campaignId };
  }

  const follow = job.brief?.sequence?.count ?? 0;
  let trimmedRows = 0;
  let missingFollowUps = 0;
  const rows = job.recipients.flatMap((r) => {
    const e = job.results[r.email.toLowerCase()];
    if (!e || e.error) return [];
    const written: Record<string, string> = { ai_subject: e.subject, ai_body: e.bodyHtml.replace(/\r?\n/g, " ") };
    // Follow-ups are sent as plain text by the backend (it escapes them), so they are stored as plain text.
    (e.followUps ?? []).forEach((f, i) => (written[`ai_followup_${i + 1}`] = f.body));
    if (follow && (e.followUps?.length ?? 0) < follow) missingFollowUps++;
    const { row, trimmed } = buildRow(r.fields, r.email, r.name, written);
    if (trimmed) trimmedRows++;
    return [row];
  });
  const failedEmails = job.recipients.length - rows.length;
  if (rows.length === 0) return reply(ctx, "There are no written emails to save. Go back with **regenerate N**, or **cancel**.");

  const saved = await callTool("save_csv_recipients", { campaignId, rows }, auth);
  if (!saved.ok) return reply(ctx, `The new draft campaign is created, but saving the recipients failed: ${saved.message}\n\nReply **approve** to try again, or **cancel**.`, { activeCampaignId: campaignId });
  const added = Number(saved.data.added) || 0;
  const rejected = Number(saved.data.rejected) || 0;

  let followNote = "";
  if (follow) {
    const s = ctx.personalize;
    const templates = Array.from({ length: follow }, (_, i) => ({
      id: `ai-followup-${i + 1}`,
      title: `AI follow-up ${i + 1}${s?.breakup && i === follow - 1 ? " (breakup)" : ""}`,
      subject: `Re: ${SUBJECT_PLACEHOLDER}`,
      body: `{{ai_followup_${i + 1}}}`,
    }));
    const tpl = await callTool("save_follow_up_templates", { campaignId, templates }, auth);
    followNote = tpl.ok
      ? `- **${follow}** follow-ups per recipient saved as the campaign's follow-up templates (*AI follow-up 1–${follow}*); send them from the campaign's follow-up screen.`
      : `- The follow-ups are saved on each recipient, but the follow-up templates could not be saved: ${tpl.message}`;
  }

  return reply(
    { ...ctx, step: "schedule", saved: { added, rejected, failedEmails } },
    [
      `New draft campaign **${ctx.name}** created with **${added}** recipients, each with their own subject and email. **${ctx.source?.name ?? "The original campaign"}** was not changed.`,
      rows.length - added > 0 ? `- ${rows.length - added} not added (unsubscribed / bounced before, duplicates, or invalid).` : "",
      failedEmails > 0 ? `- ${failedEmails} left out because they need review.` : "",
      followNote,
      missingFollowUps ? `- ${missingFollowUps} recipients have fewer follow-ups (theirs did not pass the checks).` : "",
      trimmedRows ? `- ${trimmedRows} rows had very long columns dropped to fit the backend's size limit (the emails are complete).` : "",
      "",
      "**When should it be sent?** Reply **now**, or a date and time (e.g. *tomorrow 10am*, *kal subah 9 baje*, *15 Nov 3pm*).",
    ].filter(Boolean).join("\n"),
    { activeCampaignId: campaignId },
  );
}
