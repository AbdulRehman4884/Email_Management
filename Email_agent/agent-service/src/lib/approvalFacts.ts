/**
 * src/lib/approvalFacts.ts
 *
 * What the user needs to see before confirming a campaign start/resume/pause (bugs A-13, A-14):
 * which campaign it is and how many recipients it has. Read from get_all_campaigns;
 * if that fails the card simply leaves the facts out.
 */

import { mcpClientService } from "../services/mcpClient.service.js";
import { authFromState } from "./campaignLookup.js";

export interface ApprovalFacts {
  campaignId: string;
  name?: string;
  recipients?: number;
  remaining?: number;
  pauseReason?: string;
  dailySendLimit?: number;
  /** Pausing sends nothing, so no "0 recipients" warning. */
  pausing?: boolean;
  status?: string;
  /** start_campaign / pause_campaign / resume_campaign / update_campaign / schedule_campaign / delete_campaign */
  action?: string;
  /** update_campaign / schedule_campaign: the lines saying what changes (old → new, send time). */
  changes?: string[];
}

const CAMPAIGN_ACTION_INTENTS = new Set(["start_campaign", "resume_campaign", "pause_campaign", "update_campaign", "schedule_campaign", "delete_campaign"]);

const short = (s: string, n = 300) => {
  const t = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>\s*<p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&#123;/g, "{").replace(/&#125;/g, "}").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** What an update / schedule changes, in plain words: "**Subject:** Hello C → **Hello C updated**". */
function changeLines(intent: string, args: Record<string, unknown>, hit: Record<string, unknown> | undefined, timeZone?: string): string[] {
  const lines: string[] = [];
  if (intent === "schedule_campaign" && typeof args.scheduledAt === "string") {
    const d = new Date(args.scheduledAt);
    const shown = Number.isNaN(d.getTime()) ? args.scheduledAt
      : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(d);
    lines.push(`**Send at:** ${shown}${timeZone ? ` (${timeZone})` : ""}`);
  }
  if (intent === "update_campaign") {
    const old = (k: string) => (typeof hit?.[k] === "string" ? (hit[k] as string) : "");
    if (typeof args.subject === "string") lines.push(`**Subject:** ${old("subject") ? `${old("subject")} → ` : ""}**${args.subject}**`);
    if (typeof args.name === "string") lines.push(`**Name:** ${old("name") ? `${old("name")} → ` : ""}**${args.name}**`);
    if (typeof args.body === "string") lines.push("**New email text:**", "", short(args.body, 600));
    if (typeof args.smtpSettingsId === "number") lines.push(`**Sender:** switches to email account #${args.smtpSettingsId}${old("fromEmail") ? ` (now ${old("fromEmail")})` : ""}`);
  }
  return lines;
}

export async function campaignApprovalFacts(state: {
  intent?: string | undefined;
  toolArgs?: Record<string, unknown> | undefined;
  rawToken?: string | undefined;
  userId?: unknown;
  clientTimezone?: string | undefined;
}): Promise<ApprovalFacts | undefined> {
  const campaignId = state.toolArgs?.campaignId;
  const auth = authFromState(state);
  if (!state.intent || !CAMPAIGN_ACTION_INTENTS.has(state.intent)) return undefined;
  if (typeof campaignId !== "string" && typeof campaignId !== "number") return undefined;
  const facts: ApprovalFacts = { campaignId: String(campaignId), action: state.intent, ...(state.intent === "pause_campaign" ? { pausing: true } : {}) };

  try {
    if (!auth) throw new Error("no auth"); // the card still says what changes
    const result = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = result.data as { success?: boolean; data?: unknown } | undefined;
    if (result.isToolError || env?.success === false) return facts;
    const list = Array.isArray(env?.data) ? (env.data as Array<Record<string, unknown>>) : [];
    const hit = list.find((c) => String(c.id) === facts.campaignId);
    if (typeof hit?.name === "string" && hit.name) facts.name = hit.name;
    if (typeof hit?.status === "string") facts.status = hit.status.toLowerCase() === "in_progress" ? "running" : hit.status.toLowerCase();
    const count = hit?.recipientCount ?? hit?.recieptCount;
    if (typeof count === "number") facts.recipients = count;
    if (typeof hit?.pauseReason === "string") facts.pauseReason = hit.pauseReason;
    if (typeof hit?.dailySendLimit === "number") facts.dailySendLimit = hit.dailySendLimit;
    if (state.intent === "resume_campaign") {
      try {
        const recipientResult = await mcpClientService.dispatch("get_campaign_recipients", { campaignId: facts.campaignId, limit: 1000 }, auth);
        const recipientEnvelope = recipientResult.data as { success?: boolean; data?: { recipients?: unknown[]; total?: number } } | undefined;
        const rows = Array.isArray(recipientEnvelope?.data?.recipients) ? recipientEnvelope!.data!.recipients as Array<Record<string, unknown>> : [];
        if (!recipientResult.isToolError && recipientEnvelope?.success !== false) {
          facts.remaining = rows.filter((r) => String(r.status).toLowerCase() === "pending").length;
          facts.recipients = Number(recipientEnvelope?.data?.total ?? rows.length);
        }
      } catch { /* Keep the campaign-level facts if recipient details are unavailable. */ }
    }
    const changes = changeLines(state.intent, state.toolArgs ?? {}, hit, state.clientTimezone);
    if (changes.length) facts.changes = changes;
  } catch {
    // Card still shows the campaign id.
  }
  if (!facts.changes) {
    const changes = changeLines(state.intent, state.toolArgs ?? {}, undefined, state.clientTimezone);
    if (changes.length) facts.changes = changes;
  }
  return facts;
}

/** The lines shown on the approval card, e.g. "**Campaign:** BM AI Services (#20)". */
export function approvalFactLines(facts: ApprovalFacts | undefined): string[] {
  if (!facts) return [];
  const lines = [`**Campaign:** ${facts.name ? `${facts.name} (#${facts.campaignId})` : `#${facts.campaignId}`}`];
  if (facts.changes?.length) lines.push(...facts.changes);
  if (facts.action === "delete_campaign") {
    lines.push("", `⚠️ This deletes the campaign${facts.recipients ? ` and its **${facts.recipients}** recipients` : ""}, with its replies and stats. It cannot be undone.`);
    return lines;
  }
  if (facts.action === "resume_campaign") {
    if (facts.remaining !== undefined) {
      lines.push(`**Recipients to send now:** ${facts.remaining}${facts.recipients !== undefined ? ` of ${facts.recipients}` : ""}`);
      if (facts.remaining === 0) lines.push("", "⚠️ No recipients remain to send.");
    }
    const reasons: Record<string, string> = {
      daily_campaign_cap: `It paused after reaching its daily campaign limit${facts.dailySendLimit ? ` of ${facts.dailySendLimit}` : ""}.` +
        (facts.remaining ? ` It sends at most ${facts.dailySendLimit ?? "that many"} a day, so it may pause again today.` : ""),
      smtp_daily_limit: "It paused because its SMTP account reached the daily send limit.",
      send_window_closed: "It paused because the sending window closed.",
      weekday_filter: "It paused because today is not an allowed sending day.",
    };
    if (facts.pauseReason && reasons[facts.pauseReason]) lines.push(reasons[facts.pauseReason]!);
  }
  // Only start / resume send mail; an edit or a schedule shows no recipient warning here.
  if (facts.action === "update_campaign" || facts.action === "schedule_campaign") return lines;
  // A resume card already says "Recipients to send now: X of Y" (QA P3 bug 44: "Recipients: 2" alone was misleading).
  if (facts.recipients !== undefined && !facts.pausing && !(facts.action === "resume_campaign" && facts.remaining !== undefined)) {
    lines.push(`**Recipients:** ${facts.recipients}`);
    if (facts.recipients === 0) {
      lines.push("", "⚠️ This campaign has no recipients, so nothing would be sent. Add recipients first.");
    }
  }
  const wrong = wrongStatusWarning(facts);
  if (wrong) lines.push("", wrong);
  return lines;
}

/** "pause campaign id 17" when #17 is already paused — say so on the card. */
function wrongStatusWarning(facts: ApprovalFacts): string | undefined {
  const s = facts.status;
  if (!s) return undefined;
  if (facts.action === "pause_campaign" && s !== "running") return `⚠️ This campaign is **${s}**, not running, so there is nothing to pause.`;
  if (facts.action === "resume_campaign" && s !== "paused") return `⚠️ This campaign is **${s}**, not paused, so it can't be resumed.`;
  if (facts.action === "start_campaign" && (s === "running" || s === "completed")) return `⚠️ This campaign is already **${s}**.`;
  return undefined;
}
