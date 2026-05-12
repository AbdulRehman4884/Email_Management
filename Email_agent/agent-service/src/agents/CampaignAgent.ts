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
  | "show_pending_follow_ups";

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
  const verb =
    action === "pause_campaign"     ? "pause"
    : action === "resume_campaign"  ? "resume"
    : action === "start_campaign"   ? "start"
    : action === "schedule_campaign"? "schedule"
    : action === "show_sequence_progress" ? "check sequence progress for"
    : action === "show_pending_follow_ups" ? "review pending follow-ups for"
    : action === "get_campaign_stats"? "get statistics for"
    : "update";

  const filtered =
    action === "pause_campaign"
      ? list.filter((c) => c.status === "running")
      : action === "resume_campaign"
      ? list.filter((c) => c.status === "paused")
      : list;

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

function matchCampaignSelection(
  userMessage: string,
  list: CampaignEntry[],
): CampaignEntry | undefined {
  const trimmed = userMessage.trim();

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= list.length) {
    return list[num - 1];
  }

  const lower = trimmed.toLowerCase();
  return list.find(
    (c) =>
      c.name.toLowerCase().includes(lower) ||
      lower.includes(c.name.toLowerCase()),
  );
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
  name:    'What would you like to name your campaign? (e.g. "Summer Sale 2024")',
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

function isConfirmation(msg: string): boolean { return CONFIRM_RE.test(msg.trim()); }
function isCancellation(msg: string): boolean { return CANCEL_RE.test(msg.trim()); }

function generateBodyDraft(campaignName: string, subject: string, templateType: string): string {
  const signoff = `Best regards,\nThe ${campaignName} Team`;
  switch (templateType) {
    case "promotional":
      return ["Hi {{name}},", "", "We have an exclusive offer just for you!", "", `**${subject}**`, "", "This offer is available for a limited time only. Don't miss out!", "", "[Shop Now]", "", signoff].join("\n");
    case "newsletter":
      return ["Hi {{name}},", "", "Welcome to our latest update!", "", `**${subject}**`, "", "We have exciting news and updates to share with you this month.", "", "[Read More]", "", signoff].join("\n");
    case "event":
      return ["Hi {{name}},", "", "You're invited!", "", `**${subject}**`, "", "We'd love for you to join us for this special occasion. Please RSVP at your earliest convenience.", "", "[RSVP Now]", "", signoff].join("\n");
    case "announcement":
      return ["Hi {{name}},", "", "We have exciting news to share!", "", `**${subject}**`, "", "We're thrilled to announce this update and wanted you to be among the first to know.", "", "[Learn More]", "", signoff].join("\n");
    case "follow_up":
      return ["Hi {{name}},", "", "We wanted to follow up with you.", "", `**${subject}**`, "", "It's been a while since we last connected, and we'd love to hear from you.", "", "[Get in Touch]", "", signoff].join("\n");
    default:
      return ["Hi {{name}},", "", `**${subject}**`, "", "Thank you for your continued support.", "", signoff].join("\n");
  }
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

// ── update_campaign deterministic extraction ──────────────────────────────────

function tryExtractUpdateArgs(message: string): Record<string, string> {
  const extracted: Record<string, string> = {};

  const idMatch = message.match(/\bcampaign\s+(?:id\s+|#)([A-Za-z0-9_-]+)/i);
  if (idMatch) {
    const v = (idMatch[1] ?? "").trim();
    if (v) extracted.campaignId = v;
  }

  const subjectMatch = message.match(
    /\bsubject(?:\s+to|:)?\s+([^,]+?)(?:\s*,|\s+body\b|\s+name\b|\s+from\b|$)/i,
  );
  if (subjectMatch) {
    const v = (subjectMatch[1] ?? "").trim();
    if (v) extracted.subject = v;
  }

  const nameMatch = message.match(
    /\b(?:rename|name)(?:\s+to|:)?\s+([^,]+?)(?:\s*,|\s+subject\b|\s+body\b|$)/i,
  );
  if (nameMatch) {
    const v = (nameMatch[1] ?? "").trim();
    if (v) extracted.name = v;
  }

  const bodyMatch = message.match(
    /\bbody(?:\s+to|:)?\s+(.+?)(?:\s*,|\s+and\s+then\b|$)/i,
  );
  if (bodyMatch) {
    const v = (bodyMatch[1] ?? "").trim();
    if (v) extracted.body = v;
  }

  return extracted;
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

function buildScheduleDraftResponse(
  campaignId: string,
  campaignName: string | undefined,
  userMessage: string,
): Partial<AgentGraphStateType> {
  const cleaned = extractSchedulingText(userMessage);
  const startText = extractStartText(cleaned);
  const durationText = extractDurationText(cleaned);
  const durationMinutes = durationText
    ? parseDurationMinutes(durationText)
    : parseDurationMinutes(cleaned);

  const draft: Record<string, unknown> = {
    campaignId,
    ...(campaignName ? { campaignName } : {}),
    schedule: {
      startText,
      ...(durationText         ? { durationText }     : {}),
      ...(durationMinutes !== null ? { durationMinutes } : {}),
      timezone: "local",
      status:   "draft_not_saved",
    },
    nextAction: "Backend schedule API integration pending",
  };

  const jsonBlock = JSON.stringify(draft, null, 2);

  return {
    toolName: undefined,
    toolArgs: {},
    error: [
      "This schedule has been prepared as JSON only and has not been saved to backend yet.",
      "",
      "```json",
      jsonBlock,
      "```",
    ].join("\n"),
  };
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
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error:    "Which campaign should I generate personalized emails for? Please provide a campaign ID or use **Create AI campaign** for the guided wizard.",
        };
      }
      return {
        toolName: "generate_personalized_emails",
        toolArgs: { campaignId: activeCampaignId, ...extractGenerationOverrides(state.userMessage) },
      };
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
      if (!activeCampaignId) {
        return {
          toolName: undefined,
          toolArgs: {},
          error:    "Which campaign should I regenerate personalized emails for? Please provide a campaign ID or say **list my campaigns** to see all available campaigns.",
        };
      }
      return {
        toolName: "generate_personalized_emails",
        toolArgs: {
          campaignId: activeCampaignId,
          overwrite: true,
          ...extractGenerationOverrides(state.userMessage),
        },
      };
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
    const explicitId = parseExplicitCampaignId(state.userMessage);
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
    if (!state.pendingCampaignAction && state.campaignSelectionList?.length) {
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

    if (!isCampaignIntent(intent)) {
      // ── Contextual fallback: general/ambiguous intent with active campaign ──
      // The manager routed here because activeCampaignId is set.
      if (activeCampaignId) {
        // If the message contains scheduling information, return a schedule draft
        // rather than the campaign options menu.
        if (hasSchedulingContent(state.userMessage)) {
          const campaignName = state.campaignSelectionList?.find((c) => c.id === activeCampaignId)?.name;
          this.log.info({ userId, activeCampaignId, intent }, "CampaignAgent: schedule draft from contextual scheduling message");
          return buildScheduleDraftResponse(activeCampaignId, campaignName, state.userMessage);
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
      const msg = `CampaignAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
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
      return { toolName: "get_all_campaigns", toolArgs: {} };
    }

    // ── update_campaign ───────────────────────────────────────────────────────
    if (intent === "update_campaign") {
      const campaignId = typeof toolArgs.campaignId === "string" && toolArgs.campaignId.length > 0
        ? toolArgs.campaignId
        : undefined;

      if (campaignId) {
        // CampaignId known — try to extract update fields from the message.
        const fromMessage = tryExtractUpdateArgs(state.userMessage);
        const finalArgs = Object.keys(fromMessage).length > 0
          ? { ...toolArgs, ...fromMessage }
          : toolArgs;
        const hasUpdateField = Object.keys(finalArgs).some((k) => k !== "campaignId");
        if (hasUpdateField) {
          return { toolName: "update_campaign", toolArgs: finalArgs };
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
      // Resolve campaignId from extracted args or active session context
      const campaignId =
        (typeof toolArgs.campaignId === "string" && toolArgs.campaignId.length > 0)
          ? toolArgs.campaignId
          : activeCampaignId;

      if (!campaignId) {
        // No campaignId — show campaign list for selection.
        // Preserve the original scheduling text so buildScheduleDraftResponse
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

      // Build schedule draft JSON — backend API integration pending
      const campaignName = state.campaignSelectionList?.find((c) => c.id === campaignId)?.name;
      this.log.info({ userId, campaignId }, "CampaignAgent: building schedule draft (no backend call)");
      return buildScheduleDraftResponse(campaignId, campaignName, state.userMessage);
    }

    // ── create_campaign wizard ────────────────────────────────────────────────
    if (intent === "create_campaign") {
      return this.handleCreateCampaign(state, toolArgs as Record<string, string>);
    }

    // ── start / pause / resume / analytics — require campaignId ──────────────
    if (isCampaignActionIntent(intent)) {
      return this.handleCampaignActionWithId(state, intent, toolArgs);
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

  private handleCampaignSelection(
    state: AgentGraphStateType,
  ): Partial<AgentGraphStateType> {
    const { userId } = state;
    const rawList = state.campaignSelectionList!;
    const action  = state.pendingCampaignAction!;

    // Build the effective filtered list (same filter as the display)
    const list =
      action === "pause_campaign"
        ? rawList.filter((c) => c.status === "running")
        : action === "resume_campaign"
        ? rawList.filter((c) => c.status === "paused")
        : rawList;

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

    const match = matchCampaignSelection(state.userMessage, list.length > 0 ? list : rawList);

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
          pendingCampaignAction: undefined,
          campaignSelectionList: undefined,
        };
      }

      // ── schedule: build draft JSON — backend API integration pending ─────────
      if (action === "schedule_campaign") {
        // Use the stored scheduling text (from the original request) if available,
        // otherwise fall back to the current user message (the selection reply).
        const schedulingText = state.pendingScheduledAt ?? state.userMessage;
        this.log.info({ userId, campaignId: match.id }, "CampaignAgent: building schedule draft after selection");
        return {
          ...buildScheduleDraftResponse(match.id, match.name, schedulingText),
          intent:                "schedule_campaign",
          pendingCampaignAction: undefined,
          campaignSelectionList: undefined,
          pendingScheduledAt:    undefined,
        };
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

      // ── start / pause / resume ─────────────────────────────────────────────
      const toolName = TOOL_MAP[action as keyof typeof TOOL_MAP] as KnownToolName;
      return {
        toolName,
        toolArgs:              { campaignId: match.id },
        intent:                action,
        pendingCampaignAction: undefined,
        campaignSelectionList: undefined,
      };
    }

    // Unclear response — re-present the list
    const msg = formatCampaignSelectionList(rawList, action);
    this.log.debug({ userId, action }, "Campaign selection unclear — re-presenting list");
    return {
      toolName:              undefined,
      toolArgs:              {},
      error:                 `I didn't catch that.\n\n${msg}`,
      pendingCampaignAction: action,
      campaignSelectionList: rawList,
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

    if (hasAllCreateCampaignFields(partial)) {
      this.log.info({ userId }, "create_campaign: all fields present — dispatching directly");
      return { toolName: "create_campaign", toolArgs: partial };
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
        return {
          toolName:             "create_campaign",
          toolArgs:             draft,
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
      const edits = Object.fromEntries(
        Object.entries({ ...editsFromMsg, ...editsFromLLM }).filter(
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

  private handleUpdateWizard(
    state: AgentGraphStateType,
    draft: Record<string, string>,
    step: string | undefined,
  ): Partial<AgentGraphStateType> {
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
      const newValue = state.userMessage.trim();
      this.log.info({ userId, campaignId, field, newValue: newValue.slice(0, 50) }, "update_campaign: dispatching");
      return {
        toolName:             "update_campaign",
        toolArgs:             { campaignId, [field]: newValue },
        pendingCampaignDraft: undefined,
        pendingCampaignStep:  undefined,
        intent:               "update_campaign",
        error:                undefined,
        // Temporary clarification message — will be overwritten by finalResponse on success
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
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
        "Example: *\"Summer Sale 2024\"*, *\"Monthly Newsletter\"*, *\"Product Launch\"*",
      ].join("\n"),
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      intent:                "create_ai_campaign",
    };
  }

  private handleAiWizardContinuation(
    state: AgentGraphStateType,
  ): Partial<AgentGraphStateType> {
    const { userId, activeCampaignId } = state;
    const step = state.pendingAiCampaignStep!;
    const data = state.pendingAiCampaignData ?? {};
    const msg  = state.userMessage.trim();

    if (isCancellation(msg)) {
      this.log.info({ userId, step }, "AI wizard cancelled");
      return {
        toolName:              undefined,
        toolArgs:              {},
        error:                 "AI campaign wizard cancelled. Your campaign draft is still saved — let me know when you'd like to continue.",
        pendingAiCampaignStep: undefined,
        pendingAiCampaignData: undefined,
        intent:                "create_ai_campaign",
      };
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
      const updatedData = { ...data, campaignName: msg };
      this.log.info({ userId, campaignName: msg }, "AI wizard: campaign name set");
      return {
        toolName:              undefined,
        toolArgs:              {},
        error: [
          `**"${msg}"** — great name!`,
          "",
          "**Step 2 of 6 — Subject line**",
          "What should the email subject line say?",
          "",
          "Example: *\"Exclusive 30% off — this weekend only\"*, *\"Your November newsletter is here\"*",
        ].join("\n"),
        pendingAiCampaignStep: "campaign_subject",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: campaign_subject — collect subject, advance to template selection ─
    if (step === "campaign_subject") {
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
      const updatedData = { ...data, subject: msg };
      this.log.info({ userId, subject: msg }, "AI wizard: subject set — advancing to template selection");
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          `Subject set: **"${msg}"**`,
          "",
          "**Step 3 — Template type**",
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
          error:                 "Please choose a template type by replying **1–5** or the name (e.g. \"promotional\").",
          pendingAiCampaignStep: "template_selection",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      const campaignName = data.campaignName ?? "New Campaign";
      const subject      = data.subject ?? "";
      const bodyDraft    = generateBodyDraft(campaignName, subject, templateType);
      const updatedData  = { ...data, templateType, body: bodyDraft };
      this.log.info({ userId, templateType }, "AI wizard: template selected — showing body draft");
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          `**${templateType.charAt(0).toUpperCase() + templateType.slice(1).replace(/_/g, "-")}** template selected.`,
          "",
          "**Step 4 — Email body**",
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

    // ── Step: campaign_body — confirm/edit body, then create campaign ─────────
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
        this.log.info({ userId, campaignName, subject }, "AI wizard: body confirmed — creating campaign");
        return {
          toolName: "create_campaign",
          toolArgs: { name: campaignName, subject, body },
          pendingAiCampaignStep: "recipient_source",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      // User wants to edit the body
      const updatedData = { ...data, body: msg };
      return {
        toolName: undefined,
        toolArgs: {},
        error: [
          "Got it — here's your updated email body:",
          "",
          "---",
          msg,
          "---",
          "",
          "Reply **confirm** to proceed, or describe more changes.",
        ].join("\n"),
        pendingAiCampaignStep: "campaign_body",
        pendingAiCampaignData: updatedData,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: recipient_source — user has uploaded CSV via web UI, verify count ─
    if (step === "recipient_source") {
      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "I lost track of your campaign. Please restart the AI wizard.",
          pendingAiCampaignStep: "recipient_source",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      this.log.info({ userId, activeCampaignId }, "AI wizard: recipient_source — verifying upload count");
      return {
        toolName:              "get_recipient_count",
        toolArgs:              { campaignId: activeCampaignId },
        pendingAiCampaignStep: "check_count",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: upload_recipients — wait for CSV, fetch count ───────────────────
    if (step === "upload_recipients") {
      if (!activeCampaignId) {
        return {
          toolName:              undefined,
          toolArgs:              {},
          error:                 "I lost the active campaign reference. Please say the campaign ID to continue.",
          pendingAiCampaignStep: "upload_recipients",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
      this.log.info({ userId, activeCampaignId }, "AI wizard: upload confirmed, fetching count");
      return {
        toolName:              "get_recipient_count",
        toolArgs:              { campaignId: activeCampaignId },
        pendingAiCampaignStep: "check_count",
        pendingAiCampaignData: data,
        intent:                "create_ai_campaign",
      };
    }

    // ── Step: check_count — validate recipients, advance to template ──────────
    if (step === "check_count") {
      const count = parseInt(data.recipientCount ?? "0", 10);
      if (!data.recipientCount || count === 0) {
        this.log.warn({ userId, activeCampaignId }, "AI wizard: no recipients — returning to upload");
        return {
          toolName:              undefined,
          toolArgs:              {},
          error: [
            "No recipients found for this campaign yet.",
            "",
            "Please go to the **Campaigns** section in the web UI, open this campaign, and upload your recipient CSV or Excel file.",
            "Your file needs at least an **email** column. Extra columns (name, company, role, etc.) will be used to personalize each email.",
            "",
            "Once uploaded, come back and say **done** — I'll re-check the count.",
          ].join("\n"),
          pendingAiCampaignStep: "upload_recipients",
          pendingAiCampaignData: data,
          intent:                "create_ai_campaign",
        };
      }
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
      this.log.info({ userId, activeCampaignId, count }, "AI wizard: recipients validated, proceeding to tone");
      return {
        toolName:              undefined,
        toolArgs:              {},
        error: [
          `Great! Found **${count}** recipient${count !== 1 ? "s" : ""} ready for personalization.`,
          "",
          "**Step 5 — Tone & style**",
          "How should the emails sound? Describe the tone you want, or say **skip** to use a professional default.",
          "",
          "Examples: *\"friendly and casual\"*, *\"formal and authoritative\"*, *\"urgent and exciting\"*",
        ].join("\n"),
        pendingAiCampaignStep: "tone",
        pendingAiCampaignData: { ...data, recipientCount: String(count) },
        intent:                "create_ai_campaign",
      };
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

  private handleCsvUpload(
    state: AgentGraphStateType,
  ): Partial<AgentGraphStateType> {
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

      // Discard
      if (/\b(discard|cancel|no|skip|remove|delete)\b/.test(msg)) {
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
          toolName:       "generate_personalized_emails",
          toolArgs:       { campaignId: activeCampaignId },
          pendingCsvFile: undefined,
          pendingCsvData: undefined,
          intent:         "generate_personalized_emails",
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
          "2. **Generate personalized emails** — use AI to craft individual emails per contact",
          "3. **Discard** — remove this upload and start over",
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

}

export const campaignAgent = new CampaignAgent();
