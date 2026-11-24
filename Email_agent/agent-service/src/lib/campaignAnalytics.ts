/**
 * src/lib/campaignAnalytics.ts
 *
 * Analytics questions about SEVERAL campaigns at once, answered from real numbers:
 *   "Show stats for campaigns 434 and 431", "Compare DRY RUN and Campaign 3".
 * The planner used to split these into two get_campaign_stats steps without campaign ids, so
 * both steps got the session's campaign and showed the SAME numbers (QA bug: two steps, both
 * "Sent 2, opened 1"); in a fresh chat it asked "which campaign?"; "Compare …" got the generic menu.
 */

import { mcpClientService } from "../services/mcpClient.service.js";
import { authFromState, type CampaignRef } from "./campaignLookup.js";
import type { AuthContext } from "../types/common.js";
import { clickRateAnswer, isClickQuestion } from "./accountStats.js";
import { smtpAccounts } from "./campaignEdits.js";

/** "What is my click rate?" (no campaign named) → clicks are not tracked; the real open / reply rates. */
export async function accountClickAnswer(state: { rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  try {
    const r = await mcpClientService.dispatch("get_account_stats", {}, auth);
    const env = r.data as { success?: boolean; data?: Record<string, unknown> } | undefined;
    if (r.isToolError || env?.success === false) return undefined;
    return clickRateAnswer((env?.data ?? env ?? {}) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

const STATS_WORD = /\b(stats?|statistics|analytics|performance|numbers|results?|report|open rates?|reply rates?)\b/i;
const COMPARE_WORD = /\b(compare|comparison|vs\.?|versus|muqabla|muqabala)\b/i;
const JOIN_WORD = /\s(?:and|aur|&|or)\s|,/i;
const MAX_CAMPAIGNS = 5;

/** "compare A and B" or "stats for campaigns 434 and 431": a request about two or more campaigns. */
export function isMultiCampaignStatsRequest(message: string): boolean {
  if (!message || !JOIN_WORD.test(message) && !/\bvs\.?\b|\bversus\b/i.test(message)) return false;
  if (COMPARE_WORD.test(message)) return true;
  if (!STATS_WORD.test(message)) return false;
  // "stats for 434 and 431" / "campaigns 434, 431" / "ids 434 and 431"
  return (message.match(/\b\d{1,9}\b/g) ?? []).length >= 2 || /\bcampaigns\b/i.test(message);
}

/**
 * Strict form used for ROUTING (detectIntent, planner): "compare …" or stats for two numbers.
 * Whether real campaigns are named is checked later against the user's list.
 */
export function looksLikeCampaignComparison(message: string): boolean {
  if (!message) return false;
  if (COMPARE_WORD.test(message) && (JOIN_WORD.test(message) || /\bvs\.?\b|\bversus\b/i.test(message))) return true;
  return STATS_WORD.test(message) && JOIN_WORD.test(message) && (message.match(/\b\d{1,9}\b/g) ?? []).length >= 2;
}

const norm = (s: string) => s.toLowerCase().replace(/["'“”‘’]/g, "").replace(/\s+/g, " ").trim();

/**
 * The campaigns a message names, in the order they appear. Names first (longest first, so
 * "Campaign 3" is a name, not id 3); then ids in what is left ("434 and 431", "#434").
 */
export function campaignsInMessage(message: string, all: CampaignRef[], opts: { namesOnly?: boolean } = {}): CampaignRef[] {
  let rest = ` ${norm(message)} `;
  const found: Array<{ at: number; c: CampaignRef }> = [];
  const byLength = [...all].filter((c) => norm(c.name).length >= 2).sort((a, b) => norm(b.name).length - norm(a.name).length);
  const taken = new Set<string>();
  for (const c of byLength) {
    const name = norm(c.name);
    const re = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^a-z0-9]|$)`, "i");
    const m = rest.match(re);
    if (!m || m.index === undefined) continue;
    // Several campaigns share a name ("ok"): the name alone can't say which — skip it here.
    if (all.filter((o) => norm(o.name) === name).length > 1) continue;
    if (taken.has(c.id)) continue;
    taken.add(c.id);
    found.push({ at: m.index, c });
    rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  // Dates and times ("31 December 2026 at 10") are not campaign ids: callers with such text use namesOnly.
  for (const m of opts.namesOnly ? [] : rest.matchAll(/\b(\d{1,9})\b/g)) {
    const c = all.find((x) => x.id === m[1]);
    if (c && !taken.has(c.id)) {
      taken.add(c.id);
      found.push({ at: m.index ?? 0, c });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.c);
}

interface Stats {
  sent: number;
  delivered?: number | undefined;
  opened: number;
  openRate?: number | undefined;
  replied?: number | undefined;
  replyRate?: number | undefined;
  bounced?: number | undefined;
}

function unwrap(data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  return d.data && typeof d.data === "object" && !Array.isArray(d.data) ? (d.data as Record<string, unknown>) : d;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pct = (r: number | undefined) => (r === undefined ? "" : ` (${(r * 100).toFixed(1)}%)`);

export type CampaignRow = CampaignRef & {
  createdAt?: string;
  scheduledAt?: string;
  pauseReason?: string;
  dailySendLimit?: number;
  recipientCount?: number;
  fromEmail?: string;
  smtpSettingsId?: number;
};

/** The user's campaigns (id, name, status, dates, pause reason …), or undefined when they can't be read. */
export async function listUserCampaigns(state: { rawToken?: string | undefined; userId?: unknown }): Promise<CampaignRow[] | undefined> {
  const auth = authFromState(state);
  return auth ? listCampaigns(auth) : undefined;
}

async function listCampaigns(auth: AuthContext): Promise<CampaignRow[] | undefined> {
  try {
    const r = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = r.data as { success?: boolean; data?: unknown } | undefined;
    if (r.isToolError || env?.success === false || !Array.isArray(env?.data)) return undefined;
    return (env.data as Array<Record<string, unknown>>)
      .filter((c) => c.id !== undefined && typeof c.name === "string")
      .map((c) => ({
        id: String(c.id),
        name: String(c.name),
        status: typeof c.status === "string" ? c.status : "unknown",
        ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
        ...(typeof c.scheduledAt === "string" && c.scheduledAt ? { scheduledAt: c.scheduledAt } : {}),
        ...(typeof c.pauseReason === "string" && c.pauseReason ? { pauseReason: c.pauseReason } : {}),
        ...(typeof c.dailySendLimit === "number" ? { dailySendLimit: c.dailySendLimit } : {}),
        ...(typeof c.recipientCount === "number" ? { recipientCount: c.recipientCount } : {}),
        ...(typeof c.fromEmail === "string" && c.fromEmail ? { fromEmail: c.fromEmail } : {}),
        ...(typeof c.smtpSettingsId === "number" ? { smtpSettingsId: c.smtpSettingsId } : {}),
      }));
  } catch {
    return undefined;
  }
}

async function statsOf(campaignId: string, auth: AuthContext): Promise<Stats | undefined> {
  try {
    const r = await mcpClientService.dispatch("get_campaign_stats", { campaignId }, auth);
    const env = r.data as { success?: boolean } | undefined;
    if (r.isToolError || env?.success === false) return undefined;
    const d = unwrap(r.data);
    return {
      sent: num(d.sent) ?? 0,
      delivered: num(d.delivered),
      opened: num(d.opened) ?? 0,
      openRate: num(d.openRate),
      replied: num(d.replied),
      replyRate: num(d.replyRate),
      bounced: num(d.bounced),
    };
  } catch {
    return undefined;
  }
}

function statsLine(s: Stats): string {
  return [
    `Sent ${s.sent.toLocaleString()}`,
    ...(s.delivered !== undefined ? [`Delivered ${s.delivered.toLocaleString()}`] : []),
    `Opened ${s.opened.toLocaleString()}${pct(s.openRate)}`,
    ...(s.replied !== undefined ? [`Replied ${s.replied.toLocaleString()}${pct(s.replyRate)}`] : []),
    ...(s.bounced !== undefined ? [`Bounced ${s.bounced.toLocaleString()}`] : []),
  ].join(" · ");
}

/** "**DRY RUN** has the better open rate (50.0% vs 0.0%) and more replies (2 vs 0)." — only from the numbers. */
function verdict(rows: Array<{ c: CampaignRef; s: Stats }>): string {
  const sentRows = rows.filter((r) => r.s.sent > 0);
  if (sentRows.length < 2) return "There is not enough sent mail in these campaigns to say which one did better.";
  const rate = (r: { s: Stats }) => r.s.openRate ?? (r.s.sent ? r.s.opened / r.s.sent : 0);
  const byOpen = [...sentRows].sort((a, b) => rate(b) - rate(a));
  const parts = [
    rate(byOpen[0]!) === rate(byOpen[1]!)
      ? `The open rates are the same (${(rate(byOpen[0]!) * 100).toFixed(1)}%).`
      : `**${byOpen[0]!.c.name}** has the best open rate (${byOpen.map((r) => `${(rate(r) * 100).toFixed(1)}%`).join(" vs ")}).`,
  ];
  if (sentRows.every((r) => r.s.replied !== undefined)) {
    const byReplies = [...sentRows].sort((a, b) => (b.s.replied ?? 0) - (a.s.replied ?? 0));
    parts.push(
      byReplies[0]!.s.replied === byReplies[1]!.s.replied
        ? `They have the same number of replies (${byReplies[0]!.s.replied}).`
        : `**${byReplies[0]!.c.name}** got the most replies (${byReplies.map((r) => r.s.replied).join(" vs ")}).`,
    );
  }
  return parts.join(" ");
}

/**
 * The answer for a several-campaigns stats question, or undefined when the message does not
 * name at least two of the user's campaigns (the caller then keeps its normal path).
 */
export async function multiCampaignStatsAnswer(state: {
  userMessage: string;
  rawToken?: string | undefined;
  userId?: unknown;
}): Promise<string | undefined> {
  if (!isMultiCampaignStatsRequest(state.userMessage)) return undefined;
  const auth = authFromState(state);
  if (!auth) return undefined;
  const all = await listCampaigns(auth);
  if (!all) return undefined;
  const picked = campaignsInMessage(state.userMessage, all);
  if (picked.length < 2) return undefined;
  const shown = picked.slice(0, MAX_CAMPAIGNS);
  const stats = await Promise.all(shown.map((c) => statsOf(c.id, auth)));
  const rows = shown.flatMap((c, i) => (stats[i] ? [{ c, s: stats[i]! }] : []));
  const missing = shown.filter((_, i) => !stats[i]);

  const lines = [`Here are the statistics for **${shown.length} campaigns**:`, ""];
  for (const r of rows) lines.push(`**${r.c.name}** (#${r.c.id}, ${r.c.status})`, statsLine(r.s), "");
  for (const c of missing) lines.push(`**${c.name}** (#${c.id}): I couldn't read its statistics right now.`, "");
  if (rows.length >= 2) lines.push(verdict(rows));
  if (picked.length > MAX_CAMPAIGNS) lines.push("", `I showed the first ${MAX_CAMPAIGNS}; ask again for the others.`);
  return lines.join("\n").trim();
}

// ── One-question analytics: overview, ranking, newest campaign, a time period ──────────────────────
//
// QA bugs: "how are my campaigns doing?" asked "which campaign?" and forgot its own question;
// "Which campaign has the best open rate?" looked for a campaign NAMED "has the best open rate";
// "the last campaign I created" looked for one named "I created"; "in October" / "this week" were ignored.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\b`, "i");

/** "how are my campaigns doing?", "why is my open rate low?", "how can I improve my reply rate?" */
export function isOverviewQuestion(message: string): boolean {
  const m = message.toLowerCase();
  if (/\bhow\s+am\s+i\s+doing\b|\bgive\s+me\s+(?:an?\s+)?(?:quick\s+)?(?:account\s+)?(?:overview|summary)\b/.test(m)) return true;
  if (/\b(how|kaise|kesi|kaisi)\b.*\bcampaigns\b.*\b(doing|performing|going|chal)/.test(m)) return true;
  if (/\bcampaigns\s+(performance|kaisi|kesi)\b/.test(m)) return true;
  return /\b(why|kyun|kyon)\b.*\b(open|reply|click|bounce)\s*rates?\b.*\b(low|high|bad|poor|kam|zyada)\b/.test(m) ||
    /\b(how|kaise)\b.*\b(improve|increase|boost|raise|better|barha\w*)\b.*\b(open|reply|click)\s*rates?\b/.test(m) ||
    // "Give me tips to get more replies", "any advice for better open rates?" (QA P4 bug 26: got the menu)
    /\b(tips?|advice|suggestions?|ideas?|how\s+(?:can|do|to)\s+i?\s*get)\b[^.!?]{0,40}\b(more\s+(?:opens|replies|responses)|(?:open|reply|response)\s*rates?|replies|opens)\b/.test(m);
}

// ── Questions about one campaign's status / dates (QA: "is ALL still running?" became a pause request;
//    "why is campaign 441 paused?" opened a pause approval card; "when was DRY RUN created?" got a menu) ──

/** "is ALL still running?", "why is campaign 441 paused?", "status of DRY RUN", "when was DRY RUN created?" */
/** "Which SMTP account sent Campaign 3?", "what email does DRY RUN send from?" (QA P4 bug 19). */
export function isCampaignSenderQuestion(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(which|what|kaun\s*s[ia]|konsa|konsi)\b[^.!?]{0,40}\b(smtp|email\s+account|sender|sending\s+account|from\s+(?:email|address)|mailbox|inbox|account)\b[^.!?]{0,40}\b(sent|send|sends|sending|used?|uses|for|of|from)\b/.test(m) ||
    /\b(sent|sends|send|sending)\s+from\s+(?:which|what)\b/.test(m) ||
    /\b(?:which|what)\s+(?:email|address)\s+(?:does|did|is)\b[^.!?]{0,60}\b(?:send|sent|sending)\s+from\b/.test(m);
}

export function isCampaignFactQuestion(message: string): boolean {
  const m = message.toLowerCase().trim();
  return (
    // Only about a campaign ("…sent Campaign 3", "#431"); "which SMTP account is my default?" stays a settings question.
    (isCampaignSenderQuestion(message) && /\bcampaigns?\b|#\d+/.test(m)) ||
    /\b(opened|opens?)\b[^.!?]{0,60}\b(didn.t|did not|never|no)\s+repl(?:y|ied)\b|\bwho\s+(?:opened|opens?)\b[^.!?]{0,60}\bwithout\s+(?:a\s+)?repl(?:y|ying)\b/.test(m) ||
    /^(is|are|was|has)\b[^.!]{1,80}\b(still\s+)?(running|active|paused|sending|live|completed|finished|done|scheduled|stopped|started)\b[^.!]*\??$/.test(m) ||
    /\bwhy\b[^.!]{0,80}\b(paused|stopped|not\s+sending|on\s+hold|halted)\b/.test(m) ||
    /\b(status|state)\s+of\b/.test(m) ||
    /\bwhen\s+(was|did|is|will)\b[^.!]{1,80}\b(created|made|started|sent|scheduled|paused|completed|finished|start|send|go\s+out)\b/.test(m) ||
    /\bkab\s+(bani|banai|start|chali|bheji|send|bhej\w*|jaye\w*|hogi|hoga)\b|\bkyun\s+(ruki|paused|rok)\b/.test(m) ||
    // "what is the status of campaign 465?" — a status question about ONE campaign
    /status[^.!?]{0,20}campaign\s+(?:#?\d+|\S+)/.test(m)
  );
}

const PAUSE_REASONS: Record<string, (c: CampaignRow) => string> = {
  daily_campaign_cap: (c) =>
    `it reached its own daily send limit${c.dailySendLimit ? ` of **${c.dailySendLimit}** email${c.dailySendLimit === 1 ? "" : "s"} a day` : ""}. It continues by itself on the next sending day.`,
  smtp_daily_limit: () => "the sending email account reached its daily limit. It continues by itself the next day.",
  send_window_closed: () => "it is outside its sending hours. It continues when the sending window opens again.",
  weekday_filter: () => "today is not one of its sending days. It continues on the next allowed day.",
  duration_break: () => "it is in a planned break between sending periods. It continues by itself after the break.",
  follow_up_hold: () => "its follow-ups are on hold.",
};

const dateOnly = (s?: string) => (s ? s.replace("T", " ").slice(0, 16) : "");

/** The answer about ONE campaign named in the message, or undefined when no single campaign is named. */
export async function campaignFactAnswer(state: {
  userMessage: string;
  rawToken?: string | undefined;
  userId?: unknown;
  activeCampaignId?: string | undefined;
}): Promise<string | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  const all = await listCampaigns(auth);
  if (!all) return undefined;
  const named = campaignsInMessage(state.userMessage, all);
  // "is it still running?" — the campaign the chat is about.
  const id = named.length === 1 ? named[0]!.id
    : named.length === 0 && /\b(it|this|that|this campaign|that campaign)\b/i.test(state.userMessage) ? state.activeCampaignId
    : undefined;
  const c = id ? all.find((x) => x.id === id) : undefined;
  if (!c) return undefined;
  const m = state.userMessage.toLowerCase();
  if (/\b(opened|opens?)\b[^.!?]{0,60}\b(didn.t|did not|never|no)\s+repl(?:y|ied)\b|\bwho\s+(?:opened|opens?)\b[^.!?]{0,60}\bwithout\s+(?:a\s+)?repl(?:y|ying)\b/.test(m)) {
    const stats = await statsOf(c.id, auth);
    if (!stats) return undefined;
    if (stats.opened === 0) return `Nobody in **${c.name}** (#${c.id}) has opened the email yet.`;
    return `**${c.name}** (#${c.id}) has ${stats.opened} opens and ${stats.replied ?? 0} replies. The available data does not identify which individual recipients opened without replying.`;
  }
  const status = c.status.toLowerCase() === "in_progress" ? "running" : c.status.toLowerCase();
  const who = `**${c.name}** (#${c.id})`;
  const pausedWhy = status === "paused"
    ? (c.pauseReason && PAUSE_REASONS[c.pauseReason] ? `It is paused because ${PAUSE_REASONS[c.pauseReason]!(c)}` : "It was paused by hand. Say **resume campaign** to continue it.")
    : "";

  // The email account the campaign sends from — the same From email as the campaign page.
  if (isCampaignSenderQuestion(state.userMessage)) {
    const accounts = await smtpAccounts(state);
    const acc = accounts?.find((a) => a.id === c.smtpSettingsId) ?? accounts?.find((a) => a.fromEmail === c.fromEmail);
    const email = acc?.fromEmail ?? c.fromEmail;
    if (!email) return `I can't see which email account ${who} uses. Open the campaign page to check its From email.`;
    const label = acc?.fromName ? ` (**${acc.fromName}**)` : "";
    const verb = ["completed", "running", "paused"].includes(status) ? "was sent from" : "sends from";
    return `${who} ${verb} **${email}**${label}${acc ? ` — SMTP account #${acc.id}` : ""}.`;
  }

  if (/\bwhen\b|\bkab\b/.test(m)) {
    if (/\b(created|made|bani|banai)\b/.test(m)) return c.createdAt ? `${who} was created on **${dateOnly(c.createdAt)}**.` : `I can't see the creation date of ${who}.`;
    if (/\b(scheduled|send|go\s+out|start)\b/.test(m)) {
      return c.scheduledAt ? `${who} is scheduled for **${dateOnly(c.scheduledAt)}** (status: ${status}).` : `${who} has no scheduled time (status: ${status}).`;
    }
    return `${who} is **${status}**${c.scheduledAt ? `, scheduled for **${dateOnly(c.scheduledAt)}**` : ""}${c.createdAt ? `, created on ${dateOnly(c.createdAt)}` : ""}.`;
  }
  if (/\bwhy\b|\bkyun\b/.test(m)) {
    if (status !== "paused") return `${who} is not paused — it is **${status}**.`;
    return `${who} is **paused**. ${pausedWhy}`.trim();
  }
  const asked = m.match(/\b(running|active|sending|live|paused|stopped|completed|finished|done|scheduled|started)\b/)?.[1];
  const isAsked =
    !asked ? undefined
    : ["running", "active", "sending", "live", "started"].includes(asked) ? status === "running"
    : ["completed", "finished", "done"].includes(asked) ? status === "completed"
    : asked === "stopped" ? status === "paused" || status === "completed"
    : status === asked;
  const when = status === "scheduled" && c.scheduledAt ? ` for **${dateOnly(c.scheduledAt)}**` : "";
  const lead = isAsked === undefined ? `${who} is **${status}**${when}.` : `${isAsked ? "Yes" : "No"} — ${who} is **${status}**${when}.`;
  return [lead, pausedWhy, status === "draft" && c.recipientCount === 0 ? "It has no recipients yet." : ""].filter(Boolean).join(" ");
}

/** List paused campaigns with their real per-campaign delivery stats (bug 29). */
export async function pausedCampaignStatsAnswer(state: { rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  const all = await listCampaigns(auth);
  if (!all) return undefined;
  const paused = all.filter((c) => c.status.toLowerCase() === "paused");
  if (!paused.length) return "You have no paused campaigns.";
  const rows = await Promise.all(paused.map(async (c) => ({ c, s: await statsOf(c.id, auth) })));
  return [
    `Paused campaigns (${rows.length}):`,
    "",
    ...rows.map(({ c, s }) => `- **${c.name}** (#${c.id}) — ${s ? statsLine(s) : "Stats unavailable"}`),
  ].join("\n");
}

/**
 * The intent an analytics question must get, whatever the LLM picked: overview, ranking, a time period,
 * the newest campaign, several campaigns → get_campaign_stats (AnalyticsAgent answers them);
 * "campaigns created this week" → list_campaigns. Undefined = not one of these.
 */
export function analyticsIntentFor(message: string): "get_campaign_stats" | "list_campaigns" | undefined {
  if (!message) return undefined;
  // "What is my click rate?" → the stats agent answers it (it showed the campaign pick list).
  if (isClickQuestion(message)) return "get_campaign_stats";
  if (/\b(?:stats?|numbers?|open\s+rates?|reply\s+rates?|performance)\b/i.test(message) &&
      (/\b(?:campaign|campaigns|for|of|about|ka|ki|ke|did|doing)\b/i.test(message) || /\b(?:dry\s+run|all)\b/i.test(message))) return "get_campaign_stats";
  if (/\bhow\b[^.!?]{0,80}\bcampaign\b[^.!?]{0,40}\bdid\b/i.test(message)) return "get_campaign_stats";
  if (/\b(?:no|sorry),?\s*i\s+meant\b/i.test(message) && /\bcampaign\b/i.test(message)) return "get_campaign_stats";
  if (/\b(?:paused|on\s+hold)\s+campaigns?\b[^.!?]{0,40}\b(stats?|open\s+rates?|sent|opened)\b|\b(?:stats?|open\s+rates?)\b[^.!?]{0,40}\bpaused\s+campaigns?\b/i.test(message)) return "get_campaign_stats";
  if (/\b(?:ka|ki|ke)\s+(?:open|reply)\s+rates?\b|\b(?:ki|ke)\s+(?:stats|statistics|performance)\b/i.test(message)) return "get_campaign_stats";
  if (isCampaignsCreatedInPeriod(message)) return "list_campaigns";
  if (isCampaignFactQuestion(message)) return "get_campaign_stats";
  if (looksLikeCampaignComparison(message) || isOverviewQuestion(message) || rankingMetric(message) || isPeriodStatsQuestion(message)) {
    return "get_campaign_stats";
  }
  if (isNewestCampaignQuestion(message) && /\b(stats?|statistics|performance|open|repl|sent|numbers|results?|how\s+(did|is))\b/i.test(message)) {
    return "get_campaign_stats";
  }
  return undefined;
}

export type RankMetric = "openRate" | "replied" | "replyRate" | "sent" | "bounced";

/** "which campaign has the best open rate?", "most replies", "worst performing campaign". */
export function rankingMetric(message: string): { metric: RankMetric; lowest: boolean } | undefined {
  const m = message.toLowerCase();
  if (!/\bcampaigns?\b/.test(m)) return undefined;
  const top = /\b(best|highest|top|most|max(imum)?)\b|\bsab\s+se\s+(zyada|ziada|acha|achi)\b/.test(m);
  const low = /\b(worst|lowest|least|fewest|min(imum)?)\b|\bsab\s+se\s+kam\b/.test(m);
  if (!top && !low) return undefined;
  const metric: RankMetric =
    /\breply\s*rates?\b/.test(m) ? "replyRate"
    : /\brepl(y|ies|ied)\b|\bresponses?\b/.test(m) ? "replied"
    : /\bbounce/.test(m) ? "bounced"
    : /\bsent\b|\bemails?\b|\bvolume\b/.test(m) && !/\bopen/.test(m) ? "sent"
    : "openRate";
  return { metric, lowest: low && !top };
}

/** "the last campaign I created", "my most recent campaign", "newest campaign". */
export function isNewestCampaignQuestion(message: string): boolean {
  const m = message.toLowerCase();
  return /\b(last|latest|most\s+recent|newest|recent|akhri|aakhri)\b[^.?!]{0,20}\bcampaign\b/.test(m) ||
    /\bcampaign\b[^.?!]{0,15}\b(i|we)\s+(just\s+)?(created|made|added|set\s+up)\b/.test(m);
}

export interface Period { from: Date; to: Date; label: string }

/** "in October", "last month", "this week", "today", "last 7 days" → a time range (local time). */
export function periodIn(message: string, now = new Date()): Period | undefined {
  const m = message.toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today.getTime() + 86_400_000);
  if (/\btoday\b|\baaj\b/.test(m)) return { from: today, to: end, label: "today" };
  if (/\byesterday\b/.test(m)) return { from: new Date(today.getTime() - 86_400_000), to: today, label: "yesterday" };
  const lastN = m.match(/\b(?:last|past|pichl[ae])\s+(\d{1,3})\s+days?\b/);
  if (lastN) return { from: new Date(end.getTime() - Number(lastN[1]) * 86_400_000), to: end, label: `the last ${lastN[1]} days` };
  const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86_400_000);
  if (/\b(this|is)\s+(week|hafte|hafta)\b/.test(m)) return { from: monday, to: end, label: "this week" };
  if (/\b(last|pichl[ae])\s+(week|hafte|hafta)\b/.test(m)) {
    return { from: new Date(monday.getTime() - 7 * 86_400_000), to: monday, label: "last week" };
  }
  if (/\b(this|is)\s+(month|mahine|mahina)\b/.test(m)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: end, label: "this month" };
  }
  if (/\b(last|pichl[ae])\s+(month|mahine|mahina)\b/.test(m)) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { from, to: new Date(now.getFullYear(), now.getMonth(), 1), label: from.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
  }
  const mm = m.match(MONTH_RE);
  // "may" is also a verb ("may I …"): a month only after in/during/for/of or before a year.
  if (mm && (mm[1]!.toLowerCase() !== "may" || /\b(in|during|for|of)\s+may\b|\bmay\s+\d{4}\b/.test(m))) {
    const idx = MONTHS.findIndex((x) => x.startsWith(mm[1]!.toLowerCase().slice(0, 3)));
    const yearMatch = m.match(/\b(20\d{2})\b/);
    // The most recent such month (this year if it has started, else last year).
    const year = yearMatch ? Number(yearMatch[1]) : idx <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1;
    const name = MONTHS[idx]!.charAt(0).toUpperCase() + MONTHS[idx]!.slice(1);
    return { from: new Date(year, idx, 1), to: new Date(year, idx + 1, 1), label: `${name} ${year}` };
  }
  return undefined;
}

/** "Show me campaigns created this week" → campaigns whose created date is in the period. */
export function isCampaignsCreatedInPeriod(message: string): boolean {
  return !!periodIn(message) && /\bcampaigns?\b/i.test(message) && /\b(created|made|new|added|banai|bani|bane)\b/i.test(message);
}

/** A question about emails SENT / opened / replied in a period (not a campaign list). */
export function isPeriodStatsQuestion(message: string): boolean {
  return !!periodIn(message) && !isCampaignsCreatedInPeriod(message) &&
    /\b(sent|send|emails?|opens?|opened|repl(y|ies|ied)|stats?|statistics|performance|bheji|bheje)\b/i.test(message);
}

type CampaignWithDate = CampaignRef & { createdAt?: string };

const parseDate = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Newest campaign by created date (then by id). */
export function newestCampaign<T extends CampaignWithDate>(all: T[]): T | undefined {
  return [...all].sort((a, b) => {
    const da = parseDate(a.createdAt)?.getTime() ?? 0;
    const db = parseDate(b.createdAt)?.getTime() ?? 0;
    return db - da || Number(b.id) - Number(a.id);
  })[0];
}

export async function newestCampaignOf(state: { rawToken?: string | undefined; userId?: unknown }): Promise<CampaignWithDate | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  const all = await listCampaigns(auth);
  return all ? newestCampaign(all) : undefined;
}

/** "Show me campaigns created this week": the list, or a plain "none". Undefined = could not answer. */
export async function campaignsCreatedAnswer(state: { userMessage: string; rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const period = periodIn(state.userMessage);
  const auth = authFromState(state);
  if (!period || !auth) return undefined;
  const all = await listCampaigns(auth);
  if (!all) return undefined;
  const hits = all.filter((c) => {
    const d = parseDate(c.createdAt);
    return d !== undefined && d >= period.from && d < period.to;
  });
  if (hits.length === 0) {
    const newest = newestCampaign(all);
    return `You created **no campaigns ${period.label === "today" || period.label.startsWith("this") || period.label.startsWith("the last") || period.label === "yesterday" || period.label === "last week" ? period.label : `in ${period.label}`}**.` +
      (newest?.createdAt ? ` Your newest campaign is **${newest.name}** (#${newest.id}), created ${newest.createdAt.slice(0, 10)}.` : "");
  }
  return [
    `You created **${hits.length} campaign${hits.length === 1 ? "" : "s"}** (${period.label}):`,
    "",
    ...hits.map((c, i) => `${i + 1}. **${c.name}** (#${c.id}) — ${c.status}${c.createdAt ? `, created ${c.createdAt.slice(0, 10)}` : ""}`),
  ].join("\n");
}

async function accountStats(auth: AuthContext, view?: "yearly"): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await mcpClientService.dispatch("get_account_stats", view ? { view } : {}, auth);
    const env = r.data as { success?: boolean } | undefined;
    if (r.isToolError || env?.success === false) return undefined;
    return unwrap(r.data);
  } catch {
    return undefined;
  }
}

const pct1 = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(1)}%` : "0%");

/** "How many emails did I send in October?" — from the account's month-by-month numbers. */
export async function periodStatsAnswer(state: { userMessage: string; rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const period = periodIn(state.userMessage);
  const auth = authFromState(state);
  if (!period || !auth) return undefined;
  const wholeMonth = period.from.getDate() === 1 && period.to.getDate() === 1 &&
    (period.to.getMonth() - period.from.getMonth() + 12) % 12 === 1;
  if (!wholeMonth) {
    return `I can give sent-email numbers per **month** (for example *"How many emails did I send in October?"*). For ${period.label}, the **Analytics** page shows day-by-day numbers.`;
  }
  const d = await accountStats(auth, "yearly");
  const months = Array.isArray(d?.months) ? (d!.months as Array<{ month: string; sent: number; opened: number; replied: number }>) : undefined;
  if (!months) return undefined;
  const short = period.from.toLocaleDateString("en-US", { month: "short" });
  const hit = months.find((x) => x.month === short);
  if (!hit) return `I don't have numbers for **${period.label}**: the history covers the 12 months up to your latest activity.`;
  if (hit.sent === 0 && hit.opened === 0 && hit.replied === 0) return `You sent **no emails in ${period.label}**.`;
  return [
    `In **${period.label}** you sent **${hit.sent.toLocaleString()}** email${hit.sent === 1 ? "" : "s"}.`,
    `Opened: **${hit.opened.toLocaleString()}** (${pct1(hit.opened, hit.sent)}) · Replies: **${hit.replied.toLocaleString()}**`,
  ].join("\n");
}

/** Stats of every campaign that has sent mail (six reads at a time). */
async function sentCampaignStats(auth: AuthContext, all: CampaignRef[], limit = 60): Promise<Array<{ c: CampaignRef; s: Stats }>> {
  const candidates = all.filter((c) => !["draft", "scheduled"].includes(c.status.toLowerCase())).slice(0, limit);
  const out: Array<{ c: CampaignRef; s: Stats }> = [];
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    const stats = await Promise.all(batch.map((c) => statsOf(c.id, auth)));
    batch.forEach((c, j) => {
      const s = stats[j];
      if (s && s.sent > 0) out.push({ c, s });
    });
  }
  return out;
}

/** "Which campaign has the best open rate?" — computed from every sent campaign's real numbers. */
export async function rankingAnswer(state: { userMessage: string; rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const want = rankingMetric(state.userMessage);
  const auth = authFromState(state);
  if (!want || !auth) return undefined;
  const all = await listCampaigns(auth);
  if (!all) return undefined;
  const rows = await sentCampaignStats(auth, all);
  if (rows.length === 0) return "None of your campaigns has sent emails yet, so there is nothing to rank.";
  const value = (r: { s: Stats }) =>
    want.metric === "openRate" ? (r.s.openRate ?? r.s.opened / r.s.sent)
    : want.metric === "replyRate" ? (r.s.replyRate ?? (r.s.replied ?? 0) / r.s.sent)
    : want.metric === "replied" ? (r.s.replied ?? 0)
    : want.metric === "bounced" ? (r.s.bounced ?? 0)
    : r.s.sent;
  const sorted = [...rows].sort((a, b) => (want.lowest ? value(a) - value(b) : value(b) - value(a)) || b.s.sent - a.s.sent);
  const label = { openRate: "open rate", replyRate: "reply rate", replied: "replies", bounced: "bounces", sent: "emails sent" }[want.metric];
  const show = (r: { s: Stats }) => (want.metric === "openRate" || want.metric === "replyRate" ? `${(value(r) * 100).toFixed(1)}%` : value(r).toLocaleString());
  const best = sorted[0]!;
  const tie = sorted.filter((r) => value(r) === value(best));
  const word = want.lowest ? "lowest" : want.metric === "replied" ? "most" : "highest";
  const lines = [
    tie.length > 1
      ? `**${tie.length} campaigns** share the ${word} ${label} (${show(best)}): ${tie.slice(0, 5).map((r) => `**${r.c.name}** (#${r.c.id})`).join(", ")}.`
      : `**${best.c.name}** (#${best.c.id}) has the ${word} ${label}: **${show(best)}** (${statsLine(best.s)}).`,
    "",
    `Top ${Math.min(5, sorted.length)} of the ${rows.length} campaigns that have sent emails:`,
    ...sorted.slice(0, 5).map((r, i) => `${i + 1}. **${r.c.name}** (#${r.c.id}) — ${show(r)} · ${r.s.sent} sent`),
  ];
  if (best.s.sent < 10) lines.push("", "Note: these campaigns sent only a few emails, so their rates can change a lot with more sends.");
  return lines.join("\n");
}

/** "How are my campaigns doing?" / "Why is my open rate low?" — account totals, the biggest campaigns, and tips from the numbers. */
export async function overviewAnswer(state: { userMessage: string; rawToken?: string | undefined; userId?: unknown }): Promise<string | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  const d = await accountStats(auth);
  if (!d) return undefined;
  const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
  const sent = n("sent");
  const lines = [
    `Across your **${n("totalCampaigns")} campaigns** you sent **${sent.toLocaleString()}** emails.`,
    `Opened: **${n("opened").toLocaleString()}** (${pct1(n("opened"), sent)}) · Replied: **${n("replied").toLocaleString()}** (${pct1(n("replied"), sent)}) · Bounced: **${n("bounced").toLocaleString()}** (${pct1(n("bounced"), sent)})`,
  ];
  const all = await listCampaigns(auth);
  if (all) {
    const top = (await sentCampaignStats(auth, all, 30)).sort((a, b) => b.s.sent - a.s.sent).slice(0, 3);
    if (top.length) lines.push("", "**Your biggest campaigns:**", ...top.map((r) => `- **${r.c.name}** (#${r.c.id}): ${statsLine(r.s)}`));
  }
  if (/\b(why|improve|increase|boost|better|kyun|kyon|barha\w*|tips?|advice|suggestions?|ideas?|get\s+more)\b/i.test(state.userMessage)) {
    const tips: string[] = [];
    if (sent < 50) tips.push("You have sent few emails so far, so the rates are not reliable yet: they settle after a few hundred sends.");
    if (sent && n("bounced") / sent > 0.03) tips.push(`Your bounce rate is ${pct1(n("bounced"), sent)}: clean the list (the CSV check on the Campaigns page flags bad addresses). Bounces hurt inbox placement and opens.`);
    if (!sent || n("opened") / sent < 0.3) tips.push("Opens depend mostly on the subject line and the sender: a short, specific subject without sales words, a person's name as sender, and the best send time shown on the Dashboard.");
    if (!sent || n("replied") / sent < 0.05) tips.push("For replies: short, personal emails with one clear question at the end. **Generate personalized emails** writes one per recipient.");
    if (tips.length === 0) tips.push("Your rates look healthy. Keep the emails short and personal, and follow up once or twice.");
    lines.push("", "**What you can do:**", ...tips.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}
