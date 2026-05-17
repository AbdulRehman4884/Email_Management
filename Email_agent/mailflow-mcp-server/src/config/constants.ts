/**
 * src/config/constants.ts
 *
 * Application-wide constants.
 * No values here should come from environment — use env.ts for that.
 * No secrets belong here.
 */

// ── Server ────────────────────────────────────────────────────────────────────

export const SERVER_NAME = "mailflow-mcp-server" as const;
export const SERVER_VERSION = "1.0.0" as const;

// ── MCP Tool Names ────────────────────────────────────────────────────────────

export const TOOL_NAMES = {
  // Campaign
  CREATE_CAMPAIGN: "create_campaign",
  UPDATE_CAMPAIGN: "update_campaign",
  START_CAMPAIGN: "start_campaign",
  PAUSE_CAMPAIGN: "pause_campaign",
  RESUME_CAMPAIGN: "resume_campaign",

  // Analytics
  GET_CAMPAIGN_STATS: "get_campaign_stats",

  // Inbox
  LIST_REPLIES: "list_replies",
  SUMMARIZE_REPLIES: "summarize_replies",

  // Settings
  GET_SMTP_SETTINGS: "get_smtp_settings",
  UPDATE_SMTP_SETTINGS: "update_smtp_settings",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ── MailFlow API Paths ────────────────────────────────────────────────────────

export const MAILFLOW_PATHS = {
  CAMPAIGNS: "/campaigns",
  CAMPAIGN_BY_ID: (id: string) => `/campaigns/${id}`,
  CAMPAIGN_START: (id: string) => `/campaigns/${id}/start`,
  CAMPAIGN_PAUSE: (id: string) => `/campaigns/${id}/pause`,
  CAMPAIGN_RESUME: (id: string) => `/campaigns/${id}/resume`,
  CAMPAIGN_STATS: (id: string) => `/campaigns/${id}/stats`,
  REPLIES: "/replies",
  SMTP_SETTINGS: "/settings/smtp",
} as const;

// ── Auth ──────────────────────────────────────────────────────────────────────

/** HTTP header agent-service uses to pass the service secret to this MCP server */
export const SERVICE_TOKEN_HEADER = "x-service-token" as const;

/** HTTP header agent-service uses to forward the end-user bearer token */
export const FORWARDED_AUTH_HEADER = "x-forwarded-authorization" as const;

// ── Masking ───────────────────────────────────────────────────────────────────

/** Replacement string for masked sensitive values in logs and responses */
export const MASKED_VALUE = "***" as const;

/** Fields that must be masked in all log output */
export const SENSITIVE_LOG_FIELDS: ReadonlyArray<string> = [
  "password",
  "token",
  "secret",
  "authorization",
  "x-service-token",
  "x-forwarded-authorization",
];

// ── Pagination ────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ── Summarization ─────────────────────────────────────────────────────────────

/** Maximum number of replies included in a deterministic summary */
export const SUMMARIZE_REPLIES_MAX_SAMPLE = 50;
