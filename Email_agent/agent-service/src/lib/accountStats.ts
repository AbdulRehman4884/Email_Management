/**
 * src/lib/accountStats.ts
 *
 * Account-level questions (bug A-05): "total emails sent across all my campaigns",
 * "my overall open rate", "how many draft campaigns do I have?". These used to ask
 * "which campaign?" or dump the campaign list; now they go to get_account_stats.
 */

/** A specific campaign is meant ("#20", "campaign 20", "campaign id 20"). */
const ONE_CAMPAIGN_RE = /#\d+|\bcampaign\s+(?:id\s*)?\d+\b/i;
const ACROSS_RE = /\b(across|overall|total|in total|all (?:of )?my|all campaigns|every campaign|my account|account[- ]wide|sab|saari|sari|tamam)\b/i;
const METRIC_RE = /\b(sent|emails?|opens?|opened|open rate|reply rate|replied|replies|bounces?|bounced|delivered|analytics|stats|statistics|performance|metrics)\b/i;
/** "how many campaigns", "how many draft campaigns", "kitni draft campaigns". */
const COUNT_CAMPAIGNS_RE = /\b(?:how many|kitn[aei])\s+(?:\w+\s+){0,2}campaigns\b/i;

export function isAccountLevelQuestion(message: string): boolean {
  if (!message || ONE_CAMPAIGN_RE.test(message)) return false;
  return (ACROSS_RE.test(message) && METRIC_RE.test(message)) || COUNT_CAMPAIGNS_RE.test(message);
}

/** Words users say → backend campaign status. */
const STATUS_WORDS: Array<[RegExp, string, string]> = [
  [/\bdrafts?\b/i, "draft", "draft"],
  [/\bpaused\b/i, "paused", "paused"],
  [/\b(completed|finished|done)\b/i, "completed", "completed"],
  [/\b(running|active|in progress|sending)\b/i, "in_progress", "running"],
  [/\bscheduled\b/i, "scheduled", "scheduled"],
];

const STATUS_LABEL: Record<string, string> = { in_progress: "running" };

function pct(rate: unknown): string {
  return typeof rate === "number" ? ` (${(rate * 100).toFixed(1)}%)` : "";
}

export function formatAccountStatsMessage(data: Record<string, unknown>, userMessage: string): string {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const byStatus = data.campaignsByStatus && typeof data.campaignsByStatus === "object"
    ? (data.campaignsByStatus as Record<string, number>)
    : {};
  const total = num(data.totalCampaigns);
  const lines: string[] = [];

  // "How many draft campaigns do I have?" → answer that first.
  const asked = COUNT_CAMPAIGNS_RE.test(userMessage)
    ? STATUS_WORDS.find(([re]) => re.test(userMessage))
    : undefined;
  if (asked) {
    const [, status, label] = asked;
    const n = byStatus[status] ?? 0;
    lines.push(`You have **${n} ${label} ${n === 1 ? "campaign" : "campaigns"}** (out of ${total}).`, "");
  } else if (COUNT_CAMPAIGNS_RE.test(userMessage)) {
    lines.push(`You have **${total} ${total === 1 ? "campaign" : "campaigns"}**.`, "");
  }

  const statusParts = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${STATUS_LABEL[s] ?? s}`);
  lines.push(`Across all your **${total} campaigns**${statusParts.length ? ` (${statusParts.join(" · ")})` : ""}:`, "");
  lines.push(
    `**Emails sent:** ${num(data.sent).toLocaleString()}`,
    `**Delivered:** ${num(data.delivered).toLocaleString()}`,
    `**Opened:** ${num(data.opened).toLocaleString()}${pct(data.openRate)}`,
    `**Replied:** ${num(data.replied).toLocaleString()}${pct(data.replyRate)}`,
    `**Bounced:** ${num(data.bounced).toLocaleString()}${pct(data.bounceRate)}`,
  );
  return lines.join("\n");
}
