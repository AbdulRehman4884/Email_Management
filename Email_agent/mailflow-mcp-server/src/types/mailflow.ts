/**
 * src/types/mailflow.ts
 *
 * TypeScript contracts for all MailFlow API request and response shapes.
 *
 * Rules:
 *  - These types mirror the MailFlow backend API exactly — no transformation here
 *  - SMTP password is write-only: present in request types, absent in response types
 *  - All IDs use branded scalars from common.ts
 *  - All timestamps are ISODateString
 */

import type {
  CampaignId,
  ISODateString,
  Nullable,
  PaginatedResult,
  ReplyId,
  SmtpSettingsId,
} from "./common.js";

// ── Campaign ──────────────────────────────────────────────────────────────────

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export type CampaignBodyFormat = "html" | "plain";

export interface Campaign {
  id: CampaignId;
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: Nullable<string>;
  bodyFormat: CampaignBodyFormat;
  body: string;
  status: CampaignStatus;
  scheduledAt: Nullable<ISODateString>;
  startedAt: Nullable<ISODateString>;
  pausedAt: Nullable<ISODateString>;
  completedAt: Nullable<ISODateString>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateCampaignRequest {
  name: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  replyToEmail?: string;
  bodyFormat?: CampaignBodyFormat;
  body: string;
  scheduledAt?: ISODateString;
}

export interface UpdateCampaignRequest {
  name?: string;
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  replyToEmail?: string | null;
  bodyFormat?: CampaignBodyFormat;
  body?: string;
  scheduledAt?: ISODateString | null;
}

// ── Campaign stats ────────────────────────────────────────────────────────────

export interface CampaignStats {
  campaignId: CampaignId;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  replied: number;
  /** Decimal 0–1 */
  openRate: number;
  /** Decimal 0–1 */
  clickRate: number;
  /** Decimal 0–1 */
  bounceRate: number;
  /** Decimal 0–1 */
  replyRate: number;
  /** ISO timestamp of the most recent stat update */
  calculatedAt: ISODateString;
}

// ── Replies ───────────────────────────────────────────────────────────────────

export type ReplyStatus = "unread" | "read" | "archived";

export interface Reply {
  id: ReplyId;
  campaignId: CampaignId;
  fromEmail: string;
  fromName: Nullable<string>;
  subject: string;
  bodyText: string;
  bodyHtml: Nullable<string>;
  status: ReplyStatus;
  receivedAt: ISODateString;
}

export interface ListRepliesParams {
  campaignId?: CampaignId;
  status?: ReplyStatus;
  page?: number;
  pageSize?: number;
}

export type ListRepliesResult = PaginatedResult<Reply>;

// ── SMTP settings ─────────────────────────────────────────────────────────────

export type SmtpEncryption = "tls" | "ssl" | "none";

/**
 * SMTP settings as returned by the MailFlow API.
 * `password` is intentionally absent — the API never returns it.
 * Use SmtpSettingsDisplay (see below) in tool responses to mask username too if needed.
 */
export interface SmtpSettings {
  id: SmtpSettingsId;
  host: string;
  port: number;
  username: string;
  encryption: SmtpEncryption;
  fromEmail: string;
  fromName: string;
  isVerified: boolean;
  updatedAt: ISODateString;
}

/**
 * Safe SMTP settings shape for MCP tool responses and logs.
 * Masks the username to avoid leaking credential hints.
 */
export interface SmtpSettingsDisplay
  extends Omit<SmtpSettings, "username"> {
  username: string; // present but may be masked at the service layer
}

export interface UpdateSmtpSettingsRequest {
  host?: string;
  port?: number;
  /** Write-only — never returned in responses */
  username?: string;
  /** Write-only — never returned in responses */
  password?: string;
  encryption?: SmtpEncryption;
  fromEmail?: string;
  fromName?: string;
}

// ── Deterministic reply summary ───────────────────────────────────────────────

/**
 * Output shape for the summarize_replies tool.
 * Phase 1 uses deterministic summarization; Phase N+ will use an LLM.
 */
export interface ReplySummary {
  campaignId: CampaignId;
  totalReplies: number;
  sampleSize: number;
  statusBreakdown: Record<ReplyStatus, number>;
  /** Top N most common words extracted from reply bodies */
  topKeywords: string[];
  /** ISO timestamp when this summary was generated */
  generatedAt: ISODateString;
}
