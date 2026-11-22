/**
 * src/agents/CampaignAgent.ts
 *
 * Handles campaign management intents and SMTP settings intents.
 *
 * Intents handled:
 *   list_campaigns    → MCP tool: get_all_campaigns
 *   create_campaign   → MCP tool: create_campaign  (wizard)
 *   update_campaign   → MCP tool: update_campaign  (selection + wizard)
 *   schedule_campaign → schedule draft JSON only (backend API integration pending)
 *   start_campaign    → MCP tool: start_campaign   (risky — approval required)
 *   pause_campaign    → MCP tool: pause_campaign   (running campaigns only)
 *   resume_campaign   → MCP tool: resume_campaign  (risky — approval required)
 *   get_campaign_stats → delegated via selection to get_campaign_stats
 *   check_smtp        → MCP tool: get_smtp_settings
 *   update_smtp       → MCP tool: update_smtp_settings (wizard then approval)
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs, CREATE_CAMPAIGN_REQUIRED_FIELDS } from "../lib/toolArgResolver.js";
import { getOpenAIService } from "../services/openai.service.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import type { KnownToolName } from "../types/tools.js";
import type { CTAType, SequenceType, ToneType } from "../lib/sdrStrategy.js";
import { isAccountLevelQuestion } from "../lib/accountStats.js";
import { authFromState, matchCampaignSelection, ordinalPick, selectableCampaigns } from "../lib/campaignLookup.js";
import { campaignNameAndTopic, handleCampaignCreation, isCampaignCreationActive, isChainedCampaignRequest, startsCampaignCreation } from "../lib/campaignCreationFlow.js";
import { startPersonalize, startPersonalizeFor } from "../lib/personalizeEmailsFlow.js";
import { mcpClientService } from "../services/mcpClient.service.js";
import { WIZARD_BODY_PROMPT } from "../prompts/campaignCreation.prompt.js";
import { bodyToHtml, phraseHits } from "../lib/emailRealism.js";
import { CLICHE_PHRASES, SPAM_PHRASES } from "../config/emailRealism.config.js";
import { noWizardRecipientsMessage } from "../lib/recipientCount.js";
import { campaignsCreatedAnswer, campaignsInMessage, isCampaignsCreatedInPeriod, listUserCampaigns } from "../lib/campaignAnalytics.js";
import {
  bodyForSave,
  campaignText,
  editFieldIn,
  editValueFrom,
  scheduleTimeFrom,
  smtpAccounts,
  writeEmailAnswer,
  type EditField,
} from "../lib/campaignEdits.js";

// ── Intent → MCP tool mapping ─────────────────────────────────────────────────

const TOOL_MAP = {
  list_campaigns:              "get_all_campaigns",
  create_campaign:             "create_campaign",
  update_campaign:             "update_campaign",
  schedule_campaign:           "update_campaign",
  start_campaign:              "start_campaign",
  pause_campaign:              "pause_campaign",
  resume_campaign:             "resume_campaign",
  get_campaign_stats:          "get_campaign_stats",
  show_sequence_progress:      "get_sequence_progress",
  show_pending_follow_ups:     "get_pending_follow_ups",
  show_recipient_touch_history:"get_recipient_touch_history",
  mark_recipient_replied:      "mark_recipient_replied",
  mark_recipient_bounced:      "mark_recipient_bounced",
  check_smtp:                  "get_smtp_settings",
  update_smtp:                 "update_smtp_settings",
  generate_personalized_emails: "generate_personalized_emails",
} satisfies Partial<Record<Intent, KnownToolName>>;

type CampaignIntent = keyof typeof TOOL_MAP;

function isCampaignIntent(intent: Intent | undefined): intent is CampaignIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

// ── Campaign action intents that require selection when no campaignId ──────────

type CampaignActionIntent =
  | "start_campaign"
  | "pause_campaign"
  | "resume_campaign"
  | "update_campaign"
  | "schedule_campaign"
  | "get_campaign_stats"
  | "show_sequence_progress"
  | "show_pending_follow_ups"
  | "generate_personalized_emails";

const CAMPAIGN_ACTION_INTENTS = new Set<string>([
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "update_campaign",
  "schedule_campaign",
  "get_campaign_stats",
  "show_sequence_progress",
  "show_pending_follow_ups",
]);

function isCampaignActionIntent(intent: string | undefined): intent is CampaignActionIntent {
  return intent !== undefined && CAMPAIGN_ACTION_INTENTS.has(intent);
}

function parseGenerationModeFromMessage(
  message: string | undefined,
): "low_promotional_plaintext" | "executive_direct" | "friendly_human" | "value_first" | undefined {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("low-promotional") || lower.includes("low promotional") || lower.includes("plain text") || lower.includes("plaintext")) {
    return "low_promotional_plaintext";
  }
  if (lower.includes("executive")) return "executive_direct";
  if (lower.includes("friendly human") || lower.includes("friendly")) return "friendly_human";
  if (lower.includes("value first") || lower.includes("value-first")) return "value_first";
  return undefined;
}

function parseToneFromMessage(message: string | undefined): ToneType | undefined {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("founder tone") || lower.includes("founder style")) return "founder_style";
  if (lower.includes("technical") || lower.includes("more technical") || lower.includes("engineer")) return "technical_advisor";
  if (lower.includes("consultant")) return "consultant_style";
  if (lower.includes("concise enterprise") || lower.includes("enterprise tone")) return "concise_enterprise";
  if (lower.includes("executive") || lower.includes("more direct")) return "executive_direct";
  if (lower.includes("friendly")) return "friendly_human";
  return undefined;
}

function parseCtaTypeFromMessage(message: string | undefined): CTAType | undefined {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("softer cta") || lower.includes("soft reply")) return "reply_cta";
  if (lower.includes("meeting cta")) return "soft_meeting_cta";
  if (lower.includes("value cta") || lower.includes("practical examples")) return "value_cta";
  if (lower.includes("direct cta") || lower.includes("more direct")) return "direct_cta";
  if (lower.includes("no pressure")) return "no_pressure_cta";
  if (lower.includes("curiosity cta")) return "curiosity_cta";
  return undefined;
}

function parseSequenceTypeFromMessage(message: string | undefined): SequenceType | undefined {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("founder outreach")) return "founder_outreach";
  if (lower.includes("warm followup") || lower.includes("warm follow-up")) return "warm_followup";
  if (lower.includes("reengagement") || lower.includes("re-engagement")) return "reengagement";
  if (lower.includes("cold outreach")) return "cold_outreach";
  return undefined;
}

function wantsReviewSequence(message: string | undefined): boolean {
  const lower = String(message ?? "").toLowerCase();
  return lower.includes("review") || lower.includes("preview") || lower.includes("show sequence") || lower.includes("show emails");
}

function extractGenerationOverrides(message: string | undefined) {
  const lower = String(message ?? "").toLowerCase();
  const overrides: Record<string, unknown> = {
    mode: parseGenerationModeFromMessage(message) ?? "low_promotional_plaintext",
  };
  const tone = parseToneFromMessage(message);
  const ctaType = parseCtaTypeFromMessage(message);
  const sequenceType = parseSequenceTypeFromMessage(message);
  if (tone) overrides.tone = tone;
  if (ctaType) overrides.ctaType = ctaType;
  if (sequenceType) overrides.sequenceType = sequenceType;
  if (lower.includes("remove breakup") || lower.includes("shorten sequence")) {
    overrides.removeBreakupEmail = true;
  }
  if (lower.includes("shorten emails")) {
    overrides.shortenEmails = true;
  }
  return overrides;
}

function parseRecipientEmailFromMessage(message: string | undefined): string | undefined {
  const match = String(message ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase();
}

function parseRecipientIdFromMessage(message: string | undefined): string | undefined {
  const match = String(message ?? "").match(/\brecipient\s*#?\s*(\d+)\b/i);
  if (match?.[1]) return match[1];
  const generic = String(message ?? "").match(/\bid\s*#?\s*(\d+)\b/i);
  return generic?.[1];
}

function extractRecipientTarget(message: string | undefined) {
  const recipientEmail = parseRecipientEmailFromMessage(message);
  const recipientId = parseRecipientIdFromMessage(message);
  return {
    ...(recipientId ? { recipientId } : {}),
    ...(recipientEmail ? { recipientEmail } : {}),
  };
}

// ── Campaign selection helpers ────────────────────────────────────────────────

type CampaignEntry = { id: string; name: string; status: string };

function formatCampaignSelectionList(
  list: CampaignEntry[],
  action: CampaignActionIntent,
): string {
  const dupes = new Map<string, number>();
  for (const c of list) dupes.set(c.name.toLowerCase(), (dupes.get(c.name.toLowerCase()) ?? 0) + 1);
  list = list.map((c) => ((dupes.get(c.name.toLowerCase()) ?? 0) > 1 ? { ...c, name: `${c.name} · #${c.id}` } : c));
  const verb =
    action === "pause_campaign"     ? "pause"
    : action === "resume_campaign"  ? "resume"
    : action === "start_campaign"   ? "start"
    : action === "schedule_campaign"? "schedule"
    : action === "show_sequence_progress" ? "check sequence progress for"
    : action === "show_pending_follow_ups" ? "review pending follow-ups for"
    : action === "get_campaign_stats"? "get statistics for"
    : action === "generate_personalized_emails" ? "generate personalized emails for"
    : "update";

  const filtered = selectableCampaigns(list, action);

  if (action === "start_campaign" && filtered.length === 0) {
    return "All your campaigns are either already running or completed — none can be started right now.";
  }
  if (action === "pause_campaign" && filtered.length === 0) {
    return "No running campaigns found to pause. Only running campaigns can be paused.";
  }
  if (action === "resume_campaign" && filtered.length === 0) {
    return "No paused campaigns found to resume. Only paused campaigns can be resumed.";
  }

  const items = filtered.map((c, i) => `${i + 1}. **${c.name}** (${c.status})`).join("\n");

  return (
    `Sure! Which campaign would you like to ${verb}?\n\n` +
    `${items}\n\n` +
    `Reply with the **number** or **campaign name**.`
  );
}

/**
 * True when this message names the campaign (its id, or a campaign the LLM read from the message).
 * False when the id only comes from the session — e.g. the "Pause a campaign" chip after the chat
 * looked at draft #452 (bug B19-02).
 */
function namedInMessage(state: AgentGraphStateType, campaignId: string): boolean {
  if (state.activeCampaignId !== campaignId) return true;
  const llm = state.llmExtractedArgs?.campaignId;
  if (typeof llm === "string" && llm.trim()) return true;
  const id = campaignId.replace(/[^0-9A-Za-z_-]/g, "");
  return new RegExp(`(?:#|\\bid\\s*[:#]?\\s*|\\bcampaign\\s+)${id}\\b`, "i").test(state.userMessage);
}

type ActionWithStatus = "start_campaign" | "pause_campaign" | "resume_campaign";

/**
 * Before an approval card for start / pause / resume: can this campaign take the action?
 * No → no card and no pending action, a plain reason plus the campaigns that can (bugs B19-02, B19-04):
 *   - pause needs a running campaign, resume a paused one, start one that is not running or completed;
 *   - start needs at least one recipient (the backend refuses: "No pending recipients to send to").
 * A campaign that only came from the session (not named now) is not mentioned: the user just gets the list.
 * Undefined when the action can go ahead, or when the campaigns could not be read (the card then
 * shows the facts as before, and the backend still decides).
 */
async function campaignActionBlock(
  state: AgentGraphStateType,
  action: CampaignActionIntent,
  campaignId: string,
  opts: { named: boolean },
): Promise<Partial<AgentGraphStateType> | undefined> {
  if (action !== "start_campaign" && action !== "pause_campaign" && action !== "resume_campaign") return undefined;
  const auth = authFromState(state);
  if (!auth) return undefined;
  let all: Array<CampaignEntry & { recipients?: number }>;
  try {
    const result = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = result.data as { success?: boolean; data?: unknown } | undefined;
    if (result.isToolError || env?.success === false || !Array.isArray(env?.data)) return undefined;
    all = (env.data as Array<Record<string, unknown>>)
      .filter((c) => c.id !== undefined && typeof c.name === "string")
      .map((c) => {
        const count = c.recipientCount ?? c.recieptCount;
        return {
          id: String(c.id),
          name: String(c.name),
          status: typeof c.status === "string" ? c.status : "unknown",
          ...(typeof count === "number" ? { recipients: count } : {}),
        };
      });
  } catch {
    return undefined;
  }
  const hit = all.find((c) => c.id === campaignId);
  if (!hit) return undefined;

  const s = hit.status.toLowerCase() === "in_progress" ? "running" : hit.status.toLowerCase();
  const act = action as ActionWithStatus;
  const wrongStatus =
    act === "pause_campaign" ? s !== "running"
    : act === "resume_campaign" ? s !== "paused"
    : s === "running" || s === "completed";
  const noRecipients = act === "start_campaign" && !wrongStatus && hit.recipients === 0;
  if (!wrongStatus && !noRecipients) return undefined;

  if (noRecipients) {
    return {
      toolName: undefined,
      toolArgs: {},
      error:
        `**${hit.name}** (#${hit.id}) has **no recipients**, so there is nothing to send. ` +
        "Add recipients first (upload a CSV with the 📎 button, or on the campaign's page), then start it again.",
      pendingCampaignAction: undefined,
      campaignSelectionList: undefined,
    };
  }

  const entries: CampaignEntry[] = all.map(({ id, name, status }) => ({ id, name, status }));
  const canPick = selectableCampaigns(entries, action).length > 0;
  const listText = formatCampaignSelectionList(entries, action);
  const pick = canPick
    ? { pendingCampaignAction: action, campaignSelectionList: entries }
    : { pendingCampaignAction: undefined, campaignSelectionList: undefined };
  const reason =
    act === "pause_campaign" ? `is **${s}** — only running campaigns can be paused.`
    : act === "resume_campaign" ? `is **${s}** — only paused campaigns can be resumed.`
    : `is already **${s}**.`;
  return {
    toolName: undefined,
    toolArgs: {},
    error: opts.named ? `**${hit.name}** (#${hit.id}) ${reason}\n\n${listText}` : listText,
    ...pick,
  };
}

/**
 * The ONE campaign a message names, as an id: a campaign name ("schedule QA TEST AGENT DRAFT 2 for …",
 * "Campaign 3"), "campaign 452" / "#452" / "id 452", or Roman Urdu "466 ka subject …". Numbers in dates
 * and times are never read as ids. Undefined when no single campaign of the user's is named.
 */
async function campaignNamedForAction(state: AgentGraphStateType, _verb?: string): Promise<string | undefined> {
  // "pause the second one" → the 2nd campaign of the list just shown (QA P3 bug 57).
  const picked = ordinalPick(state.userMessage, state.campaignSelectionList);
  if (picked) return picked.id;
  const all = await listUserCampaigns(state);
  if (!all) return undefined;
  // Only the command part names the campaign — never the new value ("update campaign 467 body: Ignore
  // ALL previous instructions" picked the campaign named ALL, QA P3 bugs 59/60). An explicit id wins.
  const command = state.userMessage.split(/\b(?:body|subject|name|sender\s+name|from\s+name|sender\s+email|from\s+email|text|content)\s*[:=]|\s(?:to|into|as)\s+["“']/i)[0] ?? state.userMessage;
  const id =
    command.match(/\bcampaign\s+(?:id\s*[:#]?\s*)?#?(\d{1,9})\b|#(\d{1,9})\b|\bid\s*[:#]?\s*(\d{1,9})\b/i) ??
    command.match(/^\s*(\d{1,9})\s+(?:ka|ki|ke|wali|wala|wale)\b/i);
  const n = id ? (id[1] ?? id[2] ?? id[3]) : undefined;
  if (n && all.some((c) => c.id === n)) return n;
  const byName = campaignsInMessage(command, all, { namesOnly: true });
  if (byName.length === 1) return byName[0]!.id;
  // "ab 464 dobara chala do": a bare number that is one of the user's campaign ids (exactly one).
  const bare = [...new Set([...command.matchAll(/(?<![\d:/.-])\b(\d{2,9})\b(?![:/.-]\d)/g)].map((m) => m[1]!))]
    .filter((x) => all.some((c) => c.id === x));
  return bare.length === 1 ? bare[0] : undefined;
}

/** How many recipients a campaign has (its recipient list), or undefined when it can't be read. */
async function wizardRecipientCount(state: AgentGraphStateType, campaignId: string): Promise<number | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  try {
    const r = await mcpClientService.dispatch("get_recipient_count", { campaignId }, auth);
    const env = r.data as { success?: boolean; data?: Record<string, unknown> } | undefined;
    if (r.isToolError || env?.success === false) return undefined;
    const d = (env?.data ?? env ?? {}) as Record<string, unknown>;
    return typeof d.totalCount === "number" ? d.totalCount : undefined;
  } catch {
    return undefined;
  }
}

// ── Campaign creation wizard ──────────────────────────────────────────────────

const FIELD_ORDER = ["name", "subject", "body"] as const;
type CampaignField = typeof FIELD_ORDER[number];

function getNextMissingField(draft: Record<string, string>): CampaignField | undefined {
  return FIELD_ORDER.find((f) => !draft[f] || draft[f].trim() === "");
}

function hasAllCreateCampaignFields(args: Record<string, unknown>): boolean {
  return CREATE_CAMPAIGN_REQUIRED_FIELDS.every(
    (f) => typeof args[f] === "string" && (args[f] as string).length > 0,
  );
}

const STEP_QUESTIONS: Record<CampaignField, string> = {
  name:    'What would you like to name your campaign? (e.g. "Summer Sale 2026")',
  subject: "What should the email subject line be?",
  body:    "What should the email body say? Describe it in plain language and I'll format it — or type **generate** to auto-write it based on your campaign name and subject.",
};

const STEP_ACKS: Partial<Record<CampaignField, string>> = {
  name:    "Nice! ",
  subject: "Got it! ",
  body:    "Perfect. ",
};

const CONFIRM_RE = /\b(yes|confirm|proceed|create it|go ahead|looks good|perfect|great|ok|okay|sure|do it|send it|approve|✓)\b/i;
const CANCEL_RE  = /\b(no|cancel|stop|abort|forget it|never mind|discard|reset|start over|scratch)\b/i;

/** Same limits as the backend (backend/src/constants/fieldLimits.ts CAMPAIGN_LIMITS). */
const AI_WIZARD_MAX_NAME = 255;

/** A new name for the draft on screen: "change the (campaign) name to X", "call it X", "rename (it) to X". */
export function draftNameEdit(message: string): string | undefined {
  const m =
    /\b(?:change|set|update|make)\s+(?:the\s+)?(?:campaign\s+)?name\s+(?:to|as|into)\s+["“']?(.+?)["”']?\s*[.!]*$/i.exec(message) ??
    /\b(?:call|name)\s+it\s+["“']?(.+?)["”']?\s*[.!]*$/i.exec(message) ??
    /\brename\s+(?:it|the\s+(?:campaign|draft))?\s*(?:to|as)\s+["“']?(.+?)["”']?\s*[.!]*$/i.exec(message);
  const name = m?.[1]?.trim();
  return name && name.length <= 255 ? name : undefined;
}

/** "Show campaigns tagged QA-Auto", "campaigns with tag VIP", "campaigns with the 'QA E2E' tag" → the tag name. */
export function campaignTagFrom(message: string): string | undefined {
  const m =
    message.match(/\btagged\s+(?:as\s+|with\s+)?["']?([\w][\w\- ]{0,49}?)["']?\s*(?:tag)?\s*[?.!]*$/i) ??
    message.match(/\bwith\s+(?:the\s+)?tag\s+["']?([\w][\w\- ]{0,49}?)["']?\s*[?.!]*$/i) ??
    message.match(/\bwith\s+(?:the\s+)?["']([\w][\w\- ]{0,49}?)["']\s+tag\b/i);
  return m?.[1]?.trim() || undefined;
}

/**
 * Why a campaign name can't be used, or undefined when it is fine (QA P4 bug 8): it must contain
 * real text (a letter or digit, not only emojis / symbols) and no HTML markup.
 */
export function campaignNameProblem(name: string): string | undefined {
  if (/<\/?[a-z!][^>]*>/i.test(name)) {
    return "Campaign names can't contain HTML tags like <b> or <img>. Please type the name as plain text.";
  }
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return "Please use a name with real words or numbers (not only emojis or symbols), e.g. Summer Sale 2026.";
  }
  return undefined;
}
const AI_WIZARD_MAX_SUBJECT = 255;

function isConfirmation(msg: string): boolean { return CONFIRM_RE.test(msg.trim()); }
function isCancellation(msg: string): boolean { return CANCEL_RE.test(msg.trim()); }

/**
 * Backup body for the AI wizard when the AI writer is unavailable (bug A-11). {first_name} — the
 * placeholder the campaign pages document — is filled per recipient by the backend. The subject is
 * not repeated in the body, no markdown, no button text, signed by the sender.
 */
function generateBodyDraft(subject: string, templateType: string, senderName?: string): string {
  const topic = subject.replace(/\{\{?\s*[a-z_]+\s*\}?\}/gi, "").replace(/\s+/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "").trim();
  const about = topic ? `"${topic}"` : "this";
  const signoff = senderName?.trim() ? `Best,\n${senderName.trim()}` : "Best,";
  const lines = (first: string, second: string) => ["Hi {first_name},", "", first, "", second, "", signoff].join("\n");
  switch (templateType) {
    case "promotional":
      return lines(`I'm writing with a quick note about ${about}. I think it could be useful for you, so I wanted you to hear about it first.`, "Would you like me to send over the details?");
    case "newsletter":
      return lines(`Here's a short update from us about ${about}. I've kept it brief so it's easy to read.`, "Is there anything you'd like to hear more about next time?");
    case "event":
      return lines(`We're putting together ${about} and I'd be glad to have you there.`, "Would you like me to save you a spot?");
    case "announcement":
      return lines(`I wanted you to hear this from me directly: ${about}.`, "Do you have any questions about it?");
    case "follow_up":
      return lines(`I'm following up on ${about} from my last note, in case it got buried.`, "Would a quick chat this week be helpful?");
    default:
      return lines(`I'm writing about ${about}.`, "Would you like to hear more?");
  }
}

/** Problems in a wizard body (the AI writer gets them as feedback). */
function wizardBodyIssues(body: string, subject: string): string[] {
  const issues: string[] = [];
  if (!/^Hi \{first_name\},\n/.test(body)) issues.push('The first line must be exactly "Hi {first_name}," with one pair of curly braces.');
  if (/\{\{|\}\}/.test(body)) issues.push("Use {first_name} with ONE pair of curly braces, never {{...}}.");
  if (/\{(?!first_name\})[^}]*\}/i.test(body)) issues.push("No placeholder other than {first_name}.");
  if (/\*\*|^#|\[[^\]]*\]|<[a-z/]|https?:\/\/|www\./im.test(body)) issues.push("Plain text only: no markdown, buttons, HTML or links.");
  if (/!/.test(body)) issues.push('No "!".');
  const topic = subject.trim().toLowerCase();
  if (topic.length > 12 && body.toLowerCase().includes(topic)) issues.push("Do not repeat the subject line in the body.");
  const words = body.replace(/^Hi \{first_name\},/, "").split(/\s+/).filter(Boolean).length;
  if (words < 40 || words > 140) issues.push(`It has ${words} words; write 50-120 words.`);
  const banned = phraseHits(body, [...SPAM_PHRASES, ...CLICHE_PHRASES, "reach out", "touch base", "circle back"]);
  if (banned.length) issues.push(`Do not use: ${banned.join(", ")}.`);
  return issues;
}

/**
 * The wizard's email body, written by the AI from the campaign name, subject and template (bug A-11: it used to be
 * fixed text with the subject pasted in as a bold line). Two tries, then the backup text.
 */
async function writeWizardBody(input: { campaignName?: string | undefined; subject: string; templateType: string; senderName?: string | undefined }): Promise<string> {
  const openai = getOpenAIService();
  if (openai && typeof openai.completeJson === "function") {
    let feedback: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await openai.completeJson(
          WIZARD_BODY_PROMPT,
          JSON.stringify({
            campaign_name: input.campaignName ?? "",
            subject: input.subject,
            template: input.templateType,
            sender_name: input.senderName?.trim() ?? "",
            ...(feedback.length ? { feedback } : {}),
          }),
          0.7,
        );
        const body = String(out.body ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        feedback = wizardBodyIssues(body, input.subject);
        if (body && feedback.length === 0) return body;
      } catch {
        break;
      }
    }
  }
  return generateBodyDraft(input.subject, input.templateType, input.senderName);
}

/**
 * The wizard body as the campaign's HTML: one <p> per paragraph so the preview and the sent email keep the
 * line breaks (they were lost), {first_name} kept as a placeholder, any other brace escaped.
 * A body the user typed as HTML is kept as it is.
 */
function wizardBodyHtml(body: string): string {
  if (/<(p|div|br|table|h[1-6])\b/i.test(body)) return body;
  return bodyToHtml(body)
    .replace(/&#123;&#123;\s*(first_name|last_name|name|email|company)\s*&#125;&#125;/gi, "{$1}")
    .replace(/&#123;(first_name|last_name|name|email|company)&#125;/gi, "{$1}");
}

function formatDraft(draft: Record<string, string>, intro: string): string {
  const bodyLines = (draft.body ?? "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

  return [
    intro,
    "",
    `**Campaign Name:** ${draft.name ?? "—"}`,
    `**Subject Line:** ${draft.subject ?? "—"}`,
    `**Body:**`,
    bodyLines || "> —",
    "",
    'Reply **confirm** to create this campaign, or tell me what to change (e.g. "change the subject to…").',
  ].join("\n");
}

// ── create_campaign deterministic extraction ──────────────────────────────────

function tryExtractFromMessage(message: string): Record<string, string> {
  const extracted: Record<string, string> = {};

  const nameMatch = message.match(
    /\b(?:called|named)\s+([^,]+?)(?=\s*,|\s+subject\b|\s+from\b|\s+body\b|$)/i,
  );
  if (nameMatch) {
    const v = (nameMatch[1] ?? "").trim();
    if (v) extracted.name = v;
  }

  const subjectMatch = message.match(
    /\bsubject[:\s]+([^,]+?)(?=\s*,|\s+from\b|\s+body\b|$)/i,
  );
  if (subjectMatch) {
    const v = (subjectMatch[1] ?? "").trim();
    if (v) extracted.subject = v;
  }

  const emailMatch = message.match(/\b[\w.+%-]+@[\w.-]+\.[a-z]{2,}\b/i);
  if (emailMatch) extracted.fromEmail = emailMatch[0];

  const fromMatch = message.match(/\bfrom\s+(.+?)\s+at\s+[\w.+%-]+@/i);
  if (fromMatch) {
    const v = (fromMatch[1] ?? "").trim();
    if (v) extracted.fromName = v;
  }

  const bodyMatch = message.match(/\bbody[:\s]+(.+?)(?=\s+and\s+then\b|$)/i);
  if (bodyMatch) {
    const v = (bodyMatch[1] ?? "").trim();
    if (v) extracted.body = v;
  }

  return extracted;
}

// ── Update campaign wizard constants ──────────────────────────────────────────

const UPDATE_FIELD_LABELS: Record<string, string> = {
  name:      "campaign name",
  subject:   "subject line",
  body:      "email body",
  fromName:  "sender name",
  fromEmail: "sender email address",
};

const UPDATE_FIELD_ALIASES: Record<string, string> = {
  name:    "name", title: "name", rename: "name",
  subject: "subject", "subject line": "subject", heading: "subject",
  body:    "body", content: "body", text: "body",
  fromname: "fromName", "sender name": "fromName", "from name": "fromName", sender: "fromName",
  fromemail: "fromEmail", "sender email": "fromEmail", "from email": "fromEmail",
  email: "fromEmail",
};

function resolveUpdateField(input: string): string | undefined {
  const lower = input.toLowerCase().trim();
  return UPDATE_FIELD_ALIASES[lower];
}

// ── Explicit campaign ID extraction ──────────────────────────────────────────

/**
 * Parses an explicit campaign ID from a user message.
 * Handles patterns like:
 *   "I am working on campaign 'Summer Sale' (ID: 6)"
 *   "use campaign ID 6"
 *   "select campaign 6"
 *   "campaign ID: 6"
 */
function parseExplicitCampaignId(message: string): string | undefined {
  // "ID: 6", "ID:6", "(ID: 6)", "ID 6" — explicit id label
  const idLabelMatch = message.match(/\bID[:：\s]+(\d+)\b/i);
  if (idLabelMatch) return idLabelMatch[1];

  // "use campaign 6", "select campaign 6", "working on campaign 6"
  const campaignNumMatch = message.match(
    /\b(?:use|select|choose|working on|work on|switch to)\s+campaign\s+#?(\d+)\b/i,
  );
  if (campaignNumMatch) return campaignNumMatch[1];

  return undefined;
}

// ── Schedule draft helpers (backend integration pending) ─────────────────────

/**
 * Parses a natural-language duration into minutes.
 * Handles: "2 hours", "1 hour 30 minutes", "90 minutes", "2 hrs", "1.5 hours"
 */
function parseDurationMinutes(text: string): number | null {
  const s = text.toLowerCase();
  let total = 0;
  let found = false;

  const hoursMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (hoursMatch) {
    total += Math.round(parseFloat(hoursMatch[1]!) * 60);
    found = true;
  }

  const minsMatch = s.match(/(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (minsMatch) {
    total += parseInt(minsMatch[1]!, 10);
    found = true;
  }

  return found && total > 0 ? total : null;
}

/**
 * Returns true when a message contains recognisable scheduling content
 * (time references, duration, or the word "schedule").
 * Used to distinguish scheduling follow-ups from generic questions.
 */
function hasSchedulingContent(message: string): boolean {
  const s = message.toLowerCase();
  return (
    /\btomorrow\b/.test(s) ||
    /\btoday\b/.test(s) ||
    /\bnext\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(s) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(s) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(s) ||
    /\bin\s+\d+\s+hours?\b/.test(s) ||
    /\bschedule\b/.test(s) ||
    /\b(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b/.test(s)
  );
}

/**
 * Strips the trailing duration fragment from a scheduling message
 * so only the start-time portion remains.
 * "tomorrow 10 AM for 2 hours" → "tomorrow 10 AM"
 * "monday 10 am 2 hours"       → "monday 10 am"
 */
function extractStartText(message: string): string {
  const cleaned = message
    .replace(/\s+(?:for\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)(?:\s+\d+\s*(?:minutes?|mins?|m))?\s*$/i, "")
    .replace(/\s+(?:for\s+)?\d+\s*(?:minutes?|mins?|m)\s*$/i, "")
    .trim();
  return cleaned || message.trim();
}

/**
 * Strips prefix context and cleans newlines from a scheduling message.
 * Handles cases where the user message includes prior-turn content before the
 * actual scheduling phrase, e.g. "Show all campaigns\n\nscheduling tomorrow 10 AM"
 * → "tomorrow 10 AM".
 * Messages that already start with the scheduling phrase are returned unchanged.
 */
function extractSchedulingText(input: string): string {
  let cleaned = input
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Case 1: only remove "scheduling" at start
  cleaned = cleaned.replace(/^scheduling\s+/i, "");

  // Case 2: remove mid-sentence "scheduling"
  const match = cleaned.match(/^.+\s(?:scheduling)\s+(.+)$/i);
  if (match?.[1]) {
    return match[1].trim();
  }

  return cleaned;
}


/**
 * Extracts the duration phrase from a message (e.g. "2 hours", "30 minutes").
 * Returns undefined when no duration is found.
 */
function extractDurationText(message: string): string | undefined {
  const forMatch = message.match(/\bfor\s+(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)(?:\s+\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m))?)\b/i);
  if (forMatch) return forMatch[1]?.trim();

  // Plain duration at end without "for" — "2 hours"
  const plainMatch = message.match(/\b(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)(?:\s+\d+\s*(?:minutes?|mins?|m))?)\s*$/i);
  if (plainMatch) return plainMatch[1]?.trim();

  return undefined;
}

/**
 * Builds a schedule draft response — does NOT call any backend API.
 * Returns the schedule as a JSON block so the frontend can display it.
 * The backend developer will wire up the actual save endpoint later.
 */
/** Returns the standard "what would you like to do?" menu for an active campaign. */
function buildContextualCampaignMenu(campaignId: string): Partial<AgentGraphStateType> {
  return {
    toolName: undefined,
    toolArgs: {},
    error: [
      `You're currently working on campaign **#${campaignId}**.`,
      "",
      "What would you like to do?",
      "- **Schedule** — set a send time",
      "- **Start** — begin sending immediately",
      "- **View stats** — see performance metrics",
      "- **Update** — change campaign details",
    ].join("\n"),
  };
}

/** Detects a successful CSV upload message and returns the number of recipients added, or null. */
function extractCsvUploadCount(message: string): number | null {
  const match = message.match(/\*{0,2}(\d+)\*{0,2}\s+recipients?\s+uploaded\s+successfully/i)
    ?? message.match(/\*{0,2}(\d+)\*{0,2}\s+recipients?\s+added\s+successfully/i);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export class CampaignAgent extends BaseAgent {
  readonly domain = "campaign" as const;

  constructor() {
    super("campaign");
  }

  async handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, activeCampaignId } = state;

    if (/\b(validate|check|review)\b[^.!?]{0,50}\b(recipients?|email list|contact list)\b/i.test(state.userMessage) && /\bcampaign\b|\b#\d+\b/i.test(state.userMessage)) {
      return this.validateCampaignRecipients(state);
    }

    // ── Chat campaign creation: name → file → personalized emails → template → schedule → confirm ──
    if (isCampaignCreationActive(state) || startsCampaignCreation(state)) {
      return handleCampaignCreation(state);
    }

    // ── SMTP profile selection (highest priority — user is picking a sender) ──
    if (state.pendingSmtpSelectionAction === "create_campaign" && state.smtpProfileChoices?.length) {
      return this.handleSmtpSelection(state);
    }

    // ── CSV file ingestion (fires whenever a file is in state) ────────────────
    if (intent === "upload_csv" || state.pendingCsvFile !== undefined) {
      return this.handleCsvUpload(state);
    }

    // ── Phase 1 AI wizard continuation (highest priority) ─────────────────────
    if (state.pendingAiCampaignStep !== undefined) {
      return this.handleAiWizardContinuation(state);
    }

    // ── Campaign selection (second priority) ──────────────────────────────────
    if (state.pendingCampaignAction && state.campaignSelectionList?.length) {
      return this.handleCampaignSelection(state);
    }

    // ── Draft continuation (third priority) ───────────────────────────────────
    if (state.pendingCampaignDraft !== undefined) {
      return this.handleDraftContinuation(state);
    }

    // ── Phase 1 intents — handled before TOOL_MAP narrowing ──────────────────
    if (intent === "create_ai_campaign") {
      return this.startAiWizard(state);
    }

    if (intent === "generate_personalized_emails") {
      // The agent writes the emails itself (the backend has no generation endpoint): it asks which campaign
      // (any status) and every writing choice, then saves the emails to a new draft copy (lib/personalizeEmailsFlow.ts).
      return startPersonalize(state);
    }

    if (intent === "review_personalized_emails") {
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Which campaign should I review the sequence for? Please provide a campaign ID or select an active campaign first.",
        };
      }
      return {
        toolName: "get_personalized_emails",
        toolArgs: { campaignId: activeCampaignId, limit: 3 },
      };
    }

    if (intent === "regenerate_personalized_emails") {
      // Same writer as "Generate personalized emails" (the old generate tool's backend route does not exist).
      return activeCampaignId
        ? startPersonalizeFor(state, { id: activeCampaignId, name: state.campaignSelectionList?.find((c) => c.id === activeCampaignId)?.name })
        : startPersonalize(state);
    }

    if (intent === "show_sequence_progress") {
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Which campaign should I show sequence progress for? Provide a campaign ID or select a campaign first.",
        };
      }
      return {
        toolName: "get_sequence_progress",
        toolArgs: { campaignId: activeCampaignId },
      };
    }

    if (intent === "show_pending_follow_ups") {
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Which campaign should I show pending follow-ups for? Provide a campaign ID or select a campaign first.",
        };
      }
      return {
        toolName: "get_pending_follow_ups",
        toolArgs: { campaignId: activeCampaignId, limit: 10 },
      };
    }

    if (intent === "show_recipient_touch_history" || intent === "mark_recipient_replied" || intent === "mark_recipient_bounced") {
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Which campaign should I use? Provide a campaign ID or select a campaign first.",
        };
      }
      const recipientTarget = extractRecipientTarget(state.userMessage);
      if (!recipientTarget.recipientId && !recipientTarget.recipientEmail) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: intent === "show_recipient_touch_history"
            ? "Please tell me which recipient to inspect. You can provide a recipient email or say something like **recipient 12**."
            : "Please tell me which recipient to update. You can provide a recipient email or say something like **recipient 12**.",
        };
      }
      return {
        toolName:
          intent === "show_recipient_touch_history"
            ? "get_recipient_touch_history"
            : intent === "mark_recipient_replied"
              ? "mark_recipient_replied"
              : "mark_recipient_bounced",
        toolArgs: {
          campaignId: activeCampaignId,
          ...recipientTarget,
        },
      };
    }

    // ── Explicit campaign ID in message — set as active campaign ─────────────
    // Handles: "ID: 6", "use campaign 6", "working on campaign ID 6", etc.
    // Only fires when no other wizard/draft/action state is active.
    // "pause campaign id 17" is an action on #17, not just "select #17".
    const explicitId = isCampaignActionIntent(intent)
      ? undefined
      : parseExplicitCampaignId(state.userMessage);
    if (explicitId) {
      this.log.info({ userId, campaignId: explicitId }, "CampaignAgent: explicit campaign ID detected");
      return {
        toolName:         undefined,
        toolArgs:         {},
        error: [
          `Got it! I'm now working with campaign **#${explicitId}**.`,
          "",
          "What would you like to do with it?",
          "- **Schedule** — set a send time",
          "- **Start** — begin sending immediately",
          "- **View stats** — see performance metrics",
          "- **Update** — change campaign details",
        ].join("\n"),
        activeCampaignId: explicitId,
        intent:           "create_ai_campaign",
      };
    }

    // ── Campaign list selection (no pending action) ───────────────────────────
    // Fires when the user replies to a plain "list campaigns" display with a
    // number or name, and there is no pendingCampaignAction driving the selection.
    //
    // An explicit command always wins over selection: re-sending "show all
    // campaigns" while a list is on screen must re-list, never be read as
    // picking a campaign out of that list.
    if (
      !state.pendingCampaignAction &&
      state.campaignSelectionList?.length &&
      !isCampaignIntent(intent)
    ) {
      const selected = matchCampaignSelection(state.userMessage, state.campaignSelectionList);
      if (selected) {
        this.log.info(
          { userId, campaignId: selected.id, campaignName: selected.name },
          "CampaignAgent: campaign selected from prior list (no pending action)",
        );
        return {
          toolName:              undefined,
          toolArgs:              {},
          error: [
            `Campaign **"${selected.name}"** selected.`,
            "",
            "What would you like to do with it?",
            "- **Schedule** — set a send time",
            "- **Start** — begin sending immediately",
            "- **View stats** — see performance metrics",
            "- **Update** — change campaign details",
          ].join("\n"),
          activeCampaignId:      selected.id,
          campaignSelectionList: undefined,
          intent:                "create_ai_campaign",
        };
      }
    }

    // ── "Write me an email" / "suggest subject lines" / "rewrite the body": text in the chat only ──
    // It created a campaign and offered to START it, or overwrote the saved subject / body (QA bugs).
    if (intent === "write_email") {
      const id = await campaignNamedForAction(state);
      const campaign = id ? await campaignText(state, id) : undefined;
      const message = await writeEmailAnswer(state.userMessage, campaign, state.senderDefaults?.fromName);
      return {
        toolName: undefined,
        toolArgs: {},
        formattedResponse: JSON.stringify({ status: "success", intent: "write_email", message }),
        ...(campaign ? { activeCampaignId: campaign.id } : {}),
      };
    }

    // ── "Delete campaign 466" — an approval card (it opened the update wizard) ──
    if (intent === "delete_campaign") {
      const id = await campaignNamedForAction(state);
      if (!id) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Which campaign should I delete? Say its name or number, e.g. **delete campaign 466**. Say **show all campaigns** to see them.",
        };
      }
      const c = await campaignText(state, id);
      const status = (c?.status ?? "").toLowerCase();
      if (status === "in_progress" || status === "running") {
        return {
          toolName: undefined,
          toolArgs: {},
          error: `**${c?.name ?? `#${id}`}** (#${id}) is **running**. Pause it first (**pause campaign ${id}**), then delete it.`,
        };
      }
      return { toolName: "delete_campaign", toolArgs: { campaignId: id }, intent: "delete_campaign", activeCampaignId: undefined };
    }

    if (!isCampaignIntent(intent)) {
      // ── Contextual fallback: general/ambiguous intent with active campaign ──
      // The manager routed here because activeCampaignId is set.
      if (activeCampaignId) {
        // If the message contains scheduling information, return a schedule draft
        // rather than the campaign options menu.
        if (hasSchedulingContent(state.userMessage)) {
          this.log.info({ userId, activeCampaignId, intent }, "CampaignAgent: schedule from contextual scheduling message");
          return this.scheduleCampaign(state, activeCampaignId, state.userMessage);
        }

        const csvCount = extractCsvUploadCount(state.userMessage);
        if (csvCount !== null) {
          this.log.info({ userId, activeCampaignId, csvCount }, "CampaignAgent: CSV upload confirmed");
          return {
            toolName: undefined,
            toolArgs: {},
            error: [
              `Recipients added successfully (${csvCount} contact${csvCount === 1 ? "" : "s"}).`,
              "",
              "What would you like to do next?",
              "",
              "1. **Schedule** — set a date and time to send",
              "2. **Start campaign** — begin sending immediately",
              "3. **View stats** — check performance later",
            ].join("\n"),
          };
        }

        this.log.info({ userId, activeCampaignId, intent }, "CampaignAgent: contextual reply for active campaign");
        return buildContextualCampaignMenu(activeCampaignId);
      }
      return this.unhandledIntent(intent, userId);
    }

    const toolName = TOOL_MAP[intent];

    this.log.debug(
      {
        intent,
        toolName,
        userId,
        llmExtractedArgs: llmExtractedArgs
          ? {
              topLevelKeys: Object.keys(llmExtractedArgs).filter((k) => k !== "filters"),
              filterKeys:   llmExtractedArgs.filters ? Object.keys(llmExtractedArgs.filters) : [],
            }
          : undefined,
      },
      "CampaignAgent received llmExtractedArgs",
    );

    const toolArgs = resolveToolArgs(toolName, {
      extractedArgs:    llmExtractedArgs,
      activeCampaignId,
    });

    // ── list_campaigns ────────────────────────────────────────────────────────
    if (intent === "list_campaigns") {
      // "How many draft campaigns do I have?" → a count, not the whole list (bug A-05).
      if (isAccountLevelQuestion(state.userMessage)) {
        return { toolName: "get_account_stats", toolArgs: {} };
      }
      // "Show me campaigns created this week" → only those (the period was ignored and all 38 were listed).
      if (isCampaignsCreatedInPeriod(state.userMessage)) {
        const created = await campaignsCreatedAnswer(state);
        if (created) {
          return {
            toolName: undefined,
            toolArgs: {},
            formattedResponse: JSON.stringify({ status: "success", intent: "list_campaigns", message: created }),
          };
        }
      }
      // "Show campaigns tagged QA-Auto" → only that tag, like the Campaigns page filter (QA P4 bug 18).
      const tag = campaignTagFrom(state.userMessage);
      return { toolName: "get_all_campaigns", toolArgs: tag ? { tag } : {} };
    }

    // ── update_campaign ───────────────────────────────────────────────────────
    if (intent === "update_campaign") {
      const named = await campaignNamedForAction(state);
      const campaignId = named ?? (typeof toolArgs.campaignId === "string" && /^\d+$/.test(toolArgs.campaignId)
        ? toolArgs.campaignId
        : undefined);

      if (campaignId) {
        // Field + new value from the message itself — only the value, commas kept (it saved the command
        // words: "of campaign 466 to Hello C", "badal ke 'Hello C updated' kar do"). Shown on an approval card.
        const field = editFieldIn(state.userMessage);
        if (field === "fromName" || field === "fromEmail") return this.senderChange(state, campaignId);
        const value = field ? editValueFrom(state.userMessage, field) : undefined;
        if (field && value) return this.campaignEdit(state, campaignId, field, value);
        if (field) {
          const label = UPDATE_FIELD_LABELS[field] ?? field;
          return {
            toolName:             undefined,
            toolArgs:             {},
            error:                `What should the new **${label}** be?`,
            pendingCampaignDraft: { _mode: "update", campaignId, _updateField: field },
            pendingCampaignStep:  "update_field_value",
            intent:               "update_campaign",
          };
        }
        // CampaignId present but no field — enter field-selection wizard
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:                "Which field would you like to update?\n\nOptions: **name**, **subject**, **body**, **sender name**, **sender email**",
          pendingCampaignDraft: { _mode: "update", campaignId },
          pendingCampaignStep:  "update_select_field",
          intent:               "update_campaign",
        };
      }
      // No campaignId — fetch campaign list for selection
      return this.handleCampaignActionWithId(state, "update_campaign", toolArgs);
    }

    // ── schedule_campaign ─────────────────────────────────────────────────────
    if (intent === "schedule_campaign") {
      // The campaign: an id, a name in the message ("schedule QA TEST AGENT DRAFT 2 for …"), or the chat's.
      const named = await campaignNamedForAction(state, "schedule");
      const campaignId =
        named ??
        ((typeof toolArgs.campaignId === "string" && toolArgs.campaignId.length > 0)
          ? toolArgs.campaignId
          : activeCampaignId);

      if (!campaignId) {
        // No campaignId — show campaign list for selection.
        // Preserve the original scheduling text so the schedule step
        // receives it after the user picks a campaign, not just "1" or "Summer Sale".
        const base = this.handleCampaignActionWithId(state, "schedule_campaign", toolArgs);
        return hasSchedulingContent(state.userMessage)
          ? { ...base, pendingScheduledAt: extractSchedulingText(state.userMessage) }
          : base;
      }

      if (!hasSchedulingContent(state.userMessage)) {
        return {
          toolName: undefined,
          toolArgs: {},
          error:
            "When would you like to schedule this campaign? Please provide a date and time, " +
            "e.g. **tomorrow at 10 AM**, **next Monday at 9:00 AM**, or an exact date/time.",
        };
      }

      this.log.info({ userId, campaignId }, "CampaignAgent: scheduling");
      return this.scheduleCampaign(state, campaignId, state.userMessage);
    }

    // ── create_campaign wizard ────────────────────────────────────────────────
    if (intent === "create_campaign") {
      if (!isCampaignCreationActive(state) && isChainedCampaignRequest(state.userMessage)) {
        const name = campaignNameAndTopic(state.userMessage.split(/,|\s+and\s+(?:add|copy|use|schedule)\b/i)[0] ?? "").name;
        return {
          toolName: undefined,
          toolArgs: {},
          formattedResponse: JSON.stringify({
            status: "success",
            intent,
            message: [
              "I can't do all three steps in one request yet, so **nothing was created**.",
              "",
              "Do them one after the other:",
              `1. **create a campaign named ${name ?? "…"}** — I'll ask for the recipient file next.`,
              "2. Add the recipients: attach the file in this chat, or upload it on the campaign page (copying another campaign's recipients isn't available in chat yet).",
              "3. **schedule campaign <name> for <date and time>** — I'll show a confirmation card.",
            ].join("\n"),
          }),
          intent,
        };
      }
      return this.handleCreateCampaign(state, toolArgs as Record<string, string>);
    }

    // ── start / pause / resume / analytics — require campaignId ──────────────
    if (isCampaignActionIntent(intent)) {
      const isRunAction = intent === "start_campaign" || intent === "pause_campaign" || intent === "resume_campaign";
      // The campaign the message names ("resume campaign 441", "start QA TEST AGENT DRAFT", "the second one")
      // when the LLM gave no usable id — it used to show the whole list (QA P3 bugs 36, 44, 51).
      const llmId = typeof toolArgs.campaignId === "string" && /^\d+$/.test(toolArgs.campaignId) ? toolArgs.campaignId : undefined;
      const campaignId = llmId ?? (isRunAction ? await campaignNamedForAction(state) : undefined);
      if (campaignId) toolArgs.campaignId = campaignId;
      else if (isRunAction) delete toolArgs.campaignId;
      // "Start" / "run it again" / "dobara chala do" on a PAUSED campaign means resume (QA P3 bug 51:
      // a start card was shown and Confirm gave a raw API error).
      let action: CampaignActionIntent = intent;
      if (intent === "start_campaign" && campaignId) {
        const target = (await listUserCampaigns(state))?.find((c) => c.id === campaignId);
        if (target?.status.toLowerCase() === "paused") action = "resume_campaign";
      }
      if (campaignId && isRunAction) {
        // "Pause a campaign" must not offer to pause the draft the chat looked at earlier (bug B19-02),
        // and a campaign with no recipients gets no "start" card (bug B19-04).
        const blocked = await campaignActionBlock(state, action, campaignId, { named: namedInMessage(state, campaignId) || !llmId });
        if (blocked) return blocked;
      }
      const patch = this.handleCampaignActionWithId(state, action, toolArgs);
      return action === intent ? patch : { ...patch, intent: action };
    }

    // ── check_smtp ────────────────────────────────────────────────────────────
    if (intent === "check_smtp") {
      return { toolName: "get_smtp_settings", toolArgs: {} };
    }

    // ── update_smtp — redirect to Settings page ───────────────────────────────
    if (intent === "update_smtp") {
      return {
        toolName: undefined,
        toolArgs: {},
        error:    "SMTP settings should be configured securely from the Settings page. Please go to **Settings → SMTP Configuration** to update your mail server.",
      };
    }

    return { toolName, toolArgs };
  }

  // ── Campaign action (start/pause/resume/update/schedule/stats) ────────────────

  private handleCampaignActionWithId(
    state: AgentGraphStateType,
    action: CampaignActionIntent,
    toolArgs: Record<string, unknown>,
  ): Partial<AgentGraphStateType> {
    const { userId } = state;
    const toolName = TOOL_MAP[action as keyof typeof TOOL_MAP] as KnownToolName;

    const campaignId = typeof toolArgs.campaignId === "string" && toolArgs.campaignId.length > 0
      ? toolArgs.campaignId
      : undefined;

    if (campaignId) {
      this.log.info(
        {
          userId,
          action,
          campaignId,
          source: state.activeCampaignId === campaignId ? "session" : "extracted",
        },
        "Dispatching campaign action with resolved campaignId",
      );
      return { toolName, toolArgs };
    }

    this.log.info({ userId, action }, "No campaignId — fetching campaign list for selection");
    return {
      toolName:              "get_all_campaigns",
      toolArgs:              {},
      pendingCampaignAction: action,
    };
  }

  // ── Campaign selection (user picks from numbered list) ────────────────────────

  private async handleCampaignSelection(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId } = state;
    const rawList = state.campaignSelectionList!;
    const action  = state.pendingCampaignAction!;

    // The same list the user was shown — "1" must be the campaign shown as 1
    // (start used to skip this filter and pick from the unfiltered list).
    const list = selectableCampaigns(rawList, action);

    if (isCancellation(state.userMessage)) {
      this.log.info({ userId, action }, "Campaign selection cancelled");
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 "Campaign action cancelled. Let me know when you'd like to try again.",
        pendingCampaignAction: undefined,
        campaignSelectionList: undefined,
        pendingScheduledAt:    undefined,
      };
    }

    // A number outside the list may be a campaign ID ("434", shown as #434 in other lists) — QA P4 bug 25.
    const bareNumber = /^\s*#?(\d{1,10})\s*[.!]?\s*$/.exec(state.userMessage)?.[1];
    const match = matchCampaignSelection(state.userMessage, list) ??
      (bareNumber ? list.find((c) => c.id === bareNumber) : undefined);

    if (match) {
      this.log.info(
        { userId, action, campaignId: match.id, campaignName: match.name },
        "Campaign selected",
      );

      // ── analytics: dispatch get_campaign_stats directly ────────────────────
      if (action === "get_campaign_stats") {
        return {
          toolName:              "get_campaign_stats",
          toolArgs:              { campaignId: match.id },
          intent:                "get_campaign_stats",
          activeCampaignId:      match.id,
          pendingCampaignAction: undefined,
          campaignSelectionList: undefined,
        };
      }

      // ── schedule: the time from the original request (or this reply) → approval card ─────────
      if (action === "schedule_campaign") {
        const schedulingText = state.pendingScheduledAt ?? state.userMessage;
        this.log.info({ userId, campaignId: match.id }, "CampaignAgent: scheduling after selection");
        return this.scheduleCampaign(state, match.id, schedulingText);
      }

      // ── update_campaign: enter update wizard ───────────────────────────────
      if (action === "update_campaign") {
        return {
          toolName:            undefined,
          toolArgs:            {},
          error:               "Which field would you like to update?\n\nOptions: **name**, **subject**, **body**, **sender name**, **sender email**",
          pendingCampaignDraft: { _mode: "update", campaignId: match.id },
          pendingCampaignStep:  "update_select_field",
          pendingCampaignAction: undefined,
          campaignSelectionList: undefined,
          intent:                "update_campaign",
        };
      }

      // ── generate personalized emails: the agent's own writer (the old tool's backend route does not exist) ──
      if (action === "generate_personalized_emails") {
        return {
          ...(await startPersonalizeFor(state, match)),
          pendingCampaignAction: undefined,
          campaignSelectionList: undefined,
          activeCampaignId:      match.id,
        };
      }

      // ── start / pause / resume ─────────────────────────────────────────────
      // A campaign that cannot take the action gets no approval card (bugs B19-02, B19-04).
      const blocked = await campaignActionBlock(state, action, match.id, { named: true });
      if (blocked) return blocked;
      const toolName = TOOL_MAP[action as keyof typeof TOOL_MAP] as KnownToolName;
      return {
        toolName,
        toolArgs:              { campaignId: match.id },
        intent:                action,
        pendingCampaignAction: undefined,
        campaignSelectionList: undefined,
      };
    }

    // The user named a campaign that exists but can't take this action
    // ("pause campaign id 17" when #17 is already paused) — say why.
    // A bare number is a position in the list shown, never a hidden campaign.
    const hidden = rawList.filter((c) => !list.includes(c));
    const blocked = hidden.length && !/^\s*\d+\s*$/.test(state.userMessage) ? matchCampaignSelection(state.userMessage, hidden) : undefined;
    const msg = formatCampaignSelectionList(rawList, action);
    if (blocked) {
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 `**${blocked.name}** (#${blocked.id}) is ${blocked.status}. ${msg}`,
        pendingCampaignAction: list.length ? action : undefined,
        campaignSelectionList: list.length ? rawList : undefined,
      };
    }

    // "50" / "0" for a list of 38: say what is allowed, without posting the whole list again (QA P4 bug 25).
    if (bareNumber && list.length) {
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 `There's no campaign **${bareNumber}** in the list. Please reply with a number from **1** to **${list.length}**, ` +
          "the campaign's ID (like 434), or its name. Say **cancel** to stop.",
        pendingCampaignAction: action,
        campaignSelectionList: rawList,
      };
    }

    // Unclear response — re-present the list
    this.log.debug({ userId, action }, "Campaign selection unclear — re-presenting list");
    return {
      toolName:              undefined,
      toolArgs:              {},
      error:                 `I didn't catch that.\n\n${msg}`,
      pendingCampaignAction: action,
      campaignSelectionList: rawList,
    };
  }

  // ── SMTP profile selection ────────────────────────────────────────────────────

  private handleSmtpSelection(
    state: AgentGraphStateType,
  ): Partial<AgentGraphStateType> {
    const { userId } = state;
    const choices = state.smtpProfileChoices!;
    const draft   = state.pendingCampaignDraft ?? {};

    if (isCancellation(state.userMessage)) {
      this.log.info({ userId }, "SMTP selection cancelled");
      return {
        toolName:                  undefined,
        toolArgs:                  {},
        error:                     "Campaign creation cancelled. Let me know when you'd like to try again.",
        pendingSmtpSelectionAction: undefined,
        smtpProfileChoices:        undefined,
        pendingCampaignDraft:      undefined,
        pendingCampaignStep:       undefined,
      };
    }

    // Match by number (1-based) or by email/name substring
    const trimmed = state.userMessage.trim();
    const num = parseInt(trimmed, 10);
    let match: { id: number; fromEmail: string; fromName: string } | undefined;
    if (!isNaN(num) && num >= 1 && num <= choices.length) {
      match = choices[num - 1];
    } else {
      const lower = trimmed.toLowerCase();
      match = choices.find(
        (c) =>
          c.fromEmail.toLowerCase().includes(lower) ||
          c.fromName.toLowerCase().includes(lower) ||
          lower.includes(c.fromEmail.toLowerCase()),
      );
    }

    if (!match) {
      const listLines = choices.map((c, i) => `${i + 1}. **${c.fromEmail}**${c.fromName ? ` (${c.fromName})` : ""}`);
      this.log.debug({ userId }, "SMTP selection unclear — re-presenting choices");
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          "I didn't catch that. Which SMTP account should I use to send this campaign?",
          "",
          ...listLines,
          "",
          "Reply with the **number** or **email address**.",
        ].join("\n"),
        pendingSmtpSelectionAction: "create_campaign",
        smtpProfileChoices:        choices,
      };
    }

    this.log.info({ userId, smtpSettingsId: match.id, fromEmail: match.fromEmail }, "SMTP profile selected — re-dispatching create_campaign");
    return {
      toolName:                  "create_campaign",
      toolArgs:                  { ...draft, smtpSettingsId: match.id },
      pendingSmtpSelectionAction: undefined,
      smtpProfileChoices:        undefined,
      pendingCampaignDraft:      undefined,
      pendingCampaignStep:       undefined,
      intent:                    "create_campaign",
    };
  }

  // ── create_campaign: initial request ─────────────────────────────────────────

  private async handleCreateCampaign(
    state: AgentGraphStateType,
    resolvedArgs: Record<string, string>,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId } = state;

    let partial: Record<string, string> = { ...resolvedArgs };
    if (!hasAllCreateCampaignFields(partial)) {
      const fromMsg = tryExtractFromMessage(state.userMessage);
      partial = { ...fromMsg, ...partial };
    }

    if (state.senderDefaults) {
      if (!partial.fromName)  partial.fromName  = state.senderDefaults.fromName;
      if (!partial.fromEmail) partial.fromEmail = state.senderDefaults.fromEmail;
    }

    // Inject remembered SMTP profile so repeat campaigns skip the selection step.
    const smtpSettingsId = state.senderDefaults?.smtpSettingsId;

    if (hasAllCreateCampaignFields(partial)) {
      this.log.info({ userId, smtpSettingsId }, "create_campaign: all fields present — dispatching directly");
      return {
        toolName: "create_campaign",
        toolArgs: smtpSettingsId ? { ...partial, smtpSettingsId } : partial,
      };
    }

    const openai = getOpenAIService();
    if (openai) {
      try {
        const generated = await openai.generateCampaignDraft(state.userMessage, partial);
        if (generated) {
          const draft = { ...generated, ...partial };
          if (hasAllCreateCampaignFields(draft)) {
            const msg = formatDraft(draft, "Here's a draft campaign based on your request:");
            this.log.info({ userId }, "create_campaign: auto-generated draft — awaiting confirmation");
            return {
              toolName:             undefined,
              toolArgs:             {},
              error:                msg,
              pendingCampaignDraft: draft,
              pendingCampaignStep:  "confirm",
            };
          }
        }
      } catch {
        // Fall through to step-by-step
      }
    }

    const nextField = getNextMissingField(partial);
    if (!nextField) {
      return { toolName: "create_campaign", toolArgs: partial };
    }

    this.log.info({ userId, nextField }, "create_campaign: starting step-by-step wizard");
    return {
      toolName:             undefined,
      toolArgs:             {},
      error:                `Let me help you create your campaign step by step.\n\n${STEP_QUESTIONS[nextField]}`,
      pendingCampaignDraft: partial,
      pendingCampaignStep:  nextField,
    };
  }

  // ── Draft continuation ────────────────────────────────────────────────────────

  private async handleDraftContinuation(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId } = state;
    const draft = state.pendingCampaignDraft!;
    const step  = state.pendingCampaignStep;

    // ── Update campaign wizard ────────────────────────────────────────────────
    if (draft._mode === "update") {
      return this.handleUpdateWizard(state, draft, step);
    }

    // ── Create campaign wizard ────────────────────────────────────────────────
    if (isCancellation(state.userMessage)) {
      this.log.info({ userId }, "create_campaign: draft cancelled by user");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                "Campaign creation cancelled. Let me know when you'd like to try again.",
        pendingCampaignDraft: undefined,
        pendingCampaignStep:  undefined,
        intent:               "create_campaign",
      };
    }

    if (step === "confirm" || hasAllCreateCampaignFields(draft)) {
      if (isConfirmation(state.userMessage)) {
        this.log.info({ userId }, "create_campaign: draft confirmed — dispatching tool");
        const smtpId = state.senderDefaults?.smtpSettingsId;
        return {
          toolName:             "create_campaign",
          toolArgs:             smtpId ? { ...draft, smtpSettingsId: smtpId } : draft,
          pendingCampaignDraft: undefined,
          pendingCampaignStep:  undefined,
          intent:               "create_campaign",
        };
      }

      const editsFromLLM = resolveToolArgs("create_campaign", {
        extractedArgs:    state.llmExtractedArgs,
        activeCampaignId: state.activeCampaignId,
      }) as Record<string, string>;
      const editsFromMsg = tryExtractFromMessage(state.userMessage);
      // "change the name to X", "call it X", "rename it to X" (QA P3 bug 41: only subject edits worked).
      const newName = draftNameEdit(state.userMessage);
      const edits = Object.fromEntries(
        Object.entries({ ...editsFromMsg, ...editsFromLLM, ...(newName ? { name: newName } : {}) }).filter(
          ([k, v]) =>
            (FIELD_ORDER as readonly string[]).includes(k) &&
            typeof v === "string" &&
            v.trim().length > 0,
        ),
      ) as Record<string, string>;

      if (Object.keys(edits).length > 0) {
        const updated = { ...draft, ...edits };
        const msg = formatDraft(updated, "Got it — here's the updated draft:");
        this.log.info({ userId, editedFields: Object.keys(edits) }, "create_campaign: draft updated");
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:                msg,
          pendingCampaignDraft: updated,
          pendingCampaignStep:  "confirm",
          intent:               "create_campaign",
        };
      }

      const msg = formatDraft(draft, "I still have this draft ready for you:");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                msg,
        pendingCampaignDraft: draft,
        pendingCampaignStep:  "confirm",
        intent:               "create_campaign",
      };
    }

    const currentField = step as CampaignField;

    const fromLLM = resolveToolArgs("create_campaign", {
      extractedArgs:    state.llmExtractedArgs,
      activeCampaignId: state.activeCampaignId,
    }) as Record<string, string>;
    const fromMsg = tryExtractFromMessage(state.userMessage);

    if (currentField === "body" && /^\s*generate\s*$/i.test(state.userMessage)) {
      const openai = getOpenAIService();
      const generatedBody = openai
        ? await openai
            .generateCampaignDraft(
              `Write the email body for a campaign named "${draft.name ?? ""}" with subject "${draft.subject ?? ""}"`,
              { name: draft.name, subject: draft.subject },
            )
            .then((r) => r?.body ?? null)
            .catch(() => null)
        : null;

      if (generatedBody) {
        const updatedDraft = { ...draft, ...fromMsg, ...fromLLM, body: generatedBody };
        const nextField = getNextMissingField(updatedDraft);
        if (!nextField) {
          const msg = formatDraft(updatedDraft, "I've written the body for you. Here's your complete campaign draft:");
          return {
            toolName:             undefined,
            toolArgs:             {},
            error:                msg,
            pendingCampaignDraft: updatedDraft,
            pendingCampaignStep:  "confirm",
            intent:               "create_campaign",
          };
        }
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:                `Body written! ${STEP_QUESTIONS[nextField]}`,
          pendingCampaignDraft: updatedDraft,
          pendingCampaignStep:  nextField,
          intent:               "create_campaign",
        };
      }

      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                "I wasn't able to generate a body right now. Please describe what you'd like the email to say.",
        pendingCampaignDraft: { ...draft, ...fromMsg, ...fromLLM },
        pendingCampaignStep:  "body",
        intent:               "create_campaign",
      };
    }

    const fieldValue = (fromLLM[currentField] ?? fromMsg[currentField] ?? state.userMessage).trim();
    const updatedDraft = { ...draft, ...fromMsg, ...fromLLM, [currentField]: fieldValue };
    const nextField = getNextMissingField(updatedDraft);

    if (!nextField) {
      const msg = formatDraft(updatedDraft, "Great! Here's your complete campaign draft:");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                msg,
        pendingCampaignDraft: updatedDraft,
        pendingCampaignStep:  "confirm",
        intent:               "create_campaign",
      };
    }

    const ack = STEP_ACKS[currentField] ?? "";
    return {
      toolName:             undefined,
      toolArgs:             {},
      error:                `${ack}${STEP_QUESTIONS[nextField]}`,
      pendingCampaignDraft: updatedDraft,
      pendingCampaignStep:  nextField,
      intent:               "create_campaign",
    };
  }

  // ── Update campaign wizard ────────────────────────────────────────────────────

  private async handleUpdateWizard(
    state: AgentGraphStateType,
    draft: Record<string, string>,
    step: string | undefined,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId } = state;
    const campaignId = draft.campaignId ?? "";

    if (isCancellation(state.userMessage)) {
      this.log.info({ userId }, "update_campaign: wizard cancelled");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                "Update cancelled. Let me know when you'd like to try again.",
        pendingCampaignDraft: undefined,
        pendingCampaignStep:  undefined,
        intent:               "update_campaign",
      };
    }

    // ── Step 1: collect which field to update ──────────────────────────────
    if (step === "update_select_field") {
      const field = resolveUpdateField(state.userMessage);
      if (!field) {
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:
            `I didn't recognise that field. Please choose one of:\n\n` +
            `**name**, **subject**, **body**, **sender name**, **sender email**`,
          pendingCampaignDraft: draft,
          pendingCampaignStep:  "update_select_field",
          intent:               "update_campaign",
        };
      }
      // Sender name / email come from the email account: offer another account (it "updated" nothing).
      if (field === "fromName" || field === "fromEmail") return this.senderChange(state, campaignId);
      const label = UPDATE_FIELD_LABELS[field] ?? field;
      return {
        toolName:             undefined,
        toolArgs:             {},
        error:                `What should the new **${label}** be?`,
        pendingCampaignDraft: { ...draft, _updateField: field },
        pendingCampaignStep:  "update_field_value",
        intent:               "update_campaign",
      };
    }

    // ── Sender: pick another email account ───────────────────────────────
    if (step === "update_smtp_pick") {
      let choices: Array<{ id: number; fromEmail: string; fromName?: string }> = [];
      try { choices = JSON.parse(draft._smtpChoices ?? "[]"); } catch { choices = []; }
      const msg = state.userMessage.trim().toLowerCase();
      const n = Number(msg.match(/^#?(\d{1,2})$/)?.[1]);
      const pick = (n >= 1 ? choices[n - 1] : undefined) ?? choices.find((c) => msg.includes(c.fromEmail.toLowerCase()));
      if (!pick) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: `Please reply with a number from 1 to ${choices.length}, or **cancel**.`,
          pendingCampaignDraft: draft,
          pendingCampaignStep: "update_smtp_pick",
          intent: "update_campaign",
        };
      }
      return {
        toolName: "update_campaign",
        toolArgs: { campaignId, smtpSettingsId: pick.id },
        pendingCampaignDraft: undefined,
        pendingCampaignStep: undefined,
        intent: "update_campaign",
        activeCampaignId: campaignId,
      };
    }

    // ── Step 2: collect the new value ─────────────────────────────────────
    if (step === "update_field_value") {
      const field = draft._updateField;
      if (!field || !campaignId) {
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:                "Something went wrong with the update wizard. Please try again: say **Update campaign**.",
          pendingCampaignDraft: undefined,
          pendingCampaignStep:  undefined,
          intent:               "update_campaign",
        };
      }
      if (field === "fromName" || field === "fromEmail") return this.senderChange(state, campaignId);
      // The whole reply is the new value (quotes around it are dropped); shown old → new on a card.
      const newValue = state.userMessage.trim().replace(/^["'“‘](.*)["'”’]$/s, "$1").trim();
      this.log.info({ userId, campaignId, field, newValue: newValue.slice(0, 50) }, "update_campaign: confirm card");
      return this.campaignEdit(state, campaignId, field as EditField, newValue);
    }

    // Fallback — restart wizard
    return {
      toolName:             undefined,
      toolArgs:             {},
      error:                "Which field would you like to update?\n\nOptions: **name**, **subject**, **body**, **sender name**, **sender email**",
      pendingCampaignDraft: { _mode: "update", campaignId },
      pendingCampaignStep:  "update_select_field",
      intent:               "update_campaign",
    };
  }

  // ── Phase 1: AI Campaign wizard ───────────────────────────────────────────────

  private startAiWizard(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const { userId } = state;
    this.log.info({ userId }, "AI wizard: starting — asking for campaign name");
    return {
      toolName:             undefined,
      toolArgs:             {},
      error: [
        "Let's create an AI-assisted campaign step by step!",
        "",
        "**Step 1 of 6 — Campaign name**",
        "What should we call this campaign?",
        "",
        "Example: *\"Summer Sale 2026\"*, *\"Monthly Newsletter\"*, *\"Product Launch\"*",
      ].join("\n"),
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      intent:                "create_ai_campaign",
    };
  }

  /** Creates the draft campaign from the wizard data (after the user approved the summary). */
  private createWizardCampaign(
    state: AgentGraphStateType,
    data: Record<string, string>,
  ): Partial<AgentGraphStateType> {
    const { campaignName, subject, body } = data;
    if (!campaignName || !subject || !body) {
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 "I still need the campaign name, subject, and body before creating this campaign. Please restart the wizard.",
        pendingAiCampaignStep: undefined,
        pendingAiCampaignData: undefined,
        intent:                "create_ai_campaign",
      };
    }
    this.log.info({ userId: state.userId, campaignName }, "AI wizard: summary approved — creating draft campaign");
    const wizardSmtpId = state.senderDefaults?.smtpSettingsId;
    // Saved as HTML paragraphs: a plain-text body lost its line breaks in the campaign preview (bug A-11).
    const html = wizardBodyHtml(body);
    return {
      toolName: "create_campaign",
      toolArgs: wizardSmtpId
        ? { name: campaignName, subject, body: html, smtpSettingsId: wizardSmtpId }
        : { name: campaignName, subject, body: html },
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: data,
      intent:                "create_ai_campaign",
    };
  }

  /**
   * "Schedule X for 31 December 2026 at 10:00" — a real schedule (it was a JSON stub that saved nothing):
   * the time is read in the user's zone, a past time is refused, the campaign must be able to take a
   * schedule and have recipients, then an approval card ("Send at …") sets scheduledAt on Confirm.
   */
  private async scheduleCampaign(
    state: AgentGraphStateType,
    campaignId: string,
    text: string,
  ): Promise<Partial<AgentGraphStateType>> {
    const clear = { pendingCampaignAction: undefined, campaignSelectionList: undefined, pendingScheduledAt: undefined };
    const c = await campaignText(state, campaignId);
    const who = c ? `**${c.name}** (#${c.id})` : `campaign **#${campaignId}**`;
    const status = (c?.status ?? "").toLowerCase();
    if (c && !["draft", "scheduled", "paused"].includes(status)) {
      return { toolName: undefined, toolArgs: {}, error: `${who} is **${status === "in_progress" ? "running" : status}** — only draft, scheduled or paused campaigns can be scheduled.`, ...clear };
    }
    if (c && c.recipientCount === 0) {
      return {
        toolName: undefined,
        toolArgs: {},
        error: `${who} has **no recipients**, so a schedule would send nothing. Add recipients first (📎 in the chat, or on the campaign's page), then schedule it.`,
        ...clear,
      };
    }
    const timeZone = state.clientTimezone || "Asia/Karachi";
    const when = await scheduleTimeFrom(text, timeZone);
    if (when.kind === "past") {
      return { toolName: undefined, toolArgs: {}, error: `**${when.local}** (${timeZone}) has already passed. Please give a time in the future.`, ...clear };
    }
    if (when.kind === "unclear") {
      return {
        toolName: undefined,
        toolArgs: {},
        error: `When should ${who} go out? Give a date and time, e.g. *schedule campaign ${campaignId} for tomorrow at 10 AM* or *… for 2026-12-31 10:00*.`,
        activeCampaignId: campaignId,
        ...clear,
      };
    }
    return {
      toolName: "update_campaign",
      toolArgs: { campaignId, scheduledAt: when.iso },
      intent: "schedule_campaign",
      activeCampaignId: campaignId,
      ...clear,
    };
  }

  /**
   * One change to a saved campaign → an approval card showing old → new (it saved with no confirmation).
   * Only draft / paused / scheduled campaigns can be edited (the backend's rule, said plainly here).
   */
  private async campaignEdit(
    state: AgentGraphStateType,
    campaignId: string,
    field: EditField,
    value: string,
  ): Promise<Partial<AgentGraphStateType>> {
    const clear = { pendingCampaignDraft: undefined, pendingCampaignStep: undefined };
    const c = await campaignText(state, campaignId);
    const who = c ? `**${c.name}** (#${c.id})` : `campaign **#${campaignId}**`;
    const status = (c?.status ?? "").toLowerCase();
    if (c && !["draft", "paused", "scheduled"].includes(status)) {
      return {
        toolName: undefined,
        toolArgs: {},
        error: `${who} is **${status === "in_progress" ? "running" : status}** — only draft, paused or scheduled campaigns can be edited. You can **duplicate** it on the Campaigns page and edit the copy.`,
        ...clear,
      };
    }
    const v = value.trim();
    if ((field === "subject" || field === "name") && v.length > 255) {
      return { toolName: undefined, toolArgs: {}, error: `That ${field} is ${v.length} characters long — the limit is 255. Please send a shorter one.`, ...clear };
    }
    if (!v) return { toolName: undefined, toolArgs: {}, error: `The new ${field} can't be empty.`, ...clear };
    return {
      toolName: "update_campaign",
      toolArgs: { campaignId, [field]: field === "body" ? bodyForSave(v) : v },
      intent: "update_campaign",
      activeCampaignId: campaignId,
      ...clear,
    };
  }

  /**
   * "Change the sender name / email": they come from the campaign's email account, so the only real
   * change is another account. It used to answer "Campaign updated successfully" and change nothing.
   */
  private async senderChange(state: AgentGraphStateType, campaignId: string): Promise<Partial<AgentGraphStateType>> {
    const clear = { pendingCampaignDraft: undefined, pendingCampaignStep: undefined };
    const [c, accounts] = await Promise.all([campaignText(state, campaignId), smtpAccounts(state)]);
    const who = c ? `**${c.name}** (#${c.id})` : `campaign **#${campaignId}**`;
    const current = c?.fromEmail ? `${c.fromName ? `${c.fromName} ` : ""}<${c.fromEmail}>` : "its email account";
    const intro = `The sender name and email of ${who} come from the email account it sends from — currently **${current}**. They can't be typed in here; to change them, pick another account (or edit the account in **Settings → SMTP**).`;
    const others = (accounts ?? []).filter((a) => a.id !== c?.smtpSettingsId);
    if (!others.length) {
      return { toolName: undefined, toolArgs: {}, error: `${intro}\n\nYou have no other email account. Add one in **Settings → SMTP**.`, ...clear };
    }
    return {
      toolName: undefined,
      toolArgs: {},
      error: [
        intro,
        "",
        "**Which account should send it?**",
        ...others.map((a, i) => `${i + 1}. **${a.fromEmail}**${a.fromName ? ` (${a.fromName})` : ""}`),
        "",
        "Reply with the number, or **cancel**.",
      ].join("\n"),
      pendingCampaignDraft: { _mode: "update", campaignId, _smtpChoices: JSON.stringify(others) },
      pendingCampaignStep: "update_smtp_pick",
      intent: "update_campaign",
    };
  }

  /** The AI wizard's end: the draft has its recipients; say what can be done with it next. */
  private finishAiWizard(
    state: AgentGraphStateType,
    data: NonNullable<AgentGraphStateType["pendingAiCampaignData"]>,
  ): Partial<AgentGraphStateType> {
    const count = parseInt(data.recipientCount ?? "", 10);
    const name = data.campaignName ? `**${data.campaignName}**` : "Your campaign";
    return {
      toolName: undefined,
      toolArgs: {},
      error: [
        Number.isFinite(count) && count > 0
          ? `Great! ${name} has **${count}** recipient${count !== 1 ? "s" : ""} and is saved as a **draft**.`
          : `${name} is saved as a **draft**.`,
        "",
        "Every email starts with the recipient's own first name ({first_name} is filled in for each person).",
        "",
        "What next?",
        "- **Start campaign**: send it now",
        "- **Schedule campaign**: pick a date and time",
        "- **Generate personalized emails**: I research every recipient and write each one their own email (saved as a new draft copy)",
      ].join("\n"),
      pendingAiCampaignStep: undefined,
      pendingAiCampaignData: undefined,
      intent:                "create_ai_campaign",
      ...(state.activeCampaignId ? { activeCampaignId: state.activeCampaignId } : {}),
    };
  }

  private async handleAiWizardContinuation(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId, activeCampaignId } = state;
    const step = state.pendingAiCampaignStep!;
    const data = state.pendingAiCampaignData ?? {};
    const msg  = state.userMessage.trim();

    if (isCancellation(msg)) {
      this.log.info({ userId, step }, "AI wizard cancelled");
      // Before the summary is approved nothing exists on the server yet.
      const created = !["campaign_name", "campaign_subject", "template_selection", "campaign_body", "confirm_create"].includes(step);
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 created
          ? "AI campaign wizard cancelled. Your campaign draft is still saved — let me know when you'd like to continue."
          : "AI campaign wizard cancelled — nothing was created.",
        pendingAiCampaignStep: undefined,
        pendingAiCampaignData: undefined,
        intent:                "create_ai_campaign",
      };
    }

    // The old back half (tone → instructions → save_ai_prompt → generate → review) called backend routes that
    // do not exist (/ai-prompt, /generate-personalized, /personalized-emails), so it always failed. A session
    // still on one of those steps ends the wizard with the working next steps instead.
    if (["template", "tone", "custom_prompt", "generate", "review", "approve"].includes(step)) {
      return this.finishAiWizard(state, data);
    }

    // ── Step: campaign_name — collect name, ask for subject ───────────────────
    if (step === "campaign_name") {
      if (!msg) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Please provide a name for your campaign.",
          pendingAiCampaignStep: "campaign_name",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      if (msg.length > AI_WIZARD_MAX_NAME) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 `That name is ${msg.length} characters long. Please use at most ${AI_WIZARD_MAX_NAME} characters.`,
          pendingAiCampaignStep: "campaign_name",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const nameProblem = campaignNameProblem(msg);
      if (nameProblem) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 nameProblem,
          pendingAiCampaignStep: "campaign_name",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const updatedData = { ...data, campaignName: msg };
      this.log.info({ userId, campaignName: msg }, "AI wizard: campaign name set");
      return {
        toolName:              undefined,
        toolArgs:              {},
        error: [
          `Campaign name: **${msg}**`,
          "",
          "**Step 2 of 6 — Subject line**",
          "What should the email subject line say?",
          "",
          "Example: *\"Exclusive 30% off — this weekend only\"*, *\"Your November newsletter is here\"*",
          "",
          "Type **back** to change the name, or **stop** to cancel.",
        ].join("\n"),
        pendingAiCampaignStep: "campaign_subject",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: campaign_subject — collect subject, advance to template selection ─
    if (step === "campaign_subject") {
      if (/^(back|previous|go back|edit name)$/i.test(msg)) {
        return {
          toolName: undefined,
          toolArgs: {},
          error: "Back to **Step 1 of 6 — Campaign name**. What should the campaign be called?",
          pendingAiCampaignStep: "campaign_name",
          pendingAiCampaignData: data,
          intent: "create_ai_campaign",
        };
      }
      const numberedSubject = msg.match(/^([1-3])$/)?.[1];
      if (numberedSubject && typeof data.subjectSuggestions === "string") {
        const subject = data.subjectSuggestions.split("\n")[Number(numberedSubject) - 1];
        if (subject) return this.handleAiWizardContinuation({ ...state, userMessage: subject } as AgentGraphStateType);
      }
      if (/\b(suggest|suggestion|ideas?|help|recommend|acha|achi|behtar|khud|likh\w*)\b/i.test(msg) &&
          /\b(subject|line|acha|achi|behtar|khud|likh\w*)\b/i.test(msg)) {
        const campaignName = String(data.campaignName ?? "your campaign").trim();
        const name = campaignName.replace(/[.!?]+$/g, "");
        const suggestions = [`A fresh update about ${name}`, `What’s new with ${name}?`, `A quick note for you: ${name}`];
        return {
          toolName: undefined,
          toolArgs: {},
          error: [
            `Here are three subject ideas for **${campaignName}**:`,
            "",
            ...suggestions.map((s, i) => `${i + 1}. ${s}`),
            "",
            "Reply with **1**, **2**, or **3** to use one, type your own subject, or say **back** to change the campaign name. Say **stop** to cancel.",
          ].join("\n"),
          pendingAiCampaignStep: "campaign_subject",
          pendingAiCampaignData: { ...data, subjectSuggestions: suggestions.join("\n") },
          intent: "create_ai_campaign",
        };
      }
      if (!msg) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Please provide a subject line for your campaign emails.",
          pendingAiCampaignStep: "campaign_subject",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      if (msg.length > AI_WIZARD_MAX_SUBJECT) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 `That subject line is ${msg.length} characters long. Please send a shorter one — at most ${AI_WIZARD_MAX_SUBJECT} characters.`,
          pendingAiCampaignStep: "campaign_subject",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const updatedData = { ...data, subject: msg };
      this.log.info({ userId, subject: msg }, "AI wizard: subject set — advancing to template selection");
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          `Subject set: **"${msg}"**`,
          "",
          "**Step 3 of 6 — Template type**",
          "Which type of email fits this campaign?",
          "",
          "1. **Promotional** — sales, discounts, offers",
          "2. **Newsletter** — updates, news, content",
          "3. **Event** — invitations, webinars, meetups",
          "4. **Announcement** — new product, feature, company news",
          "5. **Follow-up** — re-engagement, check-in",
          "",
          "Reply with the number or name.",
        ].join("\n"),
        pendingAiCampaignStep: "template_selection",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: template_selection — pick template, generate body draft ─────────
    if (step === "template_selection") {
      const TEMPLATE_MAP: Record<string, string> = {
        "1": "promotional", "promotional": "promotional",
        "2": "newsletter",  "newsletter":  "newsletter",
        "3": "event",       "event":       "event",
        "4": "announcement","announcement":"announcement",
        "5": "follow_up",   "follow-up":   "follow_up", "follow up": "follow_up",
      };
      const templateType = TEMPLATE_MAP[msg.toLowerCase()];
      if (!templateType) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Please choose a template type by replying **1–5** or the name (e.g. \"promotional\"). Say **stop** to cancel the wizard, then start a new chat for another question.",
          pendingAiCampaignStep: "template_selection",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const subject      = data.subject ?? "";
      const bodyDraft    = await writeWizardBody({
        campaignName: data.campaignName,
        subject,
        templateType,
        senderName: state.senderDefaults?.fromName,
      });
      const updatedData  = { ...data, templateType, body: bodyDraft };
      this.log.info({ userId, templateType }, "AI wizard: template selected — showing body draft");
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          `**${templateType.charAt(0).toUpperCase() + templateType.slice(1).replace(/_/g, "-")}** template selected.`,
          "",
          "**Step 4 of 6 — Email body**",
          "Here's a draft body for your campaign emails:",
          "",
          "---",
          bodyDraft,
          "---",
          "",
          "Reply **confirm** to use this, or type your changes.",
        ].join("\n"),
        pendingAiCampaignStep: "campaign_body",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: confirm_create — summary shown; create the draft only on a clear yes ─
    if (step === "confirm_create") {
      if (isConfirmation(msg) || /\bcreate\b/i.test(msg)) {
        return this.createWizardCampaign(state, data);
      }
      const wantsEdit = /\bedit\b|\bchange\b/i.test(msg);
      return {
        toolName:              undefined,
        toolArgs:              {},
        error: wantsEdit
          ? "Sure — tell me what to change in the email body (e.g. *make it shorter*, *add a call to action*)."
          : [
              "Nothing has been created yet.",
              "",
              "Reply **create** to create the draft campaign, **edit body** to change the email text, or **cancel** to stop.",
            ].join("\n"),
        pendingAiCampaignStep: wantsEdit ? "campaign_body" : "confirm_create",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: campaign_body — confirm/edit body, then show a summary to approve ─
    if (step === "campaign_body") {
      const campaignName = data.campaignName;
      const subject      = data.subject;
      if (isConfirmation(msg)) {
        const body = data.body ?? "";
        if (!campaignName || !subject || !body) {
          return {
            toolName:              undefined,
            toolArgs:              {},
            error:                 "I still need the campaign name, subject, and body before creating this campaign. Please restart the wizard.",
            pendingAiCampaignStep: undefined,
            pendingAiCampaignData: undefined,
            intent:                "create_ai_campaign",
          };
        }
        this.log.info({ userId, campaignName, subject }, "AI wizard: body confirmed — showing summary for approval");
        const sender = state.senderDefaults?.fromEmail;
        const template = data.templateType ? data.templateType.replace(/_/g, "-") : "custom";
        return {
          toolName: undefined,
          toolArgs: {},
          error: [
            "**Please check before I create the campaign**",
            "",
            `- **Name:** ${campaignName}`,
            `- **Subject:** ${subject} (${subject.length} characters)`,
            `- **Template:** ${template}`,
            `- **Sender:** ${sender ?? "your default SMTP account"}`,
            `- **Body:** ${body.length} characters`,
            "",
            "This creates a **draft** — no emails are sent. Next you will upload recipients; nothing is sent until you start or schedule it.",
            "",
            "Reply **create** to continue, **edit body** to change the email text, or **cancel** to stop.",
          ].join("\n"),
          pendingAiCampaignStep: "confirm_create",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      // User wants to change the body — treat the message as an instruction to
      // modify the current draft (e.g. "make it shorter", "add urgency"), not
      // as the literal new body text.
      const currentBody = data.body ?? "";
      const openai = getOpenAIService();
      let revisedBody = msg;
      if (openai && currentBody) {
        try {
          const revised = await openai.reviseCampaignBody(currentBody, msg, campaignName, subject);
          if (revised && revised.trim()) {
            // Keep the campaign placeholder style ({first_name}, one pair of braces) and plain text.
            revisedBody = revised.trim().replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, "{$1}").replace(/\*\*([^*]+)\*\*/g, "$1");
          }
        } catch (err) {
          this.log.warn({ userId, error: err instanceof Error ? err.message : String(err) }, "AI wizard: body revision failed — falling back to literal replacement");
        }
      }
      const updatedData = { ...data, body: revisedBody };
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          "Got it — here's your updated email body:",
          "",
          "---",
          revisedBody,
          "---",
          "",
          "Reply **confirm** to proceed, or describe more changes.",
        ].join("\n"),
        pendingAiCampaignStep: "campaign_body",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Steps: recipient_source / upload_recipients / check_count — "done": count the recipients ─
    // The count is read here (the list of the campaign's recipients). It used to go through
    // get_recipient_count, whose backend route does not exist, so the wizard always saw 0 and
    // alternated between two different "upload" instructions (bug: wizard never reached the end).
    if (step === "recipient_source" || step === "upload_recipients" || step === "check_count") {
      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "I lost track of your campaign. Say **create AI campaign** to start again.",
          pendingAiCampaignStep: undefined,
          pendingAiCampaignData: undefined,
          intent:                "create_ai_campaign",
        };
      }
      const count = await wizardRecipientCount(state, activeCampaignId);
      if (count === undefined) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "I couldn't check the recipients right now. Say **done** to try again.",
          pendingAiCampaignStep: "upload_recipients",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      if (count === 0) {
        this.log.info({ userId, activeCampaignId }, "AI wizard: no recipients yet");
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 noWizardRecipientsMessage(data.campaignName),
          pendingAiCampaignStep: "upload_recipients",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      this.log.info({ userId, activeCampaignId, count }, "AI wizard: recipients found — wizard done");
      return this.finishAiWizard(state, { ...data, recipientCount: String(count) });
    }

    // ── Step: template ────────────────────────────────────────────────────────
    if (step === "template") {
      const TEMPLATE_MAP: Record<string, string> = {
        "1": "promotional", "promotional": "promotional",
        "2": "newsletter",  "newsletter":  "newsletter",
        "3": "event",       "event":       "event",
        "4": "announcement","announcement":"announcement",
        "5": "follow_up",   "follow-up":   "follow_up", "follow up": "follow_up",
      };
      const templateType = TEMPLATE_MAP[msg.toLowerCase()];
      if (!templateType) {
        return {
          toolName:             undefined,
          toolArgs:             {},
          error:                "Please choose a template type by replying **1–5** or the name (e.g. \"promotional\").",
          pendingAiCampaignStep: "template",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const updatedData = { ...data, templateType };
      this.log.info({ userId, templateType }, "AI wizard: template selected");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error: [
          `**${templateType.charAt(0).toUpperCase() + templateType.slice(1)}** template selected.`,
          "",
          "**Step 5 of 6 — Tone & style**",
          "How should the emails sound? Describe the tone you want, or say **skip** to use a professional default.",
          "",
          "Examples: *\"friendly and casual\"*, *\"formal and authoritative\"*, *\"urgent and exciting\"*",
        ].join("\n"),
        pendingAiCampaignStep: "tone",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: tone ────────────────────────────────────────────────────────────
    if (step === "tone") {
      const tone = /^skip$/i.test(msg) ? undefined : msg;
      const updatedData = tone ? { ...data, toneInstruction: tone } : data;
      this.log.info({ userId, tone }, "AI wizard: tone set");
      return {
        toolName:             undefined,
        toolArgs:             {},
        error: [
          tone ? `Tone set to **"${tone}"**.` : "Using default professional tone.",
          "",
          "**Step 6 of 6 — Custom instructions** (optional)",
          "Any specific instructions for the AI writer? Say **skip** to continue.",
          "",
          "Example: *\"Mention our 30-day money-back guarantee in each email\"*",
        ].join("\n"),
        pendingAiCampaignStep: "custom_prompt",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: custom_prompt — collect instructions then save AI config ────────
    if (step === "custom_prompt") {
      const customPrompt = /^skip$/i.test(msg) ? undefined : msg;
      const updatedData = customPrompt ? { ...data, customPrompt } : data;
      this.log.info({ userId }, "AI wizard: custom prompt set — saving AI configuration");

      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Lost campaign reference. Please restart the AI wizard.",
          pendingAiCampaignStep: undefined,
          pendingAiCampaignData: undefined,
          intent:                "create_ai_campaign",
        };
      }

      return {
        toolName: "save_ai_prompt",
        toolArgs: {
          campaignId:      activeCampaignId,
          templateType:    updatedData.templateType,
          toneInstruction: updatedData.toneInstruction,
          customPrompt:    updatedData.customPrompt,
        },
        pendingAiCampaignStep: "generate",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: generate ────────────────────────────────────────────────────────
    if (step === "generate") {
      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Lost campaign reference. Please restart the AI wizard.",
          pendingAiCampaignStep: undefined,
          pendingAiCampaignData: undefined,
        };
      }
      this.log.info({ userId, activeCampaignId }, "AI wizard: triggering generation");
      return {
        toolName:              "generate_personalized_emails",
        toolArgs:              {
          campaignId: activeCampaignId,
          ...extractGenerationOverrides(data.toneInstruction),
        },
        pendingAiCampaignStep: "review",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: review — show samples and ask for approval ─────────────────────
    if (step === "review") {
      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "Lost campaign reference. Please restart the AI wizard.",
          pendingAiCampaignStep: undefined,
          pendingAiCampaignData: undefined,
        };
      }
      this.log.info({ userId, activeCampaignId }, "AI wizard: fetching sample emails for review");
      return {
        toolName:              "get_personalized_emails",
        toolArgs:              { campaignId: activeCampaignId, limit: 3 },
        pendingAiCampaignStep: "approve",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: approve — user confirms then campaign is started/scheduled ──────
    if (step === "approve") {
      if (/regenerate|tone|cta|sequence|breakup|shorten emails|shorten sequence|technical|founder/i.test(msg)) {
        if (!activeCampaignId) {
          return {
            toolName:              undefined,
            toolArgs:              {},
            error:                 "Lost campaign reference. Please restart the AI wizard.",
            pendingAiCampaignStep: undefined,
            pendingAiCampaignData: undefined,
          };
        }
        return {
          toolName: "generate_personalized_emails",
          toolArgs: {
            campaignId: activeCampaignId,
            overwrite: true,
            ...extractGenerationOverrides(msg),
          },
          pendingAiCampaignStep: "review",
          pendingAiCampaignData: { ...data, lastRegenerationRequest: msg },
          intent: "create_ai_campaign",
        };
      }

      if (wantsReviewSequence(msg)) {
        if (!activeCampaignId) {
          return {
            toolName:              undefined,
            toolArgs:              {},
            error:                 "Lost campaign reference. Please restart the AI wizard.",
            pendingAiCampaignStep: undefined,
            pendingAiCampaignData: undefined,
          };
        }
        return {
          toolName: "get_personalized_emails",
          toolArgs: { campaignId: activeCampaignId, limit: 3 },
          pendingAiCampaignStep: "approve",
          pendingAiCampaignData: data,
          intent: "create_ai_campaign",
        };
      }

      if (isConfirmation(msg)) {
        if (!activeCampaignId) {
          return {
            toolName:              undefined,
            toolArgs:              {},
            error:                 "Lost campaign reference. Please restart the AI wizard.",
            pendingAiCampaignStep: undefined,
            pendingAiCampaignData: undefined,
          };
        }
        const toolName: KnownToolName = data.scheduledAt ? "update_campaign" : "start_campaign";
        const toolArgs = data.scheduledAt
          ? { campaignId: activeCampaignId, scheduledAt: data.scheduledAt }
          : { campaignId: activeCampaignId };
        this.log.info({ userId, activeCampaignId, toolName }, "AI wizard: approved — dispatching");
        return {
          toolName,
          toolArgs,
          pendingAiCampaignStep: undefined,
          pendingAiCampaignData: undefined,
          intent:                data.scheduledAt ? "schedule_campaign" : "start_campaign",
          requiresApproval:      true,
        };
      }

      // Not confirmed — re-present options
      return {
        toolName:             undefined,
        toolArgs:             {},
        error: [
          "Ready to launch when you are.",
          "",
          'Reply **confirm** to start the campaign, or **cancel** to abort.',
          data.scheduledAt ? `Scheduled for: **${data.scheduledAt}**` : "Campaign will start immediately.",
        ].join("\n"),
        pendingAiCampaignStep: "approve",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // Unknown step — reset
    this.log.warn({ userId, step }, "AI wizard: unknown step — resetting");
    return {
      toolName:              undefined,
      toolArgs:              {},
      error:                 "Something went wrong with the AI campaign wizard. Say **\"create AI campaign\"** to start again.",
      pendingAiCampaignStep: undefined,
      pendingAiCampaignData: undefined,
      intent:                "create_ai_campaign",
    };
  }

  // ── CSV file ingestion wizard ─────────────────────────────────────────────────

  private async handleCsvUpload(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { userId, activeCampaignId } = state;
    const csvFile = state.pendingCsvFile;
    const csvData = state.pendingCsvData;

    // ── Step 1: file just arrived — parse it for preview + rows ─────────────
    if (csvFile && !csvData) {
      this.log.info({ userId, filename: csvFile.filename }, "CSV upload: parsing file for preview");
      return {
        toolName: "parse_csv_file",
        toolArgs: {
          fileContent: csvFile.fileContent,
          filename:    csvFile.filename,
        },
        intent: "upload_csv",
      };
    }

    // ── Step 2: preview shown — handle user response ─────────────────────────
    // csvData.rows holds all valid parsed rows (no raw file buffer needed).
    if (csvData) {
      const msg = state.userMessage.trim().toLowerCase();

      // Review — show the full parsed recipient list (not just the 5-row preview)
      if (/\b(review all|view all|show all|full list|all recipients|list all|see all|3)\b/.test(msg)) {
        this.log.info({ userId, rowCount: csvData.rows.length }, "CSV upload: showing full recipient list");
        const lines = csvData.rows.map((row, i) => {
          const email = row.email ?? Object.values(row)[0] ?? "—";
          const name  = row.name ? ` — ${row.name}` : "";
          return `${i + 1}. ${email}${name}`;
        });
        return {
          toolName: undefined,
          toolArgs: {},
          error: [
            `**Full recipient list (${csvData.validRows}):**`,
            "",
            ...lines,
            "",
            "Reply **yes** to save these recipients, **generate** to create personalized emails, or **discard** to cancel.",
          ].join("\n"),
          intent: "upload_csv",
        };
      }

      // Discard
      if (/\b(discard|cancel|no|skip|remove|delete|4)\b/.test(msg)) {
        this.log.info({ userId }, "CSV upload: discarded by user");
        return {
          toolName:       undefined,
          toolArgs:       {},
          error:          "CSV discarded. No recipients were saved. Let me know if you need anything else.",
          pendingCsvFile: undefined,
          pendingCsvData: undefined,
          intent:         "upload_csv",
        };
      }

      // Save — use parsed rows from pendingCsvData (raw file buffer not needed)
      if (
        /\b(save|yes|confirm|1|add|import|proceed|ok|okay|sure)\b/.test(msg) ||
        /save recipients/i.test(msg)
      ) {
        if (!activeCampaignId) {
          this.log.info({ userId }, "CSV upload: save requested but no active campaign");
          return {
            toolName: undefined,
            toolArgs: {},
            error:    "Which campaign should I add these recipients to? Please share the campaign ID or name, or create a campaign first.",
            intent:   "upload_csv",
          };
        }
        this.log.info(
          { userId, activeCampaignId, rowCount: csvData.rows.length },
          "CSV upload: saving recipients via rows",
        );
        return {
          toolName: "save_csv_recipients",
          toolArgs: {
            campaignId: activeCampaignId,
            rows:       csvData.rows,
          },
          intent: "upload_csv",
          // The AI campaign wizard was waiting for exactly this: its recipients. The save answer lists
          // the next steps (start / schedule / personalize), so the wizard is done.
          ...(state.pendingAiCampaignStep ? { pendingAiCampaignStep: undefined, pendingAiCampaignData: undefined } : {}),
        };
      }

      // Generate personalized emails (option 2)
      if (/\b(generat|personali|2)\b/.test(msg)) {
        if (!activeCampaignId) {
          return {
            toolName: undefined,
            toolArgs: {},
            error:    "Please save the recipients to a campaign first before generating personalized emails.",
            intent:   "upload_csv",
          };
        }
        return {
          ...(await startPersonalizeFor(state, { id: activeCampaignId })),
          pendingCsvFile: undefined,
          pendingCsvData: undefined,
        };
      }

      // Unrecognised — re-show options
      const campaignNote = activeCampaignId
        ? `campaign **#${activeCampaignId}**`
        : "the current campaign (no campaign selected yet)";
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          "What would you like to do with this file?",
          "",
          `- **${csvData.validRows}** valid recipients found (${csvData.invalidRows} skipped)`,
          `- Columns: ${csvData.columns.slice(0, 6).join(", ")}${csvData.columns.length > 6 ? "…" : ""}`,
          "",
          `1. **Save recipients** — add them to ${campaignNote}`,
          "2. **Generate personalized emails** — AI drafts a unique email per contact; you'll get a chance to **review samples** before starting the campaign",
          "3. **Review all recipients** — see the complete parsed list before deciding",
          "4. **Discard** — remove this upload and start over",
        ].join("\n"),
        intent: "upload_csv",
      };
    }

    // No file and no parsed data — nothing to process
    this.log.warn({ userId }, "CSV upload: handleCsvUpload called but no pendingCsvFile or pendingCsvData");
    return {
      toolName: undefined,
      toolArgs: {},
      error:    "No CSV file found. Please attach a CSV or XLSX file using the paperclip button.",
    };
  }

  private async validateCampaignRecipients(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    const auth = authFromState(state);
    if (!auth) return { error: "Please sign in again before I check campaign recipients." };
    const allResult = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const allEnvelope = allResult.data as { success?: boolean; data?: unknown } | undefined;
    const all = Array.isArray(allEnvelope?.data) ? allEnvelope.data as Array<Record<string, unknown>> : [];
    const explicitId = state.userMessage.match(/(?:campaign\s*(?:id\s*)?|#)\s*(\d+)\b/i)?.[1];
    let campaign = explicitId ? all.find((c) => String(c.id) === explicitId) : undefined;
    if (!campaign) {
      const matches = campaignsInMessage(state.userMessage, all as never[]);
      if (matches.length === 1) campaign = all.find((c) => String(c.id) === matches[0]!.id);
    }
    if (!campaign) return { error: explicitId ? `I couldn't find campaign #${explicitId}.` : "Which campaign should I check? Include its exact name or ID." };

    const id = String(campaign.id);
    const name = String(campaign.name ?? `Campaign ${id}`);
    const recipientResult = await mcpClientService.dispatch("get_campaign_recipients", { campaignId: id, limit: 100 }, auth);
    const recipientEnvelope = recipientResult.data as { success?: boolean; data?: unknown } | undefined;
    const recipientData = recipientEnvelope?.data as { recipients?: unknown[]; total?: number } | undefined;
    const recipients = Array.isArray(recipientData?.recipients) ? recipientData!.recipients as Array<Record<string, unknown>> : [];
    if (recipientResult.isToolError || recipientEnvelope?.success === false) return { error: `I couldn't load recipients for **${name}** (#${id}). Please try again.` };
    if (!recipients.length) return { formattedResponse: JSON.stringify({ status: "success", intent: "list_campaigns", message: `**${name}** (#${id}) has no recipients to validate.` }) };

    const unique = new Map<string, string>();
    let duplicates = 0;
    for (const row of recipients) {
      const email = String(row.email ?? "").trim();
      const key = email.toLowerCase();
      if (!key) continue;
      if (unique.has(key)) { duplicates++; continue; }
      unique.set(key, email);
    }
    const checked = await Promise.all([...unique.values()].slice(0, 100).map(async (email) => {
      try {
        const r = await mcpClientService.dispatch("validate_email", { email }, auth);
        const env = r.data as { data?: Record<string, unknown> } | undefined;
        const d = env?.data as Record<string, unknown> | undefined;
        return { email, valid: d?.isValid === true, disposable: d?.disposable === true, reason: String(d?.reason ?? "Invalid format") };
      } catch {
        return { email, valid: false, disposable: false, reason: "Could not validate" };
      }
    }));
    const valid = checked.filter((r) => r.valid && !r.disposable).length;
    const invalid = checked.length - valid;
    const lines = checked.map((r) => `- ${r.email}: ${r.valid ? (r.disposable ? "disposable / risky" : "valid") : `invalid (${r.reason})`}`);
    const total = Number(recipientData?.total ?? recipients.length);
    const more = total > checked.length ? `\n\nChecked the first ${checked.length} of ${total} recipients; run again after narrowing the list to validate the rest.` : "";
    const message = `Recipient check for **${name}** (#${id}): ${valid} valid, ${invalid} invalid or risky${duplicates ? `, ${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped` : ""}.\n\n${lines.join("\n")}${more}`;
    return { formattedResponse: JSON.stringify({ status: "success", intent: "list_campaigns", message }) };
  }

}

export const campaignAgent = new CampaignAgent();
