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
  GET_ALL_CAMPAIGNS: "get_all_campaigns",
  CREATE_CAMPAIGN: "create_campaign",
  UPDATE_CAMPAIGN: "update_campaign",
  START_CAMPAIGN: "start_campaign",
  PAUSE_CAMPAIGN: "pause_campaign",
  RESUME_CAMPAIGN: "resume_campaign",
  GET_SEQUENCE_PROGRESS: "get_sequence_progress",
  GET_PENDING_FOLLOW_UPS: "get_pending_follow_ups",
  GET_RECIPIENT_TOUCH_HISTORY: "get_recipient_touch_history",
  MARK_RECIPIENT_REPLIED: "mark_recipient_replied",
  MARK_RECIPIENT_BOUNCED: "mark_recipient_bounced",

  // Analytics
  GET_CAMPAIGN_STATS: "get_campaign_stats",

  // Inbox
  LIST_REPLIES: "list_replies",
  SUMMARIZE_REPLIES: "summarize_replies",
  GET_REPLY_INTELLIGENCE_SUMMARY: "get_reply_intelligence_summary",
  SHOW_HOT_LEADS: "show_hot_leads",
  SHOW_MEETING_READY_LEADS: "show_meeting_ready_leads",
  DRAFT_REPLY_SUGGESTION: "draft_reply_suggestion",
  MARK_REPLY_HUMAN_REVIEW: "mark_reply_human_review",
  GET_AUTONOMOUS_RECOMMENDATION: "get_autonomous_recommendation",
  GET_CAMPAIGN_AUTONOMOUS_SUMMARY: "get_campaign_autonomous_summary",
  PREVIEW_SEQUENCE_ADAPTATION: "preview_sequence_adaptation",

  // Settings
  GET_SMTP_SETTINGS: "get_smtp_settings",
  UPDATE_SMTP_SETTINGS: "update_smtp_settings",

  // Phase 1: AI Campaign
  GET_RECIPIENT_COUNT: "get_recipient_count",
  SAVE_AI_PROMPT: "save_ai_prompt",
  GENERATE_PERSONALIZED_EMAILS: "generate_personalized_emails",
  GET_PERSONALIZED_EMAILS: "get_personalized_emails",

  // CSV file ingestion
  PARSE_CSV_FILE: "parse_csv_file",
  SAVE_CSV_RECIPIENTS: "save_csv_recipients",

  // Enrichment
  VALIDATE_EMAIL: "validate_email",
  EXTRACT_DOMAIN: "extract_domain",
  FETCH_WEBSITE_CONTENT: "fetch_website_content",
  ENRICH_DOMAIN: "enrich_domain",
  SEARCH_COMPANY: "search_company",
  CLASSIFY_INDUSTRY: "classify_industry",
  SCORE_LEAD: "score_lead",
  GENERATE_OUTREACH_TEMPLATE: "generate_outreach_template",
  SAVE_ENRICHED_CONTACTS: "save_enriched_contacts",

  // Phase 2: Company Search + Official Website Discovery
  SEARCH_COMPANY_WEB:       "search_company_web",
  SELECT_OFFICIAL_WEBSITE:  "select_official_website",
  VERIFY_COMPANY_WEBSITE:   "verify_company_website",

  // Phase 3: AI Company Intelligence
  EXTRACT_COMPANY_PROFILE:  "extract_company_profile",
  DETECT_PAIN_POINTS:       "detect_pain_points",
  GENERATE_OUTREACH_DRAFT:  "generate_outreach_draft",
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
  SEQUENCE_PROGRESS: (id: string) => `/campaigns/${id}/sequence-progress`,
  PENDING_FOLLOW_UPS: (id: string) => `/campaigns/${id}/pending-follow-ups`,
  MARK_RECIPIENT_REPLIED: (id: string) => `/campaigns/${id}/recipients/mark-replied`,
  MARK_RECIPIENT_BOUNCED: (id: string) => `/campaigns/${id}/recipients/mark-bounced`,
  RECIPIENT_TOUCH_HISTORY: (id: string, recipientId: string) => `/campaigns/${id}/recipients/${recipientId}/touch-history`,
  REPLIES: "/replies",
  REPLY_INTELLIGENCE_SUMMARY: "/replies/intelligence/summary",
  HOT_LEADS: "/replies/hot-leads",
  MEETING_READY_LEADS: "/replies/meeting-ready",
  REPLY_SUGGESTION: (id: string) => `/replies/${id}/suggestion`,
  REPLY_REVIEW: (id: string) => `/replies/${id}/review`,
  AUTONOMOUS_RECOMMENDATION: (recipientId: string) => `/autonomous/leads/${recipientId}/recommendation`,
  CAMPAIGN_AUTONOMOUS_RECOMMENDATIONS: (id: string) => `/autonomous/campaigns/${id}/recommendations`,
  CAMPAIGN_AUTONOMOUS_SUMMARY: (id: string) => `/autonomous/campaigns/${id}/summary`,
  SMTP_SETTINGS: "/settings/smtp",
  // Phase 1: AI Campaign
  RECIPIENT_UPLOAD: (id: string) => `/campaigns/${id}/recipients/upload`,
  RECIPIENT_BULK: (id: string) => `/campaigns/${id}/recipients/bulk`,
  RECIPIENT_COUNT: (id: string) => `/campaigns/${id}/recipient-count`,
  AI_PROMPT: (id: string) => `/campaigns/${id}/ai-prompt`,
  GENERATE_PERSONALIZED: (id: string) => `/campaigns/${id}/generate-personalized`,
  PERSONALIZED_EMAILS: (id: string) => `/campaigns/${id}/personalized-emails`,
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
