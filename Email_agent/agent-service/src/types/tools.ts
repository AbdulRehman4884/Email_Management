/**
 * src/types/tools.ts
 *
 * Typed input interfaces for every MCP tool exposed by mailflow-mcp-server.
 * These types are the agent-service's contract with the MCP layer.
 *
 * The MCP server applies its own Zod validation; these types exist so that
 * TypeScript callers get compile-time guarantees about what they pass, and
 * so future LLM arg-extraction (Phase 6) can target well-defined shapes.
 *
 * All interfaces are intentionally permissive at the optional-field level —
 * the MCP server is the authoritative validator for required vs. optional.
 */

// ── Known tool registry ───────────────────────────────────────────────────────

/**
 * Exhaustive tuple of every MCP tool name available in mailflow-mcp-server.
 * Used for runtime validation in ToolExecutionService.
 */
export const KNOWN_TOOL_NAMES = [
  "get_all_campaigns",
  "create_campaign",
  "update_campaign",
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "get_sequence_progress",
  "get_pending_follow_ups",
  "get_recipient_touch_history",
  "mark_recipient_replied",
  "mark_recipient_bounced",
  "get_campaign_stats",
  "list_replies",
  "summarize_replies",
  "get_reply_intelligence_summary",
  "show_hot_leads",
  "show_meeting_ready_leads",
  "draft_reply_suggestion",
  "mark_reply_human_review",
  "get_autonomous_recommendation",
  "get_campaign_autonomous_summary",
  "preview_sequence_adaptation",
  "get_smtp_settings",
  "update_smtp_settings",
  "get_recipient_count",
  "save_ai_prompt",
  "generate_personalized_emails",
  "get_personalized_emails",
  "parse_csv_file",
  "save_csv_recipients",
  // Enrichment
  "validate_email",
  "extract_domain",
  "fetch_website_content",
  "enrich_domain",
  "search_company",
  "classify_industry",
  "score_lead",
  "generate_outreach_template",
  "save_enriched_contacts",
  // Phase 2: Company Search + Official Website Discovery
  "search_company_web",
  "select_official_website",
  "verify_company_website",
  // Phase 3: AI Company Intelligence
  "extract_company_profile",
  "detect_pain_points",
  "generate_outreach_draft",
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

/** Type-guard — narrows an arbitrary string to KnownToolName. */
export function isKnownTool(name: string): name is KnownToolName {
  return (KNOWN_TOOL_NAMES as readonly string[]).includes(name);
}

// ── Campaign tool inputs ──────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  recipientListId?: string;
  fromName?: string;
  fromEmail?: string;
}

export interface UpdateCampaignInput {
  campaignId: string;
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  fromName?: string;
  fromEmail?: string;
}

/** Shared input shape for single-ID campaign actions (start/pause/resume). */
export interface CampaignActionInput {
  campaignId: string;
}

// ── Analytics tool inputs ─────────────────────────────────────────────────────

export interface GetCampaignStatsInput {
  campaignId: string;
}

export interface GetSequenceProgressInput {
  campaignId: string;
}

export interface GetPendingFollowUpsInput {
  campaignId: string;
  limit?: number;
}

export interface GetRecipientTouchHistoryInput {
  campaignId: string;
  recipientId?: string;
  recipientEmail?: string;
}

export interface MarkRecipientRepliedInput {
  campaignId: string;
  recipientId?: string;
  recipientEmail?: string;
}

export interface MarkRecipientBouncedInput {
  campaignId: string;
  recipientId?: string;
  recipientEmail?: string;
}

// ── Inbox tool inputs ─────────────────────────────────────────────────────────

export interface ListRepliesInput {
  campaignId?: string;
  limit?: number;
  offset?: number;
}

export interface SummarizeRepliesInput {
  campaignId?: string;
}

export interface ReplyIntelligenceSummaryInput {
  campaignId?: string;
}

export interface ReplyLeadListInput {
  campaignId?: string;
  limit?: number;
}

export interface DraftReplySuggestionInput {
  replyId: string;
}

export interface MarkReplyHumanReviewInput {
  replyId: string;
  reason?: string;
}

export interface AutonomousRecommendationInput {
  recipientId: string;
}

export interface CampaignAutonomousSummaryInput {
  campaignId: string;
}

export interface PreviewSequenceAdaptationInput {
  recipientId: string;
  campaignId: string;
  replyText?: string;
  scenario?:
    | "pricing_objection"
    | "competitor_objection"
    | "timing_objection"
    | "meeting_interest"
    | "positive_interest"
    | "unsubscribe"
    | "spam_complaint";
}

// ── Settings tool inputs ──────────────────────────────────────────────────────

/** No arguments — returns all campaigns for the authenticated user. */
export type GetAllCampaignsInput = Record<string, never>;

/** No required arguments — returns all current SMTP settings. */
export type GetSmtpSettingsInput = Record<string, never>;

export interface UpdateSmtpSettingsInput {
  host?: string;
  port?: number;
  username?: string;
  /** Password is accepted but always masked in responses. */
  password?: string;
  secure?: boolean;
}

// ── Per-tool input map ────────────────────────────────────────────────────────

/**
 * Maps each KnownToolName to its typed input interface.
 * Keeps the McpClientService method signatures DRY and provides a single
 * source of truth for tool↔input relationships.
 */
export interface GetRecipientCountInput { campaignId: string; }
export interface SaveAiPromptInput {
  campaignId: string;
  templateType?: string;
  toneInstruction?: string;
  customPrompt?: string;
}
export interface GeneratePersonalizedEmailsInput {
  campaignId: string;
  overwrite?: boolean;
  mode?: "default" | "low_promotional_plaintext" | "executive_direct" | "friendly_human" | "value_first";
  tone?: "executive_direct" | "founder_style" | "consultant_style" | "friendly_human" | "technical_advisor" | "concise_enterprise";
  ctaType?: "curiosity_cta" | "soft_meeting_cta" | "reply_cta" | "value_cta" | "direct_cta" | "no_pressure_cta";
  sequenceType?: "cold_outreach" | "warm_followup" | "reengagement" | "founder_outreach";
  sequenceLength?: 3 | 4;
  includeBreakupEmail?: boolean;
  removeBreakupEmail?: boolean;
  shortenEmails?: boolean;
  intent?: string;
}
export interface GetPersonalizedEmailsInput { campaignId: string; limit?: number; }

export interface ParseCsvFileInput { fileContent: string; filename: string; }
export interface SaveCsvRecipientsInput { campaignId: string; rows: Array<Record<string, string>>; }

// ── Enrichment tool inputs ────────────────────────────────────────────────────

export interface ValidateEmailInput { email: string; }
export interface ExtractDomainInput { input: string; }
export interface FetchWebsiteContentInput { url: string; }
export interface EnrichDomainInput { domain: string; }
export interface SearchCompanyInput { companyName: string; website?: string; }
export interface ClassifyIndustryInput {
  companyName?: string;
  websiteText?: string;
  domain?: string;
  existingIndustry?: string;
}
export interface ScoreLeadInput {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  industry?: string;
  website?: string;
  hasBusinessEmail?: boolean;
}
export interface GenerateOutreachTemplateInput {
  campaignId: string;
  enrichedSample: Array<Record<string, unknown>>;
  tone?: "formal" | "friendly" | "sales-focused" | "executive";
  customInstructions?: string;
  cta?: string;
}
export interface SaveEnrichedContactsInput {
  campaignId: string;
  contacts: Array<Record<string, unknown>>;
}

// ── Phase 2: Company Search + Official Website Discovery ──────────────────────

export interface CandidateWebsiteInput {
  title:   string;
  url:     string;
  snippet: string;
}

export interface SearchCompanyWebInput { companyName: string; }
export interface SelectOfficialWebsiteInput {
  companyName: string;
  candidates:  CandidateWebsiteInput[];
}
export interface VerifyCompanyWebsiteInput { companyName: string; url: string; }

// ── Phase 3: AI Company Intelligence ─────────────────────────────────────────

export interface ExtractCompanyProfileInput {
  companyName:    string;
  sourceUrl:      string;
  websiteContent: string;
}

export interface PainPointInput {
  title:       string;
  description: string;
  confidence?: "high" | "medium" | "low";
}

export interface DetectPainPointsInput {
  companyName:     string;
  websiteContent:  string;
  industry?:       string;
  businessSummary?: string;
}

export interface GenerateOutreachDraftInput {
  companyName:     string;
  industry:        string;
  painPoints:      PainPointInput[];
  businessSummary?: string;
  tone?:           "executive" | "consultative" | "friendly" | "direct" | "professional";
}

export interface ToolInputMap {
  get_all_campaigns:           GetAllCampaignsInput;
  create_campaign:             CreateCampaignInput;
  update_campaign:             UpdateCampaignInput;
  start_campaign:              CampaignActionInput;
  pause_campaign:              CampaignActionInput;
  resume_campaign:             CampaignActionInput;
  get_campaign_stats:          GetCampaignStatsInput;
  get_sequence_progress:       GetSequenceProgressInput;
  get_pending_follow_ups:      GetPendingFollowUpsInput;
  get_recipient_touch_history: GetRecipientTouchHistoryInput;
  mark_recipient_replied:      MarkRecipientRepliedInput;
  mark_recipient_bounced:      MarkRecipientBouncedInput;
  list_replies:                ListRepliesInput;
  summarize_replies:           SummarizeRepliesInput;
  get_reply_intelligence_summary: ReplyIntelligenceSummaryInput;
  show_hot_leads:              ReplyLeadListInput;
  show_meeting_ready_leads:    ReplyLeadListInput;
  draft_reply_suggestion:      DraftReplySuggestionInput;
  mark_reply_human_review:     MarkReplyHumanReviewInput;
  get_autonomous_recommendation: AutonomousRecommendationInput;
  get_campaign_autonomous_summary: CampaignAutonomousSummaryInput;
  preview_sequence_adaptation:  PreviewSequenceAdaptationInput;
  get_smtp_settings:           GetSmtpSettingsInput;
  update_smtp_settings:        UpdateSmtpSettingsInput;
  get_recipient_count:         GetRecipientCountInput;
  save_ai_prompt:              SaveAiPromptInput;
  generate_personalized_emails: GeneratePersonalizedEmailsInput;
  get_personalized_emails:     GetPersonalizedEmailsInput;
  parse_csv_file:              ParseCsvFileInput;
  save_csv_recipients:         SaveCsvRecipientsInput;
  validate_email:              ValidateEmailInput;
  extract_domain:              ExtractDomainInput;
  fetch_website_content:       FetchWebsiteContentInput;
  enrich_domain:               EnrichDomainInput;
  search_company:              SearchCompanyInput;
  classify_industry:           ClassifyIndustryInput;
  score_lead:                  ScoreLeadInput;
  generate_outreach_template:  GenerateOutreachTemplateInput;
  save_enriched_contacts:      SaveEnrichedContactsInput;
  search_company_web:          SearchCompanyWebInput;
  select_official_website:     SelectOfficialWebsiteInput;
  verify_company_website:      VerifyCompanyWebsiteInput;
  extract_company_profile:     ExtractCompanyProfileInput;
  detect_pain_points:          DetectPainPointsInput;
  generate_outreach_draft:     GenerateOutreachDraftInput;
}
