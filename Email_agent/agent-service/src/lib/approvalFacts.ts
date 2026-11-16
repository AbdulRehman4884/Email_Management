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
  /** Pausing sends nothing, so no "0 recipients" warning. */
  pausing?: boolean;
  status?: string;
  /** start_campaign / pause_campaign / resume_campaign */
  action?: string;
}

const CAMPAIGN_ACTION_INTENTS = new Set(["start_campaign", "resume_campaign", "pause_campaign"]);

export async function campaignApprovalFacts(state: {
  intent?: string | undefined;
  toolArgs?: Record<string, unknown> | undefined;
  rawToken?: string | undefined;
  userId?: unknown;
}): Promise<ApprovalFacts | undefined> {
  const campaignId = state.toolArgs?.campaignId;
  const auth = authFromState(state);
  if (!state.intent || !CAMPAIGN_ACTION_INTENTS.has(state.intent) || !auth) return undefined;
  if (typeof campaignId !== "string" && typeof campaignId !== "number") return undefined;
  const facts: ApprovalFacts = { campaignId: String(campaignId), action: state.intent, ...(state.intent === "pause_campaign" ? { pausing: true } : {}) };

  try {
    const result = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = result.data as { success?: boolean; data?: unknown } | undefined;
    if (result.isToolError || env?.success === false) return facts;
    const list = Array.isArray(env?.data) ? (env.data as Array<Record<string, unknown>>) : [];
    const hit = list.find((c) => String(c.id) === facts.campaignId);
    if (typeof hit?.name === "string" && hit.name) facts.name = hit.name;
    if (typeof hit?.status === "string") facts.status = hit.status.toLowerCase() === "in_progress" ? "running" : hit.status.toLowerCase();
    const count = hit?.recipientCount ?? hit?.recieptCount;
    if (typeof count === "number") facts.recipients = count;
  } catch {
    // Card still shows the campaign id.
  }
  return facts;
}

/** The lines shown on the approval card, e.g. "**Campaign:** BM AI Services (#20)". */
export function approvalFactLines(facts: ApprovalFacts | undefined): string[] {
  if (!facts) return [];
  const lines = [`**Campaign:** ${facts.name ? `${facts.name} (#${facts.campaignId})` : `#${facts.campaignId}`}`];
  if (facts.recipients !== undefined && !facts.pausing) {
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
