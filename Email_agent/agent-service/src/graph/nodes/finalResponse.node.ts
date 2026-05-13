/**
 * src/graph/nodes/finalResponse.node.ts
 *
 * Final node in the agent graph — shapes the result returned to the caller.
 *
 * Two-phase response construction:
 *
 *   Phase 1 — Deterministic (buildResponse):
 *     Always runs. Produces a well-formed response for every possible graph
 *     state. This is the guaranteed fallback; it never throws.
 *
 *   Phase 2 — OpenAI enhancement (maybeEnhanceWithOpenAI):
 *     Runs only when OPENAI_API_KEY is configured and the state is suitable.
 *     Two enhancement modes:
 *
 *     a) summarize_replies + toolResult
 *        OpenAI transforms raw MCP reply data into a prose summary.
 *        (OpenAI makes NO API or MCP calls — it only receives the data.)
 *
 *     b) Other intents with a successful toolResult (get_campaign_stats,
 *        list_replies) — OpenAI rewrites the deterministic response into
 *        more natural language while preserving all factual content.
 *
 *     Any OpenAI failure silently falls back to the Phase 1 response.
 *     Error states, approval gates, and general_help are never enhanced.
 *
 * Priority order inside buildResponse:
 *   1. Error state         → user-safe error message
 *   2. Approval required   → confirmation prompt (with prior plan results if any)
 *   3. general_help / no tool → capability overview
 *   4. Multi-step plan complete → step-by-step result summary
 *   5. Tool error result   → error detail from MCP
 *   6. Successful result   → raw data (OpenAI may enhance in Phase 2)
 *   7. Phase 4 placeholder → acknowledgement
 */

import { createLogger } from "../../lib/logger.js";
import { getOpenAIService } from "../../services/openai.service.js";
import { toUserSafeMcpMessage } from "../../lib/mcpErrorMapping.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlanStepResult } from "../../lib/planTypes.js";

const log = createLogger("node:finalResponse");

const PHASE3_INTENTS = new Set<string>([
  "analyze_company",
  "detect_pain_points",
  "generate_outreach",
  "enrich_company",
]);

// ── Intents that benefit from OpenAI response enhancement ────────────────────

/**
 * Intents whose raw tool results are data-dense enough to benefit from
 * OpenAI's natural-language rewrite. Action-confirmation intents
 * (start_campaign, pause_campaign, etc.) are excluded — their deterministic
 * responses are already concise and correct.
 */
const ENHANCE_INTENTS = new Set<string>(["get_campaign_stats", "list_replies"]);

// ── Out-of-domain refusal ────────────────────────────────────────────────────

const OUT_OF_DOMAIN_REFUSAL =
  "I'm sorry, I can only help with MailFlow platform tasks — campaigns, " +
  "AI-assisted campaign creation, email analytics, inbox management, and SMTP settings.\n\n" +
  "Is there something campaign-related I can help you with?";

// ── Help text ─────────────────────────────────────────────────────────────────

const CAPABILITIES = `
Here's what I can help you with:

**AI Campaigns**
- Create an AI-assisted campaign (guided step-by-step)
- Upload recipient CSV or Excel file
- Validate recipients before sending
- Select a campaign template (promotional, newsletter, event, announcement, follow-up)
- Set tone and custom instructions for email content
- Generate personalized emails from recipient CSV fields
- Schedule campaign with date and time
- Review and approve before launch

**Campaigns**
- Create a new email campaign
- Update an existing campaign
- Start / launch a campaign
- Pause a running campaign
- Resume a paused campaign

**Analytics**
- Get campaign statistics (open rate, click rate, bounces)

**Inbox**
- List replies from recipients
- Summarise replies

**Settings**
- Check SMTP configuration
- Update SMTP settings (via Settings → SMTP Configuration)

Just describe what you'd like to do in plain English.
`.trim();

// ── Broad-help detector — only these trigger the full capabilities card ───────

/**
 * Matches messages that are explicitly asking for a broad overview of what the
 * agent can do. Everything else gets a contextual clarification instead of
 * the full capabilities card.
 */
const EXPLICIT_HELP_RE =
  /^\s*(help|hi|hey|hello)\s*$|\b(what can you do|what can you help|capabilities|what are your features|what do you do|how does this work|getting started|tutorial)\b/i;

// ── Intent labels ─────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, string> = {
  list_campaigns:                   "list all campaigns",
  create_campaign:                  "create a new campaign",
  create_ai_campaign:               "create an AI-assisted campaign",
  update_campaign:                  "update the campaign",
  schedule_campaign:                "schedule the campaign",
  start_campaign:                   "start the campaign",
  pause_campaign:                   "pause the campaign",
  resume_campaign:                  "resume the campaign",
  get_campaign_stats:               "retrieve campaign statistics",
  show_sequence_progress:           "show sequence progress",
  show_pending_follow_ups:          "show pending follow-ups",
  show_recipient_touch_history:     "show recipient touch history",
  mark_recipient_replied:           "mark a recipient as replied",
  mark_recipient_bounced:           "mark a recipient as bounced",
  generate_personalized_emails:     "generate personalized emails",
  regenerate_personalized_emails:   "regenerate personalized emails",
  list_replies:                     "list campaign replies",
  summarize_replies:                "summarise campaign replies",
  check_smtp:                       "retrieve SMTP settings",
  update_smtp:                      "update SMTP settings",
  general_help:                     "help",
  template_help:                    "show available templates",
  upload_recipients_help:           "explain recipient upload",
  next_step_help:                   "suggest next steps",
  ai_campaign_help:                 "explain AI campaign creation",
  recipient_status_help:            "check recipient status",
};

// ── Success message labels ────────────────────────────────────────────────────

const SUCCESS_LABELS: Record<string, string> = {
  list_campaigns:     "Campaigns retrieved.",
  create_campaign:    "Campaign created successfully.",
  update_campaign:    "Campaign updated successfully.",
  schedule_campaign:  "Campaign scheduled successfully.",
  start_campaign:     "Campaign started successfully.",
  pause_campaign:     "Campaign paused successfully.",
  resume_campaign:    "Campaign resumed successfully.",
  get_campaign_stats: "Campaign statistics retrieved.",
  show_sequence_progress: "Sequence progress retrieved.",
  show_pending_follow_ups: "Pending follow-ups retrieved.",
  show_recipient_touch_history: "Recipient touch history retrieved.",
  mark_recipient_replied: "Recipient marked as replied.",
  mark_recipient_bounced: "Recipient marked as bounced.",
  list_replies:       "Replies retrieved.",
  summarize_replies:  "Reply summary complete.",
  check_smtp:         "SMTP settings retrieved.",
  update_smtp:        "SMTP settings updated successfully.",
};

function buildSuccessMessage(intent: string | undefined): string {
  const key = intent ?? "";
  return (
    SUCCESS_LABELS[key] ??
    `${(key || "action").replace(/_/g, " ")} completed successfully.`
  );
}

// ── Data-aware message formatters ─────────────────────────────────────────────

function unwrapMcpData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const d = raw as Record<string, unknown>;
  if (d.data && typeof d.data === "object" && !Array.isArray(d.data)) {
    return d.data as Record<string, unknown>;
  }
  return d;
}

/** Human-readable campaign target for save summaries (name + id when available). */
function formatSaveDestinationLine(
  state: AgentGraphStateType,
  campaignId: string | undefined,
): string {
  const id = typeof campaignId === "string" ? campaignId.trim() : "";
  if (!id) return "your campaign";
  const hit = state.campaignSelectionList?.find((c) => String(c.id) === id);
  if (hit?.name) return `**${hit.name}** (campaign #${id})`;
  return `campaign **#${id}**`;
}

function formatStatsMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const sent      = typeof d.sent      === "number" ? d.sent      : 0;
  const delivered = typeof d.delivered === "number" ? d.delivered : undefined;
  const opened    = typeof d.opened    === "number" ? d.opened    : 0;
  const clicked   = typeof d.clicked   === "number" ? d.clicked   : undefined;
  const bounced   = typeof d.bounced   === "number" ? d.bounced   : undefined;
  const openRate  = typeof d.openRate  === "number" ? (d.openRate  * 100).toFixed(1) : null;
  const clickRate = typeof d.clickRate === "number" ? (d.clickRate * 100).toFixed(1) : null;
  const bounceRate = typeof d.bounceRate === "number" ? (d.bounceRate * 100).toFixed(1) : null;

  const lines: string[] = [`**Sent:** ${sent.toLocaleString()}`];
  if (delivered !== undefined) lines.push(`**Delivered:** ${delivered.toLocaleString()}`);
  lines.push(`**Opened:** ${opened.toLocaleString()}${openRate ? ` (${openRate}%)` : ""}`);
  if (clicked !== undefined) lines.push(`**Clicked:** ${clicked.toLocaleString()}${clickRate ? ` (${clickRate}%)` : ""}`);
  if (bounced  !== undefined) lines.push(`**Bounced:** ${bounced.toLocaleString()}${bounceRate ? ` (${bounceRate}%)` : ""}`);

  const sequence = d.sequence && typeof d.sequence === "object"
    ? (d.sequence as Record<string, unknown>)
    : null;
  if (sequence) {
    const pendingFollowUps = typeof sequence.pendingFollowUps === "number" ? sequence.pendingFollowUps : 0;
    const dueFollowUps = typeof sequence.dueFollowUps === "number" ? sequence.dueFollowUps : 0;
    const completionRate = typeof sequence.completionRate === "number" ? `${(sequence.completionRate * 100).toFixed(1)}%` : null;
    lines.push(
      "",
      "**Sequence:**",
      `**Pending follow-ups:** ${pendingFollowUps.toLocaleString()}`,
      `**Due now:** ${dueFollowUps.toLocaleString()}`,
      ...(completionRate ? [`**Completion rate:** ${completionRate}`] : []),
    );
  }

  return `Here are the campaign statistics:\n\n${lines.join("\n")}`;
}

function formatSequenceProgressMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const touchPerformance = Array.isArray(d.touchPerformance)
    ? (d.touchPerformance as Array<Record<string, unknown>>)
    : [];
  const lines = [
    "**Recipient Progress:**",
    `- **Active:** ${typeof d.activeRecipients === "number" ? d.activeRecipients : 0}`,
    `- **Pending follow-ups:** ${typeof d.pendingFollowUps === "number" ? d.pendingFollowUps : 0}`,
    `- **Due now:** ${typeof d.dueFollowUps === "number" ? d.dueFollowUps : 0}`,
    `- **Completed:** ${typeof d.completedRecipients === "number" ? d.completedRecipients : 0}`,
    `- **Replied:** ${typeof d.repliedRecipients === "number" ? d.repliedRecipients : 0}`,
    `- **Bounced:** ${typeof d.bouncedRecipients === "number" ? d.bouncedRecipients : 0}`,
    `- **Unsubscribed:** ${typeof d.unsubscribedRecipients === "number" ? d.unsubscribedRecipients : 0}`,
  ];
  if (touchPerformance.length > 0) {
    lines.push("", "**Touch Performance:**");
    for (const touch of touchPerformance.slice(0, 4)) {
      const touchNumber = typeof touch.touchNumber === "number" ? touch.touchNumber : 0;
      const sent = typeof touch.sent === "number" ? touch.sent : 0;
      const planned = typeof touch.planned === "number" ? touch.planned : 0;
      lines.push(`- **Touch ${touchNumber}:** ${sent}/${planned} sent`);
    }
  }
  return lines.join("\n");
}

function formatPendingFollowUpsMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
  if (items.length === 0) {
    return "No pending follow-ups are scheduled right now.";
  }
  const lines = [
    `Here are the next **${items.length}** pending follow-up${items.length !== 1 ? "s" : ""}:`,
    "",
  ];
  for (const item of items.slice(0, 10)) {
    const email = typeof item.email === "string" ? item.email : "unknown";
    const touch = typeof item.nextTouchNumber === "number" ? item.nextTouchNumber : "?";
    const nextAt = typeof item.nextScheduledTouchAt === "string" ? new Date(item.nextScheduledTouchAt).toLocaleString() : "not scheduled";
    const objective = typeof item.touchObjective === "string" ? item.touchObjective : "follow-up";
    lines.push(`- **${email}** — touch ${touch}, ${objective}, scheduled ${nextAt}`);
  }
  return lines.join("\n");
}

function formatRecipientTouchHistoryMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const touches = Array.isArray(d.touches) ? (d.touches as Array<Record<string, unknown>>) : [];
  const recipientEmail = typeof d.recipientEmail === "string" ? d.recipientEmail : "this recipient";
  if (touches.length === 0) {
    return `No touch history found for **${recipientEmail}**.`;
  }
  const lines = [`Touch history for **${recipientEmail}**:`, ""];
  for (const touch of touches.slice(0, 6)) {
    const touchNumber = typeof touch.touchNumber === "number" ? touch.touchNumber : 0;
    const status = typeof touch.executionStatus === "string" ? touch.executionStatus : "unknown";
    const subject = typeof touch.personalizedSubject === "string" ? touch.personalizedSubject : "Subject unavailable";
    const sentAt = typeof touch.sentAt === "string" ? ` — sent ${new Date(touch.sentAt).toLocaleString()}` : "";
    lines.push(`- **Touch ${touchNumber}:** ${status}${sentAt}\n  ${subject}`);
  }
  return lines.join("\n");
}

function formatRepliesMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "No replies found.";
  const d = data as Record<string, unknown>;
  const items: Array<Record<string, unknown>> = Array.isArray(d.items)
    ? (d.items as Array<Record<string, unknown>>)
    : Array.isArray(d.data)
    ? (d.data as Array<Record<string, unknown>>)
    : [];
  const total = typeof d.total === "number" ? d.total : items.length;

  if (total === 0 || items.length === 0) return "No replies found for this campaign.";

  const lines = items.slice(0, 10).map((item, i) => {
    const sender: string =
      typeof item.sender    === "string" ? item.sender    :
      typeof item.fromEmail === "string" ? item.fromEmail : "Unknown";
    const preview: string =
      typeof item.preview === "string" ? item.preview :
      typeof item.body    === "string" ? item.body.slice(0, 80) : "";
    const raw = item.receivedAt ?? item.timestamp ?? item.created_at;
    const dateStr = typeof raw === "string"
      ? new Date(raw).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    const meta = [sender, dateStr].filter(Boolean).join(" · ");
    return `${i + 1}. **${meta}**${preview ? `\n   ${preview}` : ""}`;
  });

  const heading = total > items.length
    ? `Showing ${items.length} of ${total} replies:`
    : `${total} ${total === 1 ? "reply" : "replies"}:`;

  return `${heading}\n\n${lines.join("\n\n")}`;
}

function formatReplyLeadListMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const leads = Array.isArray(d.leads) ? d.leads as Array<Record<string, unknown>> : [];
  const total = typeof d.total === "number" ? d.total : leads.length;
  if (total === 0 || leads.length === 0) return "No hot or meeting-ready leads found yet.";
  const lines = leads.slice(0, 10).map((lead, index) => {
    const email = typeof lead.recipientEmail === "string" ? lead.recipientEmail : "unknown lead";
    const score = typeof lead.hotLeadScore === "number" ? `Score ${lead.hotLeadScore}` : "Score unavailable";
    const temp = typeof lead.leadTemperature === "string" ? lead.leadTemperature.replace(/_/g, " ") : "lead";
    const summary = typeof lead.replySummary === "string" && lead.replySummary ? `\n   ${lead.replySummary}` : "";
    return `${index + 1}. **${email}** — ${temp}, ${score}${summary}`;
  });
  return `Found ${total} lead${total === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`;
}

function formatReplyIntelligenceSummaryMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const total = typeof d.totalReplies === "number" ? d.totalReplies : 0;
  const positiveRate = typeof d.positiveReplyRate === "number" ? `${(d.positiveReplyRate * 100).toFixed(1)}%` : "0.0%";
  const meetingReady = typeof d.meetingReadyCount === "number" ? d.meetingReadyCount : 0;
  const objections = d.objectionBreakdown && typeof d.objectionBreakdown === "object"
    ? Object.entries(d.objectionBreakdown as Record<string, number>).map(([k, v]) => `${k}: ${v}`).join(", ")
    : "none";
  return [
    `Reply intelligence summary for ${total} repl${total === 1 ? "y" : "ies"}:`,
    "",
    `- Positive reply rate: ${positiveRate}`,
    `- Meeting-ready leads: ${meetingReady}`,
    `- Unsubscribes: ${typeof d.unsubscribeCount === "number" ? d.unsubscribeCount : 0}`,
    `- Objections: ${objections || "none"}`,
    `- Hottest lead score: ${typeof d.hottestLeadScore === "number" ? d.hottestLeadScore : 0}`,
  ].join("\n");
}

function formatReplySuggestionMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const suggestion = typeof d.suggestedReplyText === "string" ? d.suggestedReplyText.trim() : "";
  if (!suggestion) {
    const reason = typeof d.reviewReason === "string" ? ` ${d.reviewReason}` : "";
    return `No auto-draft was generated for this reply.${reason}`;
  }
  return `Suggested reply:\n\n${suggestion}`;
}

function formatAutonomousRecommendationMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const safety = d.safety && typeof d.safety === "object" ? d.safety as Record<string, unknown> : {};
  const priority = d.priority && typeof d.priority === "object" ? d.priority as Record<string, unknown> : {};
  const escalation = d.humanEscalation && typeof d.humanEscalation === "object" ? d.humanEscalation as Record<string, unknown> : {};
  const lead = typeof d.leadEmail === "string" ? d.leadEmail : `recipient ${String(d.recipientId ?? "")}`.trim();
  const safetyBlocked = safety.allowed === false || safety.status === "blocked";
  if (safetyBlocked) {
    const reason = typeof safety.reason === "string" ? safety.reason : "a safety rule was triggered";
    return `Automation is blocked for this lead because ${reason}`;
  }
  const reasons = Array.isArray(d.reasons) ? d.reasons.slice(0, 3).filter((r): r is string => typeof r === "string") : [];
  return [
    `Autonomous recommendation for **${lead}**:`,
    "",
    `- Priority: ${String(priority.priorityLevel ?? "unknown").replace(/_/g, " ")}`,
    `- Recommended action: ${String(d.recommendedAction ?? "review")}`,
    `- Human escalation: ${escalation.escalate === true ? "yes" : "no"}`,
    `- Next best action: ${typeof d.nextBestAction === "string" ? d.nextBestAction : "Review this lead before changing automation."}`,
    ...(reasons.length ? ["", "Reasons:", ...reasons.map((reason) => `- ${reason}`)] : []),
  ].join("\n");
}

function formatCampaignAutonomousSummaryMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const priorities = Array.isArray(d.topPriorities) ? d.topPriorities as Array<Record<string, unknown>> : [];
  const lines = [
    "Autonomous SDR Summary:",
    `- Urgent leads: ${typeof d.urgentLeads === "number" ? d.urgentLeads : 0}`,
    `- Meeting-ready: ${typeof d.meetingReadyLeads === "number" ? d.meetingReadyLeads : 0}`,
    `- Human review needed: ${typeof d.humanReviewNeeded === "number" ? d.humanReviewNeeded : 0}`,
    `- Safety-blocked: ${typeof d.safetyBlockedLeads === "number" ? d.safetyBlockedLeads : 0}`,
    `- Recommended action: ${typeof d.recommendedCampaignAction === "string" ? d.recommendedCampaignAction : "Review top-priority leads first."}`,
  ];
  if (priorities.length > 0) {
    lines.push("", "Top priorities:");
    priorities.slice(0, 5).forEach((lead, index) => {
      const email = typeof lead.leadEmail === "string" ? lead.leadEmail : `recipient ${String(lead.recipientId ?? "")}`;
      const priority = lead.priority && typeof lead.priority === "object"
        ? String((lead.priority as Record<string, unknown>).priorityLevel ?? "lead").replace(/_/g, " ")
        : "lead";
      const action = typeof lead.recommendedAction === "string" ? lead.recommendedAction : "review";
      lines.push(`${index + 1}. ${email} - ${priority} - ${action}`);
    });
  }
  return lines.join("\n");
}

function formatSequenceAdaptationPreviewMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const safety = d.safety && typeof d.safety === "object" ? d.safety as Record<string, unknown> : {};
  if (safety.allowed === false || safety.status === "blocked") {
    const reason = typeof safety.reason === "string" ? safety.reason : "a safety rule was triggered";
    return `Automation is blocked for this lead because ${reason}`;
  }
  const preview = d.adaptationPreview && typeof d.adaptationPreview === "object"
    ? d.adaptationPreview as Record<string, unknown>
    : {};
  const changed = Array.isArray(preview.changedTouchNumbers) ? preview.changedTouchNumbers.join(", ") : "none";
  return [
    "Sequence adaptation preview:",
    `- Recommended action: ${String(d.recommendedAction ?? preview.recommendedAction ?? "keep_sequence_unchanged")}`,
    `- Changed future touches: ${changed || "none"}`,
    `- Human review: ${preview.requiresHumanReview === true ? "required" : "not required"}`,
    `- Summary: ${typeof preview.adaptationSummary === "string" ? preview.adaptationSummary : "No preview available."}`,
    `- Next best action: ${typeof d.nextBestAction === "string" ? d.nextBestAction : "Review the preview before making changes."}`,
  ].join("\n");
}

function formatSmtpMessage(data: unknown): string {
  const d = unwrapMcpData(data);
  const host       = typeof d.host       === "string"  && d.host       ? d.host       : null;
  const port       = (typeof d.port === "number" || typeof d.port === "string") && d.port ? String(d.port) : null;
  const username   = typeof d.username   === "string"  && d.username   ? d.username   : null;
  const fromEmail  = typeof d.fromEmail  === "string"  && d.fromEmail  ? d.fromEmail  : null;
  const encryption = typeof d.encryption === "string"  ? d.encryption.toUpperCase() : null;
  const isVerified = typeof d.isVerified === "boolean" ? d.isVerified : undefined;

  // When no host is configured, SMTP has not been set up yet
  if (!host) {
    return (
      "SMTP is not configured. Please go to **Settings → SMTP Configuration** to set up your mail server."
    );
  }

  const statusStr  = isVerified === true ? "✅ Verified" : isVerified === false ? "❌ Not verified" : "—";

  return [
    "Current SMTP Settings:",
    "",
    `Host:       ${host}`,
    `Port:       ${port ?? "—"}`,
    `Username:   ${username ?? "—"}`,
    `From email: ${fromEmail ?? "—"}`,
    `Encryption: ${encryption ?? "—"}`,
    `Status:     ${statusStr}`,
  ].join("\n");
}

// ── Deterministic website content summarizer ─────────────────────────────────

function extractWebsiteSummary(content: string): { summary: string; focusAreas: string[] } {
  const clean = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);

  const headings: string[] = [];
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      const heading = line.replace(/^#{1,4}\s+/, "").trim();
      if (heading.length > 2 && heading.length < 80) headings.push(heading);
      if (headings.length >= 5) break;
    }
  }

  if (headings.length < 3) {
    for (const line of lines) {
      if (/^\*\*[^*]+\*\*$/.test(line) || /^[A-Z][A-Z\s&]{4,40}$/.test(line)) {
        const area = line.replace(/\*\*/g, "").trim();
        if (area.length > 2 && area.length < 80 && !headings.includes(area)) headings.push(area);
      }
      if (headings.length >= 5) break;
    }
  }

  let summary = "";
  for (const line of lines) {
    if (line.length > 40 && !/^[#*\-_=]/.test(line) && !/^https?:/.test(line)) {
      summary = line.length > 200 ? line.slice(0, 200).trimEnd() + "…" : line;
      break;
    }
  }

  const focusAreas =
    headings.length > 0 ? headings.slice(0, 5) : ["Content available — no headings detected"];

  return { summary, focusAreas };
}

function buildDetailedMessage(intent: string | undefined, data: unknown): string {
  switch (intent) {
    case "get_campaign_stats": return formatStatsMessage(data);
    case "show_sequence_progress": return formatSequenceProgressMessage(data);
    case "show_pending_follow_ups": return formatPendingFollowUpsMessage(data);
    case "show_recipient_touch_history": return formatRecipientTouchHistoryMessage(data);
    case "list_replies":       return formatRepliesMessage(data);
    case "show_hot_leads":
    case "show_meeting_ready_leads": return formatReplyLeadListMessage(data);
    case "summarize_objections": return formatReplyIntelligenceSummaryMessage(data);
    case "draft_reply_to_latest_lead": return formatReplySuggestionMessage(data);
    case "explain_lead_priority":
    case "show_next_best_action": return formatAutonomousRecommendationMessage(data);
    case "show_autonomous_recommendations":
    case "show_escalation_queue": return formatCampaignAutonomousSummaryMessage(data);
    case "preview_sequence_adaptation": return formatSequenceAdaptationPreviewMessage(data);
    case "check_smtp":         return formatSmtpMessage(data);
    case "create_campaign": {
      const d    = unwrapMcpData(data);
      const rawId = d.id;
      const id    = typeof rawId === "string" ? rawId
                  : typeof rawId === "number" ? String(rawId)
                  : null;
      const name  = typeof d.name === "string" ? d.name : "Untitled";
      if (!id) {
        return (
          "Campaign creation could not be confirmed — the server did not return a campaign ID. " +
          "Please check your campaigns list or try again."
        );
      }
      return `Campaign "${name}" created successfully.`;
    }
    default:                   return buildSuccessMessage(intent);
  }
}

// ── Multi-step helpers ────────────────────────────────────────────────────────

/**
 * Converts a tool result data value into a short, human-readable description.
 * Never returns raw JSON — unknown shapes fall back to generic labels.
 */
function describeToolResult(toolName: string, data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "Completed.";

  const d = data as Record<string, unknown>;

  switch (toolName) {
    case "create_campaign":
    case "update_campaign": {
      const name   = typeof d.name   === "string" ? d.name   : "untitled";
      const status = typeof d.status === "string" ? d.status : "created";
      return `Campaign "${name}" — status: ${status}.`;
    }
    case "start_campaign":
    case "pause_campaign":
    case "resume_campaign": {
      const name = typeof d.name === "string" ? d.name : typeof d.id === "string" ? d.id : "";
      const verb = toolName.replace(/_/g, " ");
      return name ? `Campaign "${name}" — ${verb} successfully.` : `${verb} completed.`;
    }
    case "get_campaign_stats": {
      const sent     = typeof d.sent     === "number" ? d.sent     : 0;
      const opened   = typeof d.opened   === "number" ? d.opened   : 0;
      const openRate = typeof d.openRate === "number" ? Math.round(d.openRate * 100) : 0;
      return `Sent ${sent.toLocaleString()}, opened ${opened.toLocaleString()} (${openRate}% open rate).`;
    }
    case "get_sequence_progress": {
      const pendingFollowUps = typeof d.pendingFollowUps === "number" ? d.pendingFollowUps : 0;
      const dueFollowUps = typeof d.dueFollowUps === "number" ? d.dueFollowUps : 0;
      return `${pendingFollowUps} pending follow-ups, ${dueFollowUps} due now.`;
    }
    case "get_pending_follow_ups": {
      const total = typeof d.total === "number" ? d.total : Array.isArray(d.items) ? d.items.length : 0;
      return `${total} pending follow-up${total === 1 ? "" : "s"} listed.`;
    }
    case "get_recipient_touch_history":
      return "Recipient touch history retrieved.";
    case "mark_recipient_replied":
      return "Recipient marked as replied.";
    case "mark_recipient_bounced":
      return "Recipient marked as bounced.";
    case "list_replies":
    case "summarize_replies": {
      const total = typeof d.total === "number" ? d.total
        : Array.isArray(d.items) ? (d.items as unknown[]).length
        : 0;
      return `${total} ${total === 1 ? "reply" : "replies"} retrieved.`;
    }
    case "get_smtp_settings":
    case "update_smtp_settings": {
      const host = typeof d.host === "string" ? d.host : "";
      const port = typeof d.port === "number" ? d.port : "";
      const enc  = typeof d.encryption === "string" ? ` (${d.encryption.toUpperCase()})` : "";
      return host ? `SMTP: ${host}:${port}${enc}.` : "SMTP settings retrieved.";
    }
    case "get_recipient_count": {
      const n = typeof d.pendingCount === "number" ? d.pendingCount : 0;
      return `${n} recipient${n !== 1 ? "s" : ""} ready.`;
    }
    case "save_ai_prompt":
      return "AI prompt saved.";
    case "generate_personalized_emails": {
      const n = typeof d.generatedCount === "number" ? d.generatedCount : 0;
      return `${n} personalized email${n !== 1 ? "s" : ""} generated.`;
    }
    case "get_personalized_emails": {
      const n = typeof d.total === "number" ? d.total : 0;
      return `${n} personalized email${n !== 1 ? "s" : ""} retrieved.`;
    }
    default:
      return "Step completed.";
  }
}

/**
 * Builds a human-readable summary of completed plan steps.
 * Used both for the all-safe success case and as a preamble
 * before an approval prompt when safe steps preceded the risky one.
 *
 * Never embeds raw JSON — each step's data is described via describeToolResult.
 */
function buildPlanResultsSummary(results: PlanStepResult[]): string {
  const header = results.length === 1
    ? "Completed 1 step:"
    : `Completed ${results.length} steps:`;

  const lines: string[] = [header, ""];

  for (const result of results) {
    const stepLabel = `**Step ${result.stepIndex + 1} — ${result.toolName.replace(/_/g, " ")}**`;
    const body = describeToolResult(result.toolName, result.toolResult.data);

    if (result.toolResult.isToolError) {
      lines.push(`${stepLabel}: Error — ${body}`);
    } else {
      lines.push(`${stepLabel}: ${body}`);
    }
  }

  return lines.join("\n");
}

// ── Campaign list formatter ───────────────────────────────────────────────────

// `recieptCount` preserves the intentional schema typo from the DB.
type CampaignEntry = { id: string; name: string; status: string; recieptCount?: number };

const EMPTY_STATE_SUFFIX: Record<string, string> = {
  start_campaign:    "before sending.",
  schedule_campaign: "before scheduling.",
  update_campaign:   "before updating.",
  pause_campaign:    "to pause a campaign.",
  resume_campaign:   "to resume a campaign.",
  get_campaign_stats: "to view statistics.",
};

function formatCampaignList(
  campaigns: CampaignEntry[],
  pendingAction: string | undefined,
): string {
  if (campaigns.length === 0) {
    if (!pendingAction) return "No campaigns found. Please create a campaign first.";
    const suffix = EMPTY_STATE_SUFFIX[pendingAction] ?? "to continue.";
    return `No campaigns found. Please create a campaign first ${suffix}`;
  }

  // No pending action — just listing campaigns; show a readable list without a selection prompt.
  if (!pendingAction) {
    const lines = campaigns.map((c, i) => {
      const recipientNote =
        c.recieptCount === 0 ? " — ⚠️ 0 recipients" : "";
      return `${i + 1}. **${c.name}** — Status: ${c.status}${recipientNote}`;
    });
    const zeroCount = campaigns.filter((c) => c.recieptCount === 0).length;
    let result = `Here are your campaigns:\n\n${lines.join("\n")}`;
    if (zeroCount > 0) {
      const subj = zeroCount === campaigns.length
        ? "All campaigns currently have"
        : `${zeroCount} campaign${zeroCount > 1 ? "s" : ""} currently ha${zeroCount > 1 ? "ve" : "s"}`;
      result += `\n\n⚠️ ${subj} 0 recipients. Upload a CSV file before sending.`;
    }
    return result;
  }

  const verb = pendingAction === "pause_campaign"       ? "pause"
             : pendingAction === "resume_campaign"      ? "resume"
             : pendingAction === "start_campaign"       ? "start"
             : pendingAction === "update_campaign"      ? "update"
             : pendingAction === "schedule_campaign"    ? "schedule"
             : pendingAction === "get_campaign_stats"   ? "view stats for"
             : "work with";

  const lines = campaigns.map((c, i) => `${i + 1}. **${c.name}** (${c.status})`);

  return (
    `Sure! Which campaign would you like to ${verb}?\n\n` +
    lines.join("\n") +
    "\n\nReply with the **number** or **campaign name**."
  );
}

// ── Enrichment campaign selection ────────────────────────────────────────────

function formatEnrichmentCampaignList(
  campaigns: CampaignEntry[],
  enrichmentData: AgentGraphStateType["pendingEnrichmentData"],
): string {
  const n    = enrichmentData?.totalProcessed ?? 0;
  const noun = `${n} enriched contact${n !== 1 ? "s" : ""}`;

  if (campaigns.length === 0) {
    return JSON.stringify({
      status:          "needs_input",
      intent:          "confirm_enrichment",
      message: [
        "**No campaigns found**",
        "",
        `I have **${noun}** ready to save, but you don't have any campaigns yet.`,
        "",
        "Please create a campaign first, then say **save enriched contacts** to continue.",
      ].join("\n"),
      required_fields: ["campaign"],
      optional_fields: [],
    });
  }

  const lines = campaigns.map((c, i) => `${i + 1}. **${c.name}** — ${c.status}`);
  return JSON.stringify({
    status: "success",
    intent: "confirm_enrichment",
    message: [
      "**Select a campaign**",
      "",
      `I have **${noun}** ready to save. Please choose which campaign should receive them:`,
      "",
      ...lines,
      "",
      "Reply with the **campaign number** or **campaign name**.",
    ].join("\n"),
    data: { campaigns },
  });
}

// ── Tool error → human message ────────────────────────────────────────────────

function humanizeToolError(_intent: string | undefined, data: unknown): string {
  const raw  = typeof data === "string" ? data : JSON.stringify(data ?? "");
  const low  = raw.toLowerCase();

  // Invalid campaign ID type — PostgreSQL 22P02 (pg_strtoint32_safe).
  // Occurs when a non-numeric string is passed as a campaign ID and the
  // backend tries to bind it to an INTEGER column parameter ($1).
  if (
    low.includes("22p02") ||
    low.includes("invalid input syntax for type integer") ||
    low.includes("pg_strtoint32") ||
    low.includes("invalid_text_representation") ||
    low.includes("invalid_campaign_id") ||
    low.includes("must be a numeric value")
  ) {
    return (
      "I couldn't identify which campaign to send. " +
      "Please select a campaign from the list, or say **list my campaigns** to see all available campaigns."
    );
  }

  // Missing campaignId — Zod validation before the tool ran.
  if (low.includes("campaignid") && (low.includes("required") || low.includes("empty"))) {
    return (
      "I need to know which campaign you're referring to. " +
      "Please mention the campaign name or say **list my campaigns** to see all available campaigns."
    );
  }

  // Campaign not found on the backend.
  if (low.includes("not found") || low.includes("404") || low.includes("no_campaign")) {
    return (
      "Campaign not found. Please check the campaign name or ID and try again."
    );
  }

  // Campaign in wrong status (e.g. already running, completed).
  if (
    low.includes("invalid status") ||
    low.includes("already running") ||
    low.includes("already started") ||
    low.includes("completed") ||
    (low.includes("status") && (low.includes("invalid") || low.includes("cannot")))
  ) {
    return (
      "This campaign cannot be started in its current state — it may already be " +
      "running, paused, or completed. Check the campaign status and try again."
    );
  }

  // No recipients.
  if (
    low.includes("recipient") ||
    low.includes("no contact") ||
    low.includes("empty list") ||
    low.includes("no_recipients")
  ) {
    return (
      "No valid recipients found. " +
      "Please upload or select a recipient list before sending this campaign."
    );
  }

  // SMTP not configured or failed.
  if (low.includes("smtp") || low.includes("email server") || low.includes("mail server")) {
    return (
      "SMTP configuration failed. " +
      "Please check your SMTP host, port, email, and password in Settings."
    );
  }

  // Sending limit reached.
  if (low.includes("limit") || low.includes("quota") || low.includes("rate")) {
    return (
      "Sending limit reached. Please try again later or upgrade your sending plan."
    );
  }

  // Auth / permissions.
  if (
    low.includes("unauthorized") ||
    low.includes("forbidden") ||
    low.includes("401") ||
    low.includes("403") ||
    low.includes("permission")
  ) {
    return "You are not authorized to perform this action. Please check your account permissions.";
  }

  // Timeout / network.
  if (low.includes("timeout") || low.includes("econnaborted") || low.includes("network")) {
    return "The request timed out. Please check your connection and try again.";
  }

  // Extract a safe message from the JSON error body if possible.
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const msg = typeof parsed.message === "string" ? parsed.message
              : typeof parsed.error   === "string" ? parsed.error
              : null;
    if (msg && msg.length < 300) {
      return toUserSafeMcpMessage(new Error(msg));
    }
  } catch { /* not JSON */ }

  return toUserSafeMcpMessage(new Error(raw.length > 800 ? raw.slice(0, 800) : raw));
}

// ── Contextual help responders ────────────────────────────────────────────────

const TEMPLATE_LIST = `Sure — here are the available campaign templates:

1. **Promotional** — special offers, discounts, and sales
2. **Newsletter** — regular updates, content, and news
3. **Event** — invitations and event announcements
4. **Announcement** — product launches and service updates
5. **Follow-up** — post-purchase or post-event follow-up

Tell me which one you'd like to use, or say **Create AI campaign** to start building a personalized campaign with one of these templates.`;

const UPLOAD_RECIPIENTS_GUIDE = `Here's how to upload recipients for a campaign:

1. **Create or select a campaign** first (or let me create one for you)
2. **Click the 📎 attach button** in the chat input to select a CSV or Excel file
3. The file needs at least one **email** column — a **name** column is optional but recommended for personalization

After uploading, I'll validate the recipients and show you how many are ready. Any rows with invalid or duplicate emails are rejected automatically.

If you're using the **AI campaign wizard**, I'll guide you through the upload step automatically. Just say **Create AI campaign** to begin.`;

const AI_CAMPAIGN_GUIDE = `The **AI campaign wizard** walks you through creating a personalized campaign step by step:

1. **Name & subject** — I'll ask for your campaign name and email subject line
2. **Upload recipients** — Attach a CSV/Excel file with your contacts
3. **Choose a template** — Pick from promotional, newsletter, event, announcement, or follow-up
4. **Set tone** — Optionally describe how the emails should sound (e.g. "professional", "warm and friendly")
5. **Add instructions** — Optional extra guidance for the AI writer
6. **Generate emails** — AI writes a unique personalized email for each recipient using their CSV data
7. **Review & launch** — See sample emails, then schedule or start the campaign

Say **Create AI campaign** to begin, or ask me anything specific about the process.`;

function buildNextStepGuidance(state: AgentGraphStateType): string {
  const {
    activeCampaignId,
    campaignSelectionList,
    pendingAiCampaignStep,
    pendingAiCampaignData,
  } = state;

  // Mid AI-wizard: surface the current step
  if (pendingAiCampaignStep) {
    const stepMessages: Record<string, string> = {
      campaign_name:      "You're in the AI campaign wizard. **Next step**: provide a name for your campaign.",
      campaign_subject:   "You're in the AI campaign wizard. **Next step**: provide a subject line for your campaign emails.",
      template_selection: "You're in the AI campaign wizard. **Next step**: choose a template type — promotional, newsletter, event, announcement, or follow-up.",
      campaign_body:      "You're in the AI campaign wizard. **Next step**: review the generated email body and reply **confirm** to proceed, or describe any changes.",
      recipient_source:   "You're in the AI campaign wizard. **Next step**: say **done** and I'll check how many recipients have been uploaded to this campaign.",
      upload_recipients:  "**Next step**: go to the **Campaigns** section in the web UI, open your campaign, and upload your recipient CSV or Excel file. Once done, come back and say **done**.",
      check_count:        "Checking your recipient count now…",
      template:           "You're in the AI campaign wizard. **Next step**: choose a template — promotional, newsletter, event, announcement, or follow-up. Which would you like?",
      tone:               "You're setting the tone for your AI campaign. **Next step**: describe how you'd like the emails to sound (e.g. \"professional\", \"friendly and casual\", \"concise\"), or say **skip** to use the default.",
      custom_prompt:      "You can add custom instructions for the AI writer — for example \"mention the 20% discount\" or \"keep it under 100 words\". Say **skip** to continue without extra instructions.",
      generate:           "Recipients are uploaded and ready. Say **generate** or **continue** to let AI write personalized emails for each contact.",
      review:             "Your personalized emails are ready for review. Reply **confirm** to schedule/start the campaign, or **cancel** to abort.",
    };
    const msg = stepMessages[pendingAiCampaignStep]
      ?? `You're on the **${pendingAiCampaignStep}** step of the AI campaign wizard. Answer the last question or say **continue** to proceed.`;
    return msg;
  }

  // No campaigns at all
  const hasCampaigns = activeCampaignId || (campaignSelectionList && campaignSelectionList.length > 0);
  if (!hasCampaigns) {
    return (
      "Here's how to get started:\n\n" +
      "1. **Create an AI campaign** — I'll guide you step-by-step through a personalized campaign (say \"Create AI campaign\")\n" +
      "2. **Create a standard campaign** — Say \"create a campaign\" and I'll collect the details\n" +
      "3. **View existing campaigns** — Say \"show campaigns\" to see what you have\n\n" +
      "What would you like to do?"
    );
  }

  // Campaign selected but may be missing recipients
  if (activeCampaignId) {
    const count = parseInt(pendingAiCampaignData?.recipientCount ?? "-1", 10);
    if (count === 0) {
      return (
        `You have an active campaign (ID: ${activeCampaignId}) but **no recipients yet**. Here are your options:\n\n` +
        "- **Upload recipients** — click the 📎 attach button to upload a CSV/Excel file\n" +
        "- **Generate personalized emails** — available after uploading recipients\n" +
        "- **Schedule the campaign** — Say \"schedule campaign\" to set a send date\n" +
        "- **Start the campaign** — Say \"start campaign\" to launch it once recipients are added\n\n" +
        "What would you like to do?"
      );
    }
    if (count > 0) {
      return (
        `You have an active campaign (ID: ${activeCampaignId}) with **${count} recipient${count !== 1 ? "s" : ""}** ready. Suggested next steps:\n\n` +
        "- **Generate personalized emails** — Say \"generate personalized emails\" to create unique content per contact\n" +
        "- **Schedule the campaign** — Say \"schedule campaign\" to set a send date\n" +
        "- **Start the campaign** — Say \"start campaign\" to begin sending immediately\n\n" +
        "What would you like to do?"
      );
    }
  }

  // Generic fallback guidance
  return (
    "Here's what you can do:\n\n" +
    "- **Create an AI campaign** — Personalized emails for each recipient (say \"Create AI campaign\")\n" +
    "- **View your campaigns** — Say \"show campaigns\"\n" +
    "- **Check analytics** — Say \"campaign stats\" for performance metrics\n" +
    "- **Check inbox** — Say \"show replies\" to see recipient responses\n\n" +
    "What would you like to work on?"
  );
}

function buildRecipientStatusGuidance(state: AgentGraphStateType): string {
  const { activeCampaignId, pendingAiCampaignData } = state;
  const count = parseInt(pendingAiCampaignData?.recipientCount ?? "-1", 10);

  if (!activeCampaignId) {
    return (
      "I don't have an active campaign selected yet. To check recipients:\n\n" +
      "1. Say **show campaigns** to pick a campaign, or\n" +
      "2. Start an AI campaign wizard — it checks recipients automatically after you upload a CSV.\n\n" +
      "Would you like to create or select a campaign?"
    );
  }
  if (count >= 0) {
    return count === 0
      ? `Campaign **${activeCampaignId}** currently has **0 recipients**. Use the 📎 attach button to upload a CSV file.`
      : `Campaign **${activeCampaignId}** has **${count} recipient${count !== 1 ? "s" : ""}** ready.`;
  }
  return (
    `I can check the recipient count for campaign **${activeCampaignId}**. ` +
    "Say **check recipients** and I'll fetch the current count, or upload a CSV to add recipients."
  );
}

// ── Phase 1: deterministic response ──────────────────────────────────────────

function buildResponse(state: AgentGraphStateType): string {
  // One-shot notice from loadMemory when pending workflow state expired or
  // schema was newer than this runtime (takes priority over domain copy).
  if (state.workflowExpiredNotice) {
    return state.workflowExpiredNotice;
  }

  // Pre-formatted response from a domain agent (e.g. EnrichmentAgent preview).
  // Return it directly, bypassing all other formatting logic.
  // OpenAI enhancement is naturally skipped because enrichment intents are not
  // in ENHANCE_INTENTS, so maybeEnhanceWithOpenAI passes this through unchanged.
  if (state.formattedResponse) {
    return state.formattedResponse;
  }

  const {
    intent, error, requiresApproval, pendingActionId,
    toolName, toolResult, planResults,
    pendingCampaignAction,
  } = state;

  log.debug(
    {
      sessionId:            state.sessionId,
      intent,
      toolName,
      pendingCampaignAction,
      hasError:             !!error,
      errorSnippet:         error ? error.slice(0, 80) : undefined,
      hasToolResult:        toolResult !== undefined,
      toolResultIsToolError: toolResult?.isToolError,
      requiresApproval,
      planSteps:            state.plan?.length,
      planResultsCount:     planResults?.length,
    },
    "buildResponse: entry state",
  );

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error) {
    // If a campaign list fetch failed at the transport layer (MCP threw before
    // returning a toolResult) while we were trying to start/pause/resume/schedule,
    // treat it as "no campaigns" rather than a generic error.
    if (toolName === "get_all_campaigns" && pendingCampaignAction) {
      return formatCampaignList([], pendingCampaignAction);
    }

    // schedule_campaign with no toolName means the date was missing or the
    // agent returned a clarification prompt — surface it directly.
    // schedule_campaign with any other toolName (shouldn't reach here after the
    // planner bypass, but keep as a safety net) returns the empty-state message.
    if (intent === "schedule_campaign" && !toolName) return error;
    if (intent === "schedule_campaign") {
      return formatCampaignList([], "schedule_campaign");
    }

    // When toolName is absent, the domain agent rejected the request before
    // dispatch (e.g. missing required fields).  The error string is a
    // user-facing clarification prompt — return it directly without the
    // system-error wrapper.
    if (!toolName) return error;
    return `I'm sorry, something went wrong: ${error} Please try again or rephrase your request.`;
  }

  // ── Approval required ─────────────────────────────────────────────────────
  // For multi-step plans: show already-completed steps as preamble, then the
  // approval prompt for the paused risky step.
  // For single-step: standard approval prompt.
  if (requiresApproval && pendingActionId) {
    const actionLabel = intent
      ? (INTENT_LABELS[intent] ?? intent.replace(/_/g, " "))
      : "this action";
    const approvalPrompt =
      `I need your confirmation before I ${actionLabel}.\n\n` +
      `This is a sensitive operation that can affect your live campaigns or mail settings.\n\n` +
      `To confirm, reply **yes** or send:\n` +
      `POST /api/agent/confirm  { "pendingActionId": "${pendingActionId}" }\n\n` +
      `To cancel, reply **no** or send:\n` +
      `POST /api/agent/cancel   { "pendingActionId": "${pendingActionId}" }`;

    if (planResults && planResults.length > 0) {
      return buildPlanResultsSummary(planResults) + "\n\n" + approvalPrompt;
    }
    return approvalPrompt;
  }

  // ── Out-of-domain ─────────────────────────────────────────────────────────
  if (intent === "out_of_domain") {
    return OUT_OF_DOMAIN_REFUSAL;
  }

  // ── General help ──────────────────────────────────────────────────────────
  // Show the full capabilities card only when the user is explicitly asking for
  // a broad overview ("help", "what can you do", etc.).
  // Vague/contextual help messages get a short clarification prompt instead.
  if (intent === "general_help") {
    if (EXPLICIT_HELP_RE.test(state.userMessage)) {
      return CAPABILITIES;
    }
    return (
      "I can help with **campaigns**, **recipients**, **templates**, **scheduling**, " +
      "**analytics**, **SMTP settings**, and **inbox replies**.\n\n" +
      "Which part would you like to work on?"
    );
  }

  // ── Contextual help intents ───────────────────────────────────────────────
  if (intent === "template_help")           return TEMPLATE_LIST;
  if (intent === "upload_recipients_help")  return UPLOAD_RECIPIENTS_GUIDE;
  if (intent === "ai_campaign_help")        return AI_CAMPAIGN_GUIDE;
  if (intent === "next_step_help")          return buildNextStepGuidance(state);
  if (intent === "recipient_status_help")   return buildRecipientStatusGuidance(state);

  // ── No tool selected ──────────────────────────────────────────────────────
  if (!toolName) {
    // Domain intent where the agent couldn't dispatch a tool (e.g. missing
    // campaignId for replies/stats). Return a contextual message rather than
    // the generic capabilities card which would confuse the user.
    switch (intent) {
      case "summarize_replies":
        return "No replies found to summarize. Please specify a campaign or try after sending one.";
      case "list_replies":
        return "No replies found. Please specify a campaign or try after sending one.";
      case "get_campaign_stats":
        return "Please specify which campaign you'd like statistics for, or say **list my campaigns** to see all campaigns.";
      default:
        return (
          "I'm not sure how to help with that. I can assist with campaigns, recipients, " +
          "templates, scheduling, analytics, SMTP, and inbox replies. What would you like to do?"
        );
    }
  }

  // ── Multi-step plan completed ──────────────────────────────────────────────
  if (planResults && planResults.length > 0) {
    return buildPlanResultsSummary(planResults);
  }

  // ── Tool result available ──────────────────────────────────────────────────
  if (toolResult !== undefined) {
    // ── get_all_campaigns: format as numbered list or selection prompt ───────
    // Handled before the generic isToolError branch so that a backend error
    // on this endpoint (e.g. 404 when no campaigns exist) is still surfaced as
    // a friendly "no campaigns found" message rather than a generic error,
    // especially when a campaign action (start/pause/resume) triggered the fetch.
    if (toolName === "get_all_campaigns") {
      if (toolResult.isToolError && pendingCampaignAction) {
        return formatCampaignList([], pendingCampaignAction);
      }
      if (toolResult.isToolError) {
        return humanizeToolError(intent, toolResult.data);
      }

      const raw = toolResult.data;
      // toolResult.data is the MCP success envelope { success, data: Campaign[] }.
      // Unwrap the inner array; fall back to treating raw itself as an array for
      // forward-compatibility if the transport ever returns the array directly.
      const rawArray: Array<Record<string, unknown>> =
        Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : typeof raw === "object" &&
            raw !== null &&
            Array.isArray((raw as Record<string, unknown>).data)
          ? ((raw as Record<string, unknown>).data as Array<Record<string, unknown>>)
          : [];

      const campaigns: CampaignEntry[] = rawArray
        .filter((c) => (typeof c.id === "string" || typeof c.id === "number") && typeof c.name === "string")
        .map((c) => ({
          id:           String(c.id),
          name:         c.name   as string,
          status:       typeof c.status        === "string" ? c.status : "unknown",
          recieptCount: typeof c.recieptCount  === "number" ? c.recieptCount
                      : typeof c.reciept_count === "number" ? c.reciept_count
                      : undefined,
        }));

      // Enrichment save — show a campaign selection prompt specific to enrichment
      if (state.pendingEnrichmentAction === "save_enriched_contacts") {
        return formatEnrichmentCampaignList(campaigns, state.pendingEnrichmentData);
      }

      return formatCampaignList(campaigns, pendingCampaignAction);
    }

    if (toolResult.isToolError) {
      return humanizeToolError(intent, toolResult.data);
    }

    // ── Phase 1 AI campaign tools — format inline rather than delegating ──────
    if (toolName === "get_recipient_count") {
      const d = unwrapMcpData(toolResult.data);
      const count = typeof d.pendingCount === "number" ? d.pendingCount
                  : typeof d.totalCount  === "number" ? d.totalCount
                  : 0;
      const msg = count === 0
        ? "No recipients found yet. Please upload a CSV file using the **📎 attach** button, then confirm to continue."
        : `Found **${count}** recipient${count !== 1 ? "s" : ""} ready for personalization. Say **continue** to proceed with AI email generation.`;
      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    if (toolName === "save_ai_prompt") {
      return JSON.stringify({
        status: "success", intent,
        message: "AI prompt configuration saved. Generating personalized emails now...",
        data: toolResult.data,
      });
    }

    if (toolName === "generate_personalized_emails") {
      const d          = unwrapMcpData(toolResult.data);
      const rawPayload = toolResult.data as Record<string, unknown>;

      // toolFailure() returns { success: false, error: { ... } }.
      // FastMCP transports may not set isToolError=true, so guard explicitly
      // before reading generatedCount/failedCount to avoid "Generated 0" on failures.
      if (rawPayload?.success === false) {
        const serialized = JSON.stringify(toolResult.data).toLowerCase();
        const isTimeout  = serialized.includes("timeout") || serialized.includes("mailflow_timeout");
        const message    = isTimeout
          ? [
              "**Personalized email generation failed**",
              "",
              "The backend generation request timed out.",
              "",
              "Please try again, or check the backend logs for:",
              "`POST /api/campaigns/:id/generate-personalized`",
            ].join("\n")
          : "**Personalized email generation failed.** Please try again.";
        return JSON.stringify({ status: "error", intent, message, data: toolResult.data });
      }

      // Duplicate guard — existing emails found and overwrite was not requested
      if (d.alreadyExists === true) {
        const count = typeof d.existingCount === "number" ? d.existingCount : 0;
        const campaign = state.activeCampaignId ? ` for campaign **#${state.activeCampaignId}**` : "";
        const message = [
          `**${count} personalized email${count !== 1 ? "s" : ""} already exist${campaign}.**`,
          "",
          "What would you like to do?",
          "- **Review existing emails** — say \"review emails\"",
          "- **Regenerate emails** — say \"regenerate emails\" to overwrite with fresh AI content",
          "- **Start campaign** — say \"start campaign\" to proceed with the existing emails",
        ].join("\n");
        return JSON.stringify({ status: "success", intent, message, data: toolResult.data });
      }

      const generated = typeof d.generatedCount  === "number" ? d.generatedCount  : 0;
      const failed    = typeof d.failedCount     === "number" ? d.failedCount     : 0;
      const total     = typeof d.totalRecipients === "number" ? d.totalRecipients : generated + failed;
      const touchesPerLead = typeof d.touchesPerLead === "number" ? d.touchesPerLead : undefined;
      const modeUsed  = typeof d.modeUsed === "string" ? d.modeUsed : "low_promotional_plaintext";
      const strategy =
        d.strategy && typeof d.strategy === "object"
          ? (d.strategy as Record<string, unknown>)
          : null;
      const touchSchedule = Array.isArray(d.touchSchedule)
        ? (d.touchSchedule as unknown[]).filter((n): n is number => typeof n === "number")
        : [];
      const deliverability =
        d.deliverability && typeof d.deliverability === "object"
          ? (d.deliverability as Record<string, unknown>)
          : null;
      const inboxRisk = typeof deliverability?.inboxRisk === "string" ? deliverability.inboxRisk : null;
      const likelyTab = typeof deliverability?.likelyTab === "string" ? deliverability.likelyTab : null;
      const reasons = Array.isArray(deliverability?.reasons)
        ? (deliverability?.reasons as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      const recommendations = Array.isArray(deliverability?.recommendations)
        ? (deliverability?.recommendations as unknown[]).filter((r): r is string => typeof r === "string")
        : [];
      const mainReason = reasons[0];
      const suggestedFix =
        modeUsed === "low_promotional_plaintext"
          ? recommendations[0] ?? "Review the CTA, links, and formatting before starting."
          : "Use low-promotional plaintext mode.";
      const selectedTone = typeof strategy?.tone === "string" ? strategy.tone : null;
      const selectedCta = typeof strategy?.ctaType === "string" ? strategy.ctaType : null;
      const selectedSequence = typeof strategy?.sequenceType === "string" ? strategy.sequenceType : null;

      if (generated === 0 && failed > 0) {
        const message = [
          `**Email generation failed** — ${failed} of ${total} email${total !== 1 ? "s" : ""} could not be generated.`,
          "",
          "This usually means the **OPENAI_API_KEY** environment variable is not configured in your backend.",
          "",
          "Please add `OPENAI_API_KEY=<your-key>` to your backend `.env` file and try again.",
        ].join("\n");
        return JSON.stringify({ status: "error", intent, message, data: toolResult.data });
      }

      const lines = [
        touchesPerLead && touchesPerLead > 1
          ? `Generated **${touchesPerLead}-touch SDR sequence** for **${generated}** lead${generated !== 1 ? "s" : ""}${failed > 0 ? ` (${failed} failed)` : ""}.`
          : failed > 0
            ? `Generated **${generated}** of ${total} personalized emails (${failed} failed).`
            : `Generated **${generated}** personalized email${generated !== 1 ? "s" : ""}.`,
      ];
      if (selectedTone || selectedCta || selectedSequence) {
        lines.push(
          "",
          "**Strategy selected:**",
          ...(selectedTone ? [`- **Tone:** ${selectedTone}`] : []),
          ...(selectedCta ? [`- **CTA:** ${selectedCta}`] : []),
          ...(selectedSequence ? [`- **Sequence:** ${selectedSequence}`] : []),
        );
      }
      if (inboxRisk || likelyTab || mainReason || recommendations.length > 0) {
        lines.push(
          "",
          "**Deliverability check:**",
          ...(inboxRisk ? [`- **Inbox risk:** ${String(inboxRisk).replace(/^./, (c) => c.toUpperCase())}`] : []),
          ...(likelyTab ? [`- **Likely Gmail tab:** ${likelyTab === "promotions_likely" ? "Promotions" : likelyTab === "primary_possible" ? "Primary possible" : "Spam risk"}`] : []),
          ...(mainReason ? [`- **Main reason:** ${mainReason}`] : []),
          ...(suggestedFix ? [`- **Suggested fix:** ${suggestedFix}`] : []),
        );
      }
      if (touchSchedule.length > 0) {
        lines.push(
          "",
          "**Touch schedule:**",
          ...touchSchedule.map((day) => `- Day ${day}`),
        );
      }
      lines.push(
        "",
        "Would you like me to:",
        touchesPerLead && touchesPerLead > 1 ? "1. Review sequence" : "1. Review email",
        "2. Regenerate with different tone",
        "3. Shorten emails",
        "4. Start campaign",
      );
      const msg = lines.join("\n");
      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    // ── Wizard context: after create_campaign, include next step prompt ──────
    if (
      toolName === "create_campaign" &&
      state.pendingAiCampaignStep === "recipient_source" &&
      !toolResult.isToolError
    ) {
      const d = unwrapMcpData(toolResult.data);
      const name = typeof d.name === "string" ? d.name : "your campaign";
      return JSON.stringify({
        status: "success",
        intent: intent ?? "create_ai_campaign",
        message: [
          `Campaign **"${name}"** created! Now let's add recipients.`,
          "",
          "Please go to the **Campaigns** section in the web UI, open this campaign, and upload your recipient CSV or Excel file.",
          "",
          "Your file needs at least an **email** column. Include extra columns like **name**, **company**, **role**, **industry**, or any custom field — the AI will use them to write a unique, personalized email for each recipient.",
          "",
          "Once uploaded, come back here and say **done** — I'll verify the count and we'll continue.",
        ].join("\n"),
        data: toolResult.data,
      });
    }

    if (toolName === "get_personalized_emails") {
      const d = unwrapMcpData(toolResult.data);
      const items: Array<Record<string, unknown>> =
        Array.isArray(d.emails) ? (d.emails as Array<Record<string, unknown>>) : [];
      if (items.length === 0) {
        return JSON.stringify({
          status: "success", intent,
          message: "No personalized emails found. Please run generation first.",
          data: toolResult.data,
        });
      }
      const first = items[0] ?? {};
      const touches = Array.isArray(first.sequenceTouches)
        ? (first.sequenceTouches as Array<Record<string, unknown>>)
        : [];
      const samples = (touches.length > 0 ? touches : items.slice(0, 3)).slice(0, 4).map((item, i) => {
        const subject = typeof item.personalizedSubject === "string" ? item.personalizedSubject : "Subject unavailable";
        const bodySource =
          typeof item.personalizedText === "string"
            ? item.personalizedText
            : typeof item.personalizedBody === "string"
              ? item.personalizedBody.replace(/<[^>]+>/g, "")
              : "Preview unavailable";
        const delay = typeof item.recommendedDelayDays === "number" ? ` — Day ${item.recommendedDelayDays}` : "";
        const touchNumber = typeof item.touchNumber === "number" ? `Touch ${item.touchNumber}` : `Sample ${i + 1}`;
        return `**${touchNumber}${delay}**\n   **Subject:** ${subject}\n   ${bodySource.slice(0, 160)}…`;
      });
      const msg = [
        touches.length > 0
          ? `Here is a **${touches.length}-touch sequence preview** for **${typeof first.recipientEmail === "string" ? first.recipientEmail : "the first lead"}**:`
          : `Here are ${items.length} sample${items.length !== 1 ? "s" : ""}:`,
        "",
        ...samples,
        "",
        "Reply **confirm** to start the campaign, **review sequence** to see this again, or ask to **regenerate with founder tone**, **use softer CTA**, or **remove breakup email**.",
      ].join("\n");
      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    // ── parse_csv_file: show preview + confirmation prompt ───────────────────
    if (toolName === "parse_csv_file") {
      const d = unwrapMcpData(toolResult.data);
      const totalRows   = typeof d.totalRows   === "number" ? d.totalRows   : 0;
      const validRows   = typeof d.validRows   === "number" ? d.validRows   : 0;
      const invalidRows = typeof d.invalidRows === "number" ? d.invalidRows : 0;
      const columns     = Array.isArray(d.columns) ? (d.columns as string[]) : [];
      const preview     = Array.isArray(d.preview) ? (d.preview as Array<Record<string, string>>) : [];

      if (validRows === 0) {
        const msg = "No valid recipients found in the uploaded file. " +
          "Please ensure the file has an **email** column with valid email addresses and try again.";
        return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
      }

      const previewLines = preview.slice(0, 5).map((row, i) => {
        const email = row.email ?? Object.values(row)[0] ?? "—";
        const name  = row.name ? ` — ${row.name}` : "";
        return `${i + 1}. ${email}${name}`;
      });

      const activeCampaignId = state.activeCampaignId;
      const campaignNote = activeCampaignId
        ? `campaign **#${activeCampaignId}**`
        : "a campaign (no campaign selected yet)";

      const msg = [
        `**File parsed successfully!**`,
        "",
        `- **Total rows:** ${totalRows}`,
        `- **Valid recipients:** ${validRows}`,
        ...(invalidRows > 0 ? [`- **Skipped (invalid email):** ${invalidRows}`] : []),
        `- **Columns detected:** ${columns.slice(0, 8).join(", ")}${columns.length > 8 ? "…" : ""}`,
        "",
        `**Preview (first ${Math.min(5, preview.length)} rows):**`,
        ...previewLines,
        "",
        `Would you like to save these **${validRows}** recipient${validRows !== 1 ? "s" : ""} to ${campaignNote}?`,
        "",
        "Reply **yes** to save, or **discard** to cancel.",
      ].join("\n");

      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    // ── save_enriched_contacts: confirm enrichment save ───────────────────────
    if (toolName === "save_enriched_contacts") {
      const d = unwrapMcpData(toolResult.data);
      const saved   = typeof d.saved   === "number" ? d.saved   : 0;
      const skipped = typeof d.skipped === "number" ? d.skipped : 0;

      const args = state.toolArgs as Record<string, unknown>;
      const resolvedCampaignId =
        typeof args.campaignId === "string" && args.campaignId.length > 0
          ? args.campaignId
          : state.activeCampaignId;
      const destination = formatSaveDestinationLine(state, resolvedCampaignId);

      const rejected: Array<{ email?: unknown; reason?: unknown }> =
        Array.isArray(d.rejected) ? (d.rejected as Array<{ email?: unknown; reason?: unknown }>) : [];

      // All duplicates / already on list — still a successful round-trip, not a hard error
      if (saved === 0 && skipped > 0 && rejected.length === 0) {
        const message = [
          "**No new recipients added**",
          "",
          skipped === 1
            ? `That contact was already in ${destination}, so the list is unchanged.`
            : `**${skipped}** contacts were already in ${destination}, so no new rows were added.`,
          "",
          "You can upload a different file, pick another campaign, or move on to messaging.",
          "",
          "Would you like me to **generate personalized emails** for this campaign next?",
        ].join("\n");
        return JSON.stringify({ status: "success", intent, message, data: toolResult.data });
      }

      // Per-row validation failures from the backend
      if (saved === 0 && rejected.length > 0) {
        const lines = [
          "**No contacts were saved**",
          "",
          "Details:",
          ...rejected.map((r) => {
            const email  = typeof r.email  === "string" && r.email  ? r.email  : "(unknown)";
            const reason = typeof r.reason === "string" && r.reason ? r.reason.replace(/_/g, " ") : "unknown";
            return `- ${email} — ${reason}`;
          }),
          "",
          "Fix the rows or choose another campaign, then try saving again.",
        ];
        return JSON.stringify({
          status: "error",
          intent,
          message: lines.join("\n"),
          data: toolResult.data,
        });
      }

      if (saved === 0) {
        const message =
          "No contacts were saved. Please check that the enriched contacts have valid email addresses.";
        return JSON.stringify({ status: "error", intent, message, data: toolResult.data });
      }

      const lines = [
        "**Recipients saved**",
        "",
        `Added **${saved}** new recipient${saved !== 1 ? "s" : ""} to ${destination}.`,
        ...(skipped > 0
          ? [
              `${skipped} row${skipped !== 1 ? "s" : ""} ${skipped === 1 ? "was" : "were"} skipped (duplicate or invalid).`,
            ]
          : []),
        "",
        "Would you like me to **generate personalized emails** next, or **review campaign stats**?",
        "",
        "You can also **start** or **schedule** the campaign when you're ready to send.",
      ];
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── generate_outreach_template: show generated template ───────────────────
    if (toolName === "generate_outreach_template") {
      const d = unwrapMcpData(toolResult.data);
      const subject   = typeof d.subject === "string" ? d.subject : "";
      const body      = typeof d.body    === "string" ? d.body    : "";
      const variables = Array.isArray(d.variables) ? (d.variables as string[]) : [];
      const tone      = typeof d.tone    === "string" ? d.tone    : "friendly";
      const msg = [
        `**Outreach template generated (tone: ${tone}):**`,
        "",
        `**Subject:** ${subject}`,
        "",
        "```",
        body,
        "```",
        "",
        `Variables to personalise: ${variables.map((v) => `{{${v}}}`).join(", ")}`,
        "",
        "Reply **yes** to use this template, or describe changes you'd like.",
      ].join("\n");
      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    // ── save_csv_recipients: confirm save result ──────────────────────────────
    if (toolName === "save_csv_recipients") {
      const d = unwrapMcpData(toolResult.data);
      const added    = typeof d.added    === "number" ? d.added    : 0;
      const rejected = typeof d.rejected === "number" ? d.rejected : 0;
      const lines = [
        `**${added} recipient${added !== 1 ? "s" : ""} added successfully!**`,
        ...(rejected > 0 ? [`${rejected} row${rejected !== 1 ? "s" : ""} were skipped (invalid or duplicate).`] : []),
        "",
        "What would you like to do next?",
        "- **Generate personalized emails** — AI writes a unique email per recipient",
        "- **Start campaign** — begin sending immediately",
        "- **Schedule campaign** — set a send date and time",
      ];
      const msg = lines.join("\n");
      return JSON.stringify({ status: "success", intent, message: msg, data: toolResult.data });
    }

    // ── validate_email: show validation result ────────────────────────────────
    if (toolName === "validate_email") {
      const d            = unwrapMcpData(toolResult.data);
      const email        = typeof d.email        === "string"  ? d.email        : "unknown";
      const isValid      = d.isValid      === true;
      const businessEmail = d.businessEmail === true;
      const disposable   = d.disposable   === true;
      const domain       = typeof d.domain       === "string"  ? d.domain       : null;
      const source       = typeof d.source       === "string"  ? d.source       : "heuristic";
      const reason       = typeof d.reason       === "string"  ? d.reason       : undefined;

      const statusIcon = isValid ? "✅" : "❌";
      const typeLabel  = disposable
        ? "Disposable / temporary"
        : businessEmail
        ? "Business email"
        : "Personal / free email";

      const lines = [
        `${statusIcon} **${email}**`,
        "",
        `- **Valid:** ${isValid ? "Yes" : "No"}`,
        `- **Type:** ${typeLabel}`,
        ...(domain    ? [`- **Domain:** ${domain}`]      : []),
        ...(reason    ? [`- **Reason:** ${reason}`]      : []),
        `- **Source:** ${source}`,
      ];
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── extract_domain: show extracted domain ─────────────────────────────────
    if (toolName === "extract_domain") {
      const d          = unwrapMcpData(toolResult.data);
      const domain     = typeof d.domain     === "string" ? d.domain     : "unknown";
      const tld        = typeof d.tld        === "string" ? d.tld        : "";
      const subdomain  = typeof d.subdomain  === "string" ? d.subdomain  : undefined;
      const isPersonal = d.isPersonal === true;
      const website    = typeof d.website    === "string" ? d.website    : `https://${domain}`;

      const lines = [
        `**Domain:** ${domain}`,
        `- **TLD:** .${tld}`,
        ...(subdomain  ? [`- **Subdomain:** ${subdomain}`]              : []),
        `- **Personal provider:** ${isPersonal ? "Yes" : "No"}`,
        `- **Website:** ${website}`,
      ];
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── fetch_website_content: clean structured summary ─────────────────────
    if (toolName === "fetch_website_content") {
      const d             = unwrapMcpData(toolResult.data);
      const url           = typeof d.url           === "string" ? d.url           : "";
      const content       = typeof d.content       === "string" ? d.content       : "";
      const contentLength = typeof d.contentLength === "number" ? d.contentLength : content.length;
      const source        = typeof d.source        === "string" ? d.source        : "jina";
      const fallbackUsed  = d.fallbackUsed === true;

      const provider = source === "firecrawl" ? "Firecrawl" : "Jina Reader";
      const domain   = (() => { try { return new URL(url).hostname; } catch { return url; } })();

      const { summary, focusAreas } = extractWebsiteSummary(content);

      const lines = [
        `**Website content fetched**`,
        ``,
        `**Website:** ${domain}`,
        `**Source:** ${url}`,
        `**Provider:** ${provider}${fallbackUsed ? " (fallback)" : ""}`,
        `**Content extracted:** ${contentLength.toLocaleString()} chars`,
        ``,
        `**Summary:**`,
        summary || "No summary available.",
        ``,
        `**Detected focus areas:**`,
        ...focusAreas.map((a) => `- ${a}`),
        ``,
        `**Next steps:** Use *Fetch website content* for more pages, or ask me to enrich contacts from this domain.`,
      ];
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── search_company_web: list candidate websites ───────────────────────────
    if (toolName === "search_company_web") {
      const d           = unwrapMcpData(toolResult.data);
      const companyName = typeof d.companyName === "string" ? d.companyName : "the company";
      const source      = typeof d.source      === "string" ? d.source      : "no_results";
      const candidates  = Array.isArray(d.candidates) ? (d.candidates as Array<Record<string, unknown>>) : [];

      // ── Rate-limited by DuckDuckGo ──────────────────────────────────────────
      if (source === "rate_limited") {
        return JSON.stringify({
          status: "success", intent, data: toolResult.data,
          message: [
            "**Public search is temporarily rate-limited.**",
            "",
            "DuckDuckGo blocked the automated request because too many searches were made too quickly.",
            "",
            "Please retry after a short pause, or provide the company website directly if you already have it.",
          ].join("\n"),
        });
      }

      // ── Request timed out ───────────────────────────────────────────────────
      if (source === "timeout") {
        return JSON.stringify({
          status: "success", intent, data: toolResult.data,
          message: "**Public search timed out.** Please try again.",
        });
      }

      // ── Unexpected search error ─────────────────────────────────────────────
      if (source === "search_failed") {
        return JSON.stringify({
          status: "success", intent, data: toolResult.data,
          message: "**Public search could not be completed.** Please retry or provide a website URL directly.",
        });
      }

      // ── DDG returned no usable candidates ──────────────────────────────────
      if (source === "no_results" || candidates.length === 0) {
        return JSON.stringify({
          status: "success", intent, data: toolResult.data,
          message: [
            `No website candidates were found for **${companyName}**.`,
            "",
            "You can try:",
            "- A different spelling of the company name",
            "- Adding the country (e.g. *Find official website of Acme Corp Pakistan*)",
            "- Use *Verify company website* if you already have a URL to check",
          ].join("\n"),
        });
      }

      // ── DuckDuckGo returned real candidates ─────────────────────────────────
      const lines: string[] = [
        `**Website candidates found**`,
        "",
        `Company: **${companyName}**`,
        `Source: DuckDuckGo`,
        `Candidates reviewed: ${candidates.length}`,
        "",
        "**Best candidates:**",
        ...candidates.slice(0, 6).map((c, i) => {
          const title   = typeof c.title   === "string" ? c.title   : "";
          const url     = typeof c.url     === "string" ? c.url     : "";
          const snippet = typeof c.snippet === "string" ? c.snippet.slice(0, 120) : "";
          return `${i + 1}. **${title || url}**\n   ${url}${snippet ? `\n   *${snippet}*` : ""}`;
        }),
        "",
        "**Recommended next step:**",
        "Verify the best website using *Verify company website*, or use *Select official website* to score and rank the candidates.",
      ];

      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── select_official_website: show ranked candidates + winner ─────────────
    if (toolName === "select_official_website") {
      const d            = unwrapMcpData(toolResult.data);
      const companyName  = typeof d.companyName   === "string"  ? d.companyName   : "the company";
      const selectionMade = d.selectionMade === true;
      const selected      = d.selected as Record<string, unknown> | null ?? null;
      const all           = Array.isArray(d.allCandidates) ? (d.allCandidates as Array<Record<string, unknown>>) : [];

      const lines: string[] = [];

      if (selectionMade && selected) {
        const selUrl   = typeof selected.url   === "string" ? selected.url   : "";
        const selScore = typeof selected.score === "number" ? selected.score : 0;
        lines.push(`**Official website selected for ${companyName}**`, "");
        lines.push(`**Best match:** ${selUrl} *(score: ${selScore}/100)*`, "");
      } else {
        lines.push(`**No confident match found for ${companyName}**`, "");
        lines.push("None of the candidates scored above the selection threshold.", "");
      }

      if (all.length > 0) {
        lines.push("**All candidates ranked:**");
        for (const c of all.slice(0, 5)) {
          const url   = typeof c.url   === "string" ? c.url   : "";
          const score = typeof c.score === "number" ? c.score : 0;
          const mark  = c.selected === true ? "✅" : "  ";
          lines.push(`${mark} ${url} *(${score}/100)*`);
        }
        lines.push("");
      }

      lines.push("**Next steps:** Use *Verify company website* to confirm the selected URL, or *Fetch website content* to read its content.");
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── verify_company_website: show verification result ─────────────────────
    if (toolName === "verify_company_website") {
      const d          = unwrapMcpData(toolResult.data);
      const url        = typeof d.url        === "string"  ? d.url        : "";
      const verified   = d.verified   === true;
      const confidence = typeof d.confidence === "number"  ? d.confidence : 0;
      const signals    = Array.isArray(d.signals)  ? (d.signals  as string[]) : [];
      const warnings   = Array.isArray(d.warnings) ? (d.warnings as string[]) : [];

      const icon  = verified ? "✅" : "⚠️";
      const label = verified ? "Verified" : "Not verified";

      const lines = [
        `${icon} **${label}** — ${url}`,
        "",
        `- **Confidence:** ${confidence}/100`,
        ...(signals.length  > 0 ? ["", "**Positive signals:**", ...signals.map((s) => `- ${s}`)]  : []),
        ...(warnings.length > 0 ? ["", "**Warnings:**",         ...warnings.map((w) => `- ⚠️ ${w}`)] : []),
        "",
        verified
          ? "**Next steps:** Use *Fetch website content* to read this page, or *Enrich domain* to gather company data."
          : "**Next steps:** Try *Search company website* to find better candidates.",
      ];
      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── extract_company_profile: compact company intelligence report ─────────
    if (toolName === "extract_company_profile") {
      const d = unwrapMcpData(toolResult.data);
      const company       = typeof d.companyName       === "string"  ? d.companyName       : "the company";
      const industry      = typeof d.industry          === "string"  ? d.industry          : "Unknown";
      const subIndustry   = typeof d.subIndustry       === "string"  && d.subIndustry ? ` / ${d.subIndustry}` : "";
      const summary       = typeof d.businessSummary   === "string"  ? d.businessSummary   : null;
      const score         = typeof d.score             === "number"  ? d.score             : 0;
      const category      = typeof d.category          === "string"  ? d.category          : "cold";
      const painPoints    = Array.isArray(d.painPoints) ? (d.painPoints as Array<Record<string, unknown>>) : [];
      const primaryAngle  = typeof d.primaryAngle      === "string"  ? d.primaryAngle      : null;
      const emailSubject  = typeof d.emailSubject      === "string"  ? d.emailSubject      : null;
      const emailBody     = typeof d.emailBody         === "string"  ? d.emailBody         : null;
      const scoreReasons  = Array.isArray(d.scoreReasons) ? (d.scoreReasons as string[])  : [];
      const productsServices = Array.isArray(d.productsServices)
        ? (d.productsServices as string[]).filter((x) => typeof x === "string" && x.trim())
        : [];
      const targetCustomersRaw = typeof d.targetCustomers === "string" ? d.targetCustomers : null;

      const categoryLabel = category === "hot" ? "Hot" : category === "warm" ? "Warm" : "Cold";

      const targetBullets: string[] = [];
      if (targetCustomersRaw) {
        const parts = targetCustomersRaw
          .split(/[,;]|\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const top = parts.slice(0, 4);
        for (const p of top) targetBullets.push(`- ${p}`);
      }

      const lines: string[] = [
        "**Company Intelligence Summary**",
        "",
        `**Company:** ${company}`,
        "",
        `**Industry / focus:** ${industry}${subIndustry}`,
      ];

      if (summary) {
        lines.push("", "**Business summary:**", summary);
      }

      if (productsServices.length > 0) {
        lines.push("", "**Products / services:**");
        for (const p of productsServices.slice(0, 5)) {
          lines.push(`- ${p}`);
        }
      }

      if (targetBullets.length > 0) {
        lines.push("", "**Target customers:**");
        lines.push(...targetBullets);
      }

      if (painPoints.length > 0) {
        lines.push("", "**Pain points detected:**");
        for (const pp of painPoints.slice(0, 3)) {
          const title = typeof pp.title === "string" ? pp.title : "";
          const desc  = typeof pp.description === "string" ? pp.description : "";
          const line  = title && desc ? `- ${title}: ${desc}` : title ? `- ${title}` : `- ${desc}`;
          lines.push(line);
        }
      }

      lines.push("", `**Lead score:** ${score}/100 — ${categoryLabel}`);

      if (scoreReasons.length > 0) {
        lines.push("", "**Score reasons:**");
        for (const r of scoreReasons.slice(0, 3)) {
          lines.push(`- ${r}`);
        }
      }

      if (primaryAngle) {
        lines.push("", "**Recommended outreach angle:**", `- ${primaryAngle}`);
      }

      if (emailSubject && emailBody) {
        lines.push(
          "",
          "**Ready-to-send draft:**",
          "",
          `**Subject:** ${emailSubject}`,
          "",
          "**Body:**",
          emailBody,
        );
      }

      const message = lines.filter((l) => l !== "").join("\n");
      const compactData = {
        companyName: company,
        leadScore:   score,
        category,
      };
      return JSON.stringify({ status: "success", intent, message, data: compactData });
    }

    // ── detect_pain_points: pain-point breakdown ──────────────────────────────
    if (toolName === "detect_pain_points") {
      const d          = unwrapMcpData(toolResult.data);
      const painPoints = Array.isArray(d.painPoints) ? (d.painPoints as Array<Record<string, unknown>>) : [];
      const aiGen      = d.aiGenerated === true;

      if (painPoints.length === 0) {
        return JSON.stringify({
          status:  "success",
          intent,
          message: "No pain points detected. The website content may be too short or generic for analysis.",
          data:    toolResult.data,
        });
      }

      const lines: string[] = [
        `**${painPoints.length} Pain Point${painPoints.length !== 1 ? "s" : ""} Detected**`,
        aiGen ? "" : "*(heuristic analysis — configure OPENAI_API_KEY for AI-powered detection)*",
        "",
      ];

      for (const pp of painPoints) {
        const title = typeof pp.title       === "string" ? pp.title       : "";
        const desc  = typeof pp.description === "string" ? pp.description : "";
        const conf  = typeof pp.confidence  === "string" ? ` *(${pp.confidence} confidence)*` : "";
        lines.push(`**${title}**${conf}`, desc, "");
      }

      lines.push("**Next steps:** Say *generate outreach email* to create a personalised draft using these pain points.");

      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // ── generate_outreach_draft: outreach email draft ─────────────────────────
    if (toolName === "generate_outreach_draft") {
      const d                 = unwrapMcpData(toolResult.data);
      const subject           = typeof d.subject   === "string" ? d.subject   : "";
      const emailBody         = typeof d.emailBody === "string" ? d.emailBody : "";
      const tone              = typeof d.tone      === "string" ? d.tone      : "professional";
      const aiGen             = d.aiGenerated === true;
      const personalization   = Array.isArray(d.personalizationUsed) ? (d.personalizationUsed as string[]) : [];

      const aiNote = aiGen ? "" : " *(generic template — configure OPENAI_API_KEY for AI-personalised drafts)*";

      const lines: string[] = [
        `**Outreach Draft Generated** (tone: ${tone})${aiNote}`,
        "",
        `**Subject:** ${subject}`,
        "",
        "```",
        emailBody,
        "```",
        ...(personalization.length > 0 ? ["", `**Personalization used:** ${personalization.join(", ")}`] : []),
        "",
        "Would you like to use this draft? You can:",
        "- **Copy it** directly from the chat",
        "- **Adjust the tone** — say *regenerate with [formal / friendly / executive] tone*",
        "- **Create a campaign** with this content — say *create campaign* to start",
      ];

      return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
    }

    // Wrap successful tool data in a normalised SuccessResult envelope so
    // callers always receive { status, intent, message, data } and never a
    // raw tool-specific payload whose "status" field leaks through (e.g.
    // MailFlow API returning status:"updated" from an update_campaign call).
    return JSON.stringify({
      status:  "success",
      intent:  intent ?? "unknown",
      message: buildDetailedMessage(intent, toolResult.data),
      data:    toolResult.data,
    });
  }

  // ── Phase 4 placeholder ────────────────────────────────────────────────────
  const actionLabel = intent
    ? (INTENT_LABELS[intent] ?? intent.replace(/_/g, " "))
    : "complete your request";
  return `Got it — I'll ${actionLabel}. (Tool: ${toolName})`;
}

// ── Phase 2: optional OpenAI enhancement ─────────────────────────────────────

async function maybeEnhanceWithOpenAI(
  state: AgentGraphStateType,
  baseResponse: string,
): Promise<string> {
  // Skip enhancement entirely if OpenAI is not configured
  const openai = getOpenAIService();
  if (!openai) return baseResponse;

  const { intent, error, requiresApproval, toolResult, userMessage } = state;

  // Never enhance error states or approval gates — those responses are
  // functional and must not be reworded by an LLM.
  if (error || requiresApproval) return baseResponse;

  // ── summarize_replies: OpenAI transforms raw reply data into prose ──────────
  if (intent === "summarize_replies" && toolResult && !toolResult.isToolError) {
    // Guard: skip OpenAI only when replies are explicitly empty
    const replyData = toolResult.data as Record<string, unknown> | undefined;
    const replyItems = Array.isArray(replyData?.items) ? replyData.items
                     : Array.isArray(replyData?.data)  ? replyData.data
                     : null; // null = unknown shape → proceed to OpenAI
    const totalCount = typeof replyData?.total        === "number" ? replyData.total
                     : typeof replyData?.totalReplies === "number" ? replyData.totalReplies
                     : null;
    const hasNoReplies =
      (replyItems !== null && replyItems.length === 0) ||
      (totalCount !== null && totalCount === 0);
    if (hasNoReplies) {
      return JSON.stringify({
        status:  "success",
        intent:  "summarize_replies",
        message: "No replies found to summarize for this campaign.",
        data:    toolResult.data,
      });
    }
    try {
      const summary = await openai.summarizeReplies(toolResult.data);
      log.debug({ sessionId: state.sessionId }, "OpenAI summarizeReplies applied");
      // Wrap the prose summary in a structured envelope so the frontend
      // receives a consistent SuccessResult rather than opaque plain text.
      // The data field is preserved so any existing ReplySummaryCard can still render.
      try {
        const base = JSON.parse(baseResponse) as { data?: unknown };
        return JSON.stringify({
          status:  "success",
          intent:  "summarize_replies",
          message: summary,
          data:    base.data ?? toolResult.data,
        });
      } catch {
        return JSON.stringify({
          status:  "success",
          intent:  "summarize_replies",
          message: summary,
          data:    toolResult.data,
        });
      }
    } catch (err) {
      log.warn(
        {
          sessionId: state.sessionId,
          error: err instanceof Error ? err.message : "unknown",
        },
        "OpenAI summarizeReplies failed — using deterministic response",
      );
      return baseResponse;
    }
  }

  // ── fetch_website_content: OpenAI produces a clean structured summary ────────
  if (state.toolName === "fetch_website_content" && toolResult && !toolResult.isToolError) {
    const d       = unwrapMcpData(toolResult.data);
    const url     = typeof d.url     === "string" ? d.url     : "";
    const title   = typeof d.title   === "string" ? d.title   : undefined;
    const content = typeof d.content === "string" ? d.content : "";
    if (url && content) {
      try {
        const aiSummary = await openai.summarizeWebsiteContent(title, url, content);
        const summaryMatch = aiSummary.match(/SUMMARY:\s*([\s\S]*?)(?=FOCUS AREAS:|$)/i);
        const focusMatch   = aiSummary.match(/FOCUS AREAS:\s*([\s\S]*?)$/i);

        const summaryText = summaryMatch?.[1]?.trim() ?? "";
        const focusLines  = (focusMatch?.[1] ?? "")
          .split("\n")
          .map((l) => l.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 5);

        if (summaryText) {
          const contentLength = typeof d.contentLength === "number" ? d.contentLength : content.length;
          const source        = typeof d.source === "string" ? d.source : "jina";
          const fallbackUsed  = d.fallbackUsed === true;
          const provider      = source === "firecrawl" ? "Firecrawl" : "Jina Reader";
          const domain        = (() => { try { return new URL(url).hostname; } catch { return url; } })();

          const lines = [
            `**Website content fetched**`,
            ``,
            `**Website:** ${domain}`,
            `**Source:** ${url}`,
            `**Provider:** ${provider}${fallbackUsed ? " (fallback)" : ""}`,
            `**Content extracted:** ${contentLength.toLocaleString()} chars`,
            ``,
            `**Summary:**`,
            summaryText,
            ``,
            `**Detected focus areas:**`,
            ...focusLines.map((a) => `- ${a}`),
            ``,
            `**Next steps:** Use *Fetch website content* for more pages, or ask me to enrich contacts from this domain.`,
          ];

          log.debug({ sessionId: state.sessionId }, "OpenAI summarizeWebsiteContent applied");
          return JSON.stringify({ status: "success", intent, message: lines.join("\n"), data: toolResult.data });
        }
      } catch (err) {
        log.warn(
          { sessionId: state.sessionId, error: err instanceof Error ? err.message : "unknown" },
          "OpenAI summarizeWebsiteContent failed — using deterministic response",
        );
      }
    }
  }

  // ── Data-dense intents: OpenAI rewrites the message into natural language ───
  // Only the `message` field of the structured envelope is enhanced — the
  // `data` field is preserved intact so the frontend can render structured cards.
  if (
    intent &&
    ENHANCE_INTENTS.has(intent) &&
    toolResult &&
    !toolResult.isToolError &&
    userMessage
  ) {
    try {
      // Parse the structured envelope from Phase 1 to extract just the message
      const parsedBase = JSON.parse(baseResponse) as Record<string, unknown>;
      const originalMessage = typeof parsedBase.message === "string" ? parsedBase.message : baseResponse;

      const enhancedMessage = await openai.enhanceResponse(intent, userMessage, originalMessage);

      log.debug(
        { sessionId: state.sessionId, intent },
        "OpenAI enhanceResponse applied (message-only)",
      );

      // Reassemble the envelope with the enhanced message but original data
      return JSON.stringify({ ...parsedBase, message: enhancedMessage });
    } catch {
      // Enhancement is optional — silently fall back to deterministic response
    }
  }

  return baseResponse;
}

// ── Node ──────────────────────────────────────────────────────────────────────

export async function finalResponseNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  log.info(
    {
      sessionId:        state.sessionId,
      userId:           state.userId,
      intent:           state.intent,
      toolName:         state.toolName,
      toolArgs:         state.toolArgs,
      requiresApproval: state.requiresApproval,
      hasError:         !!state.error,
      hasToolResult:    state.toolResult !== undefined,
      toolResultIsError: state.toolResult?.isToolError,
      toolResultData:   state.toolResult?.data,
      planSteps:        state.plan?.length,
      planResultsCount: state.planResults?.length,
      activeCampaignId: state.activeCampaignId,
    },
    "finalResponse: ENTRY STATE",
  );

  const base = buildResponse(state);
  const enhanced = await maybeEnhanceWithOpenAI(state, base);

  const response = maybeAppendResumeSuggestion(state, enhanced);

  log.info(
    {
      sessionId: state.sessionId,
      intent: state.intent,
      requiresApproval: state.requiresApproval,
      hasToolResult: state.toolResult !== undefined,
      llmEnhanced: response !== base,
      responseSnippet: response.slice(0, 200),
    },
    "finalResponse: RESPONSE BUILT",
  );

  // Clear completed locks early for callers/tests that inspect returned state.
  // saveMemory also clears these, but this makes UX/state consistent even before persistence.
  const clearEnrichmentLock =
    state.toolName === "save_enriched_contacts" &&
    state.toolResult &&
    !state.toolResult.isToolError &&
    state.activeWorkflowLock?.type === "enrichment";

  const clearPhase3Lock =
    PHASE3_INTENTS.has(state.intent ?? "") &&
    state.toolResult &&
    !state.toolResult.isToolError &&
    state.activeWorkflowLock?.type === "phase3" &&
    !state.pendingPhase3EnrichmentAction &&
    (!Array.isArray(state.pendingPhase3ToolQueue) || state.pendingPhase3ToolQueue.length === 0);

  return {
    finalResponse: response,
    activeWorkflowLock: clearEnrichmentLock || clearPhase3Lock ? undefined : state.activeWorkflowLock,
    workflowStack: state.workflowStack,
  };
}

function maybeAppendResumeSuggestion(state: AgentGraphStateType, response: string): string {
  if (
    !state.intent ||
    !PHASE3_INTENTS.has(state.intent) ||
    state.error ||
    state.requiresApproval ||
    !state.toolResult ||
    state.toolResult.isToolError
  ) {
    return response;
  }

  const last = Array.isArray(state.workflowStack) ? state.workflowStack[state.workflowStack.length - 1] : undefined;
  if (!last || last.type !== "enrichment") return response;

  const cta = "Would you like to return to your previous enrichment workflow? Say **resume** to pick up where you left off.";

  // Prefer appending inside structured JSON envelopes when present.
  try {
    const parsed = JSON.parse(response) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") {
      return JSON.stringify({ ...parsed, message: `${parsed.message}\n\n${cta}` });
    }
  } catch {
    // not JSON
  }

  return `${response}\n\n${cta}`;
}
