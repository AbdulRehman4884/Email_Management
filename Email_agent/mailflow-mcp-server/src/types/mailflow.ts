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
  /** Backend field name — maps from the tool's `body` input parameter */
  emailContent: string;
  scheduledAt?: ISODateString;
  /** ID of the SMTP profile to use for this campaign */
  smtpSettingsId?: number;
}

/** Minimal SMTP profile shape returned by /settings/smtp/list */
export interface SmtpProfile {
  id: number;
  fromEmail: string;
  fromName: string;
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
  sequence?: {
    totalRecipients: number;
    activeRecipients: number;
    pausedRecipients: number;
    completedRecipients: number;
    stoppedRecipients: number;
    repliedRecipients: number;
    bouncedRecipients: number;
    unsubscribedRecipients: number;
    pendingFollowUps: number;
    dueFollowUps: number;
    touchSendCount: number;
    replyCount: number;
    unsubscribeCount: number;
    bounceCount: number;
    completionRate: number;
    stopReasonBreakdown: Record<string, number>;
    touchPerformance: Array<{
      touchNumber: number;
      planned: number;
      sent: number;
      replied: number;
      bounced: number;
      unsubscribed: number;
    }>;
  };
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

export interface ReplyIntelligenceSummary {
  totalReplies: number;
  positiveReplyRate: number;
  meetingReadyCount: number;
  unsubscribeCount: number;
  sentimentDistribution: Record<string, number>;
  objectionBreakdown: Record<string, number>;
  hottestLeadScore: number;
  averageResponseTimeMinutes: number;
  sequenceToMeetingConversion: number;
}

export interface ReplyLeadSummary {
  replyId: number;
  campaignId: number;
  recipientId: number;
  category?: string | null;
  hotLeadScore?: number | null;
  leadTemperature?: string | null;
  meetingReady?: boolean | null;
  replySummary?: string | null;
  receivedAt?: string | null;
  subject?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  campaignName?: string | null;
}

export interface ReplyLeadListResult {
  leads: ReplyLeadSummary[];
  total: number;
}

export interface ReplySuggestionResult {
  replyId: number;
  category: string;
  autoReplyMode: string;
  requiresHumanReview: boolean;
  reviewReason: string | null;
  suggestedReplyText: string | null;
  suggestedReplyHtml: string | null;
  diagnostics: string | null;
}

// ── SMTP settings ─────────────────────────────────────────────────────────────

export interface AutonomousRecommendationResult {
  recipientId: number;
  campaignId: number;
  leadName?: string | null;
  leadEmail?: string;
  priority: {
    priorityLevel: string;
    recommendedAction: string;
    confidence: number;
    reasons: string[];
  };
  recommendedAction: string;
  autonomousDecision: {
    action: string;
    confidence: number;
    reasons: string[];
  };
  safety: {
    allowed: boolean;
    status: string;
    reason?: string;
    requiresHumanApproval: boolean;
  };
  adaptationPreview: Record<string, unknown> | null;
  humanEscalation: {
    escalate: boolean;
    priority: string;
    reason: string;
    suggestedOwner: string;
  };
  reasons: string[];
  nextBestAction: string;
  replyContext: Record<string, unknown>;
}

export interface CampaignAutonomousRecommendationsResult {
  campaignId: number;
  recommendations: AutonomousRecommendationResult[];
}

export interface CampaignAutonomousSummaryResult {
  campaignId: number;
  urgentLeads: number;
  meetingReadyLeads: number;
  humanReviewNeeded: number;
  safetyBlockedLeads: number;
  recommendedCampaignAction: string;
  topOptimizationRecommendation: string;
  topPriorities: AutonomousRecommendationResult[];
}

export interface SequenceAdaptationPreviewResult {
  recipientId: number;
  campaignId: number;
  safety: AutonomousRecommendationResult["safety"];
  priority: AutonomousRecommendationResult["priority"];
  recommendedAction: string;
  adaptationPreview: Record<string, unknown> | null;
  humanEscalation: AutonomousRecommendationResult["humanEscalation"];
  nextBestAction: string;
}

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

// ── Phase 1: AI Campaign ──────────────────────────────────────────────────────

export interface RecipientCountResult {
  campaignId: number;
  pendingCount: number;
  totalCount: number;
}

export interface AiPromptSaveResult {
  message: string;
  campaignId: number;
}

export interface PersonalizedEmailGenerationResult {
  message: string;
  campaignId: number;
  totalRecipients: number;
  generatedCount: number;
  failedCount: number;
  touchesPerLead?: number;
  totalGeneratedTouches?: number;
  modeUsed?: string;
  preview?: {
    recipientEmail: string;
    subject: string;
    bodyText: string;
  } | null;
  strategy?: {
    tone: string;
    ctaType: string;
    ctaText: string;
    sequenceType: string;
    outreachApproach: string;
    reasoning: string[];
  } | null;
  touchSchedule?: number[];
  previewSequence?: Array<{
    touchNumber: number;
    subject: string;
    bodyText: string;
    ctaType: string;
    ctaText: string;
    delayDays: number;
    tone: string;
    objective: string;
  }>;
  deliverability?: {
    inboxRisk: "low" | "medium" | "high";
    likelyTab: "primary_possible" | "promotions_likely" | "spam_risk";
    reasons: string[];
    recommendations: string[];
    promotionalKeywordScore: number;
    linkCount: number;
    imageCount: number;
    subjectSpamRiskScore: number;
    bodySpamRiskScore: number;
  } | null;
  /** True when emails already exist and overwrite was not requested */
  alreadyExists?: boolean;
  /** Count of pre-existing emails when alreadyExists is true */
  existingCount?: number;
}

export interface PersonalizedEmailItem {
  id: number;
  recipientId: number;
  personalizedSubject: string | null;
  personalizedBody: string;
  toneUsed?: string | null;
  ctaType?: string | null;
  ctaText?: string | null;
  sequenceType?: string | null;
  touchNumber?: number;
  deliverabilityRisk?: string | null;
  strategyReasoning?: string | null;
  generationStatus: string;
  recipientEmail: string;
  recipientName: string | null;
  deliverabilityDiagnostics?: {
    inboxRisk: "low" | "medium" | "high";
    likelyTab: "primary_possible" | "promotions_likely" | "spam_risk";
    reasons: string[];
    recommendations: string[];
  };
  sequenceTouches?: Array<{
    touchNumber: number;
    sequenceType: string;
    objective: string;
    recommendedDelayDays: number;
    toneUsed?: string | null;
    ctaType?: string | null;
    ctaText?: string | null;
    personalizedSubject?: string | null;
    personalizedBody: string;
    personalizedText?: string | null;
    previousTouchSummary?: string | null;
    deliverabilityRisk?: string | null;
    strategyReasoning?: string | null;
    deliverabilityDiagnostics?: {
      inboxRisk: "low" | "medium" | "high";
      likelyTab: "primary_possible" | "promotions_likely" | "spam_risk";
      reasons: string[];
      recommendations: string[];
    };
  }>;
}

export interface PersonalizedEmailsResult {
  campaignId: number;
  total: number;
  emails: PersonalizedEmailItem[];
}

export interface SequenceProgressResult {
  campaignId: number;
  totalRecipients: number;
  activeRecipients: number;
  pausedRecipients: number;
  completedRecipients: number;
  stoppedRecipients: number;
  repliedRecipients: number;
  bouncedRecipients: number;
  unsubscribedRecipients: number;
  pendingFollowUps: number;
  dueFollowUps: number;
  touchSendCount: number;
  replyCount: number;
  unsubscribeCount: number;
  bounceCount: number;
  completionRate: number;
  stopReasonBreakdown: Record<string, number>;
  touchPerformance: Array<{
    touchNumber: number;
    planned: number;
    sent: number;
    replied: number;
    bounced: number;
    unsubscribed: number;
  }>;
}

export interface PendingFollowUpItem {
  recipientId: number;
  currentTouchNumber: number;
  nextTouchNumber: number;
  nextScheduledTouchAt: string | null;
  sequenceStatus: string;
  email: string;
  name: string | null;
  touchSubject: string | null;
  touchObjective: string | null;
  touchCtaType: string | null;
}

export interface PendingFollowUpsResult {
  campaignId: number;
  total: number;
  items: PendingFollowUpItem[];
}

export interface RecipientSequenceHistoryResult {
  campaignId: number;
  recipientId: number;
  recipientEmail: string;
  recipientName: string | null;
  sequenceState: Record<string, unknown> | null;
  touches: Array<Record<string, unknown>>;
}

// ── CSV file ingestion ────────────────────────────────────────────────────────

export interface CsvPreviewRow {
  [column: string]: string;
}

export interface CsvParseResult {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  columns: string[];
  preview: CsvPreviewRow[];
  /** All valid rows — used by save_csv_recipients on next turn. */
  rows: Array<Record<string, string>>;
}

export interface CsvSaveResult {
  added: number;
  rejected: number;
  message?: string;
}

export interface BulkRejectedEntry {
  email: string;
  reason: string;
}

export interface BulkSaveResult {
  saved: number;
  skipped: number;
  rejected?: BulkRejectedEntry[];
  message?: string;
}

export interface BulkLeadRowInput {
  rowNumber?: number | undefined;
  name?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  email: string;
  company: string;
  website: string;
  role?: string | undefined;
  industry?: string | undefined;
  country?: string | undefined;
  notes?: string | undefined;
}

export interface BulkValidationSummary {
  totalRows: number;
  valid: number;
  duplicates: number;
  invalid: number;
  missingCompany?: number;
  missingWebsite?: number;
  invalidEmail?: number;
  invalidDomain?: number;
}

export interface BulkTemplateOption {
  id: string;
  name: string;
  bestFor?: string;
  tone?: string;
  typicalBuyer?: string;
  ctaStyle?: string;
}

export interface BulkDetectedGroup {
  group: string;
  count: number;
  recommendedTemplate: string;
}

export interface BulkJobCreateResult {
  jobId: number;
  fileName: string;
  columns: string[];
  previewRows: Array<Record<string, unknown>>;
  summary: BulkValidationSummary;
  status: string;
  templateOptions: BulkTemplateOption[];
  detectedGroups: BulkDetectedGroup[];
  message: string;
}

export interface BulkTemplateStrategyInput {
  globalTemplate?: string | undefined;
  globalTone?: string | undefined;
  globalCTAStyle?: string | undefined;
  industryTemplateMap?: Record<string, string> | undefined;
  rowTemplateMap?: Record<string, string> | undefined;
  userCustomizationInstructions?: string | undefined;
  approvedStyleExamples?: string[] | undefined;
}

export interface BulkTemplateStrategyResult {
  jobId: number;
  strategy: Record<string, unknown>;
  message: string;
}

export interface BulkStatusResult {
  jobId: number;
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  status: string;
  summary?: BulkValidationSummary;
  campaignId?: number | null;
  templateSelection?: Record<string, unknown> | null;
}

export interface BulkGeneratedTemplate {
  id: number;
  rowId: number;
  company: string | null;
  website: string | null;
  email: string | null;
  name: string | null;
  role: string | null;
  industry: string | null;
  selectedTemplateId: string;
  templateName: string;
  selectedTone: string;
  selectedCTAStyle: string;
  subject: string;
  body: string;
  followup1: string;
  followup2: string;
  cta: string;
  rationale: string | null;
  confidence: number;
  persona: string | null;
  status: string;
  missingDataWarnings?: string[] | null;
}

export interface BulkTemplatesResult {
  jobId: number;
  page: number;
  limit: number;
  total: number;
  templates: BulkGeneratedTemplate[];
}

export interface BulkApproveResult {
  message: string;
  approved: number;
}

export interface BulkRegenerateResult {
  message: string;
  templateId: number;
}

export interface BulkCampaignDraftResult {
  campaignId: number;
  status: string;
  recipients: number;
  message: string;
  estimatedSendDurationDays: number;
  smtpSafeDailyCapacity: number;
}

export interface BulkCampaignReadinessResult {
  ready: boolean;
  campaignFound: boolean;
  smtpConfigured: boolean;
  recipientsExist: boolean;
  recipientCount: number;
  pendingRecipientCount: number;
  unsupportedPlaceholders: string[];
  repairedSenderName: boolean;
  repairedFields: string[];
  issues: string[];
}

export interface SaveAiPromptRequest {
  campaignId: string;
  templateType?: string;
  toneInstruction?: string;
  customPrompt?: string;
}

export interface GeneratePersonalizedEmailsRequest {
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

export interface RecipientSequenceLookupRequest {
  campaignId: string;
  recipientId?: string;
  recipientEmail?: string;
}

