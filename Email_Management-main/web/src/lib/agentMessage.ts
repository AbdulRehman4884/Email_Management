/**
 * src/lib/agentMessage.ts
 *
 * Types and helpers for structured agent tool responses.
 *
 * The agent backend already parses LangGraph's finalResponse string into a
 * native object before sending it over HTTP — the HTTP response contains:
 *
 *   result: { status, intent, message, data }
 *
 * This module defines the matching TypeScript types and provides type guards
 * used by AgentResponseCard to route each intent to the correct card renderer.
 */

import { formatLocalScheduleDisplay } from './localScheduleFormat';

// ── Result shapes (mirrors agentResponseFormatter on the backend) ─────────────

export interface SuccessResult {
  status: 'success';
  intent: string;
  message: string;
  data: unknown;
}

export interface NeedsInputResult {
  status: 'needs_input';
  intent: string;
  message: string;
  required_fields: string[];
  optional_fields?: string[];
}

/** Agent is redirecting the user to a page instead of collecting data in chat. */
export interface RedirectResult {
  status: 'redirect';
  intent: string;
  message: string;
  required_fields: string[];
  optional_fields: string[];
  action: { type: 'navigate'; path: string };
}

export interface ErrorResult {
  status: 'error';
  intent: string;
  message: string;
  action?: string;
}

/** Plain conversational text — no status field (e.g. general_help, approval prompts). */
export interface PlainTextResult {
  message: string;
  status?: undefined;
  intent?: undefined;
  data?: undefined;
}

export type AgentStructuredResult =
  | SuccessResult
  | NeedsInputResult
  | RedirectResult
  | ErrorResult
  | PlainTextResult;

export function isRedirectResult(r: AgentStructuredResult): r is RedirectResult {
  return (r as RedirectResult).status === 'redirect';
}

// ── Tool-specific data shapes ─────────────────────────────────────────────────

export interface CampaignData {
  id: string | number;
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  /**
   * Status string from the agent response.
   * MCP layer uses "running" for in-progress campaigns;
   * the frontend Campaign model uses "in_progress".
   * Both values are handled by AgentResponseCard's StatusChip.
   */
  status: string;
  createdAt?: string;
  updatedAt?: string;
  scheduledAt?: string | null;
  replyToEmail?: string | null;
  body?: string;
}

export interface StatsData {
  campaignId: string | number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed?: number;
  replied: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  replyRate: number;
  calculatedAt?: string;
}

export interface ReplyItem {
  id: string | number;
  fromEmail: string;
  fromName?: string | null;
  subject: string;
  bodyText?: string;
  status?: string;
  receivedAt?: string;
  campaignId?: string | number;
}

export interface RepliesData {
  items: ReplyItem[];
  total: number;
  page?: number;
  pageSize?: number;
  hasNextPage?: boolean;
}

export interface ReplySummaryData {
  campaignId?: string | number;
  totalReplies?: number;
  sampleSize?: number;
  statusBreakdown?: Record<string, number>;
  topKeywords?: string[];
  generatedAt?: string;
}

export interface SmtpData {
  id?: string | number;
  host: string;
  port: number;
  username?: string;
  encryption?: string;
  fromEmail: string;
  fromName?: string;
  isVerified?: boolean;
  updatedAt?: string;
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isSuccessResult(r: AgentStructuredResult): r is SuccessResult {
  return r.status === 'success';
}

export function isNeedsInputResult(r: AgentStructuredResult): r is NeedsInputResult {
  return r.status === 'needs_input';
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isCampaignData(data: unknown): data is CampaignData {
  return isObj(data) && typeof data.name === 'string' && typeof data.status === 'string';
}

export function isStatsData(data: unknown): data is StatsData {
  return isObj(data) && typeof data.sent === 'number' && 'openRate' in data;
}

export function isRepliesData(data: unknown): data is RepliesData {
  return isObj(data) && Array.isArray(data.items) && typeof data.total === 'number';
}

export function isReplySummaryData(data: unknown): data is ReplySummaryData {
  return isObj(data) && ('totalReplies' in data || 'topKeywords' in data);
}

export function isSmtpData(data: unknown): data is SmtpData {
  return isObj(data) && typeof data.host === 'string' && typeof data.port === 'number';
}

// ── Campaign ID extraction from message text ─────────────────────────────────

/**
 * Extracts a numeric campaign ID from assistant message text.
 * Tries, in order:
 *   1. JSON code block with a "campaignId" key  — schedule draft responses
 *   2. Inline JSON field  `"campaignId": "N"`   — any structured text
 *   3. Bold-hash pattern  `campaign **#N**`     — explicit-ID acknowledgements
 *
 * Returns undefined when no high-confidence ID is found, so callers never
 * misidentify campaign-list text (which uses names, not bare numeric IDs).
 */
export function extractCampaignIdFromText(text: string): string | undefined {
  // 1. JSON code block — highest confidence
  const blockMatch = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1]!) as Record<string, unknown>;
      const raw =
        parsed.campaignId ??
        (parsed.data as Record<string, unknown> | undefined)?.campaignId ??
        (parsed.data as Record<string, unknown> | undefined)?.id;
      if (raw != null) {
        const str = String(raw);
        if (/^\d+$/.test(str)) return str;
      }
    } catch { /* not valid JSON — fall through */ }
  }

  // 2. Inline JSON field: "campaignId": "6" or "campaignId": 6
  const inlineMatch = text.match(/"campaignId"\s*:\s*"?(\d+)"?/);
  if (inlineMatch?.[1]) return inlineMatch[1];

  // 3. Bold-hash acknowledgement: "I'm now working with campaign **#6**"
  const boldMatch = text.match(/campaign\s+\*\*#(\d+)\*\*/i);
  if (boldMatch?.[1]) return boldMatch[1];

  return undefined;
}

// ── Intent group classification ───────────────────────────────────────────────

/** Intents that mutate a campaign and return a Campaign object. */
export const CAMPAIGN_INTENTS = new Set([
  'create_campaign',
  'update_campaign',
  'start_campaign',
  'pause_campaign',
  'resume_campaign',
]);

/** Intents that return SMTP settings. */
export const SMTP_INTENTS = new Set(['check_smtp', 'update_smtp']);

// ── Capability text detection ─────────────────────────────────────────────────

/**
 * Returns true when text is the agent's "general_help" capability overview.
 * Matched by the fixed opening line emitted by finalResponse.node.ts.
 */
export function isCapabilitiesText(text: string): boolean {
  return text.trimStart().startsWith("Here's what I can help you with:");
}

// ── Formatters ────────────────────────────────────────────────────────────────

/** Formats a decimal rate (0–1) as a percentage string. */
export function fmtRate(rate: number | undefined): string {
  if (rate == null || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** Formats a number with thousands separator. */
export function fmtNum(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString();
}

/** Formats an ISO date string as a short locale date. */
export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}

/** Campaign `scheduledAt` is stored as local wall clock; do not use `new Date` without offset (UTC shift in UI). */
export function fmtScheduleAt(s: string | undefined | null): string {
  if (s == null || s === '') return '—';
  return formatLocalScheduleDisplay(s);
}
