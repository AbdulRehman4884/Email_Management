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
export function normalizeCommonTypos(message: string): string {
  return message
    .replace(/\bshwo\b/gi, "show").replace(/\bpasued\b/gi, "paused")
    .replace(/\bcampaings\b/gi, "campaigns").replace(/\bemals\b/gi, "emails")
    .replace(/\bstatistcs\b/gi, "statistics").replace(/\bstatisitcs\b/gi, "statistics")
    // Small, explicit command vocabulary for the tested Spanish and Urdu phrases.
    .replace(/mu[eé]strame/gi, "show me").replace(/campa[ñn]as/gi, "campaigns").replace(/pausadas/gi, "paused")
    // The QA transcript was saved with these two prompts already mojibaked.
    .replace(/muÃ©strame/gi, "show me").replace(/campaÃ±as/gi, "campaigns")
    .replace(/میری/g, "my").replace(/میرے/g, "my").replace(/رکی ہوئی/g, "paused")
    .replace(/کمپینز|کیمپینز|کیمپین|کمپین/g, "campaigns").replace(/دکھاؤ|دکھاؤ/g, "show")
    .replace(/کتنے|کتنی/g, "how many")
    .replace(/Ù…ÛŒØ±ÛŒ|Ù…ÛŒØ±Û’/g, "my").replace(/Ø±Ú©ÛŒ ÛÙˆØ¦ÛŒ/g, "paused")
    .replace(/Ú©Ù…Ù¾ÛŒÙ†Ø²|Ú©ÛŒÙ…Ù¾ÛŒÙ†/g, "campaigns").replace(/Ø¯Ú©Ú¾Ø§Ø¤/g, "show")
    .replace(/Ú©ØªÙ†Û’/g, "how many");
}

const COUNT_CAMPAIGNS_RE = /\b(?:how many|kitn[aei])\s+(?:\w+\s+){0,3}campaigns?\b|\b(?:how many|kitn[aei])\s+campaigns?\s+(?:are\s+)?(?:paused|on hold|stopped|finished|completed|draft|running|active)\b/i;

export function isAccountLevelQuestion(message: string): boolean {
  message = normalizeCommonTypos(message);
  if (/\bhow many\s+emails?\s+did\s+i\s+(?:send|sent)\b/i.test(message)) return true;
  if (!message || ONE_CAMPAIGN_RE.test(message)) return false;
  return (ACROSS_RE.test(message) && METRIC_RE.test(message)) || COUNT_CAMPAIGNS_RE.test(message);
}

/** Words users say → backend campaign status. */
const STATUS_WORDS: Array<[RegExp, string, string]> = [
  [/\bdrafts?\b/i, "draft", "draft"],
  [/\b(paused|on\s+hold|stopped)\b/i, "paused", "paused"],
  [/\b(completed|finished|done)\b/i, "completed", "completed"],
  [/\b(running|active|in progress|sending)\b/i, "in_progress", "running"],
  [/\bscheduled\b/i, "scheduled", "scheduled"],
];

const STATUS_LABEL: Record<string, string> = { in_progress: "running" };

/**
 * "Show completed campaigns only" / "list my draft campaigns" → the status to keep
 * (bug A-19). Campaign lists from the MCP tool use "running" for in-progress.
 * Undefined when the message names no status.
 */
export function campaignStatusFilter(message: string): { status: string; label: string } | undefined {
  message = normalizeCommonTypos(message);
  if (!message || !/\bcampaigns?\b|\bonly\b/i.test(message)) return undefined;
  const hit = STATUS_WORDS.find(([re]) => re.test(message));
  if (!hit) return undefined;
  const [, status, label] = hit;
  return { status: status === "in_progress" ? "running" : status, label };
}

/** Keeps the campaigns with the asked status ("running" also matches "in_progress"). */
export function filterCampaignsByStatus<T extends { status: string }>(campaigns: T[], status: string): T[] {
  return campaigns.filter((c) => {
    const s = c.status.toLowerCase();
    return s === status || (status === "running" && s === "in_progress");
  });
}

function pct(rate: unknown): string {
  return typeof rate === "number" ? ` (${(rate * 100).toFixed(1)}%)` : "";
}

export function formatAccountStatsMessage(data: Record<string, unknown>, userMessage: string): string {
  userMessage = normalizeCommonTypos(userMessage);
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
    `**Clicked:** ${CLICKS_NOT_TRACKED}`,
  );
  return lines.join("\n");
}

/**
 * MailFlow does not record link clicks in campaign emails (the backend has no click tracking; every
 * campaign's "clicked" is 0). Said plainly instead of a missing line or a fake 0% (QA P4 bug 3).
 */
export const CLICKS_NOT_TRACKED = "not tracked yet (MailFlow does not record link clicks in emails)";

/** "What is my click rate?", "click-through rate", "how many clicks". */
export function isClickQuestion(message: string): boolean {
  return /\bclick(s|ed|[\s-]?(through|thru))?(\s*rates?)?\b|\bctr\b/i.test(message);
}

/** The click-rate answer: not tracked, with the account's real open and reply rates instead. */
export function clickRateAnswer(data: Record<string, unknown>): string {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return [
    "MailFlow does not track link clicks in your emails yet, so there is no click rate to show.",
    "",
    "What is tracked across your campaigns:",
    `**Opened:** ${num(data.opened).toLocaleString()} of ${num(data.sent).toLocaleString()} sent${pct(data.openRate)}`,
    `**Replied:** ${num(data.replied).toLocaleString()}${pct(data.replyRate)}`,
  ].join("\n");
}
