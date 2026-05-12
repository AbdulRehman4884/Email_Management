/**
 * src/lib/mockMailflowApiClient.ts
 *
 * In-process mock implementation of IMailFlowApiClient.
 *
 * Used exclusively when MOCK_MAILFLOW=true (development only).
 * Returns realistic, schema-conformant data without making any HTTP calls.
 *
 * This lets the full agent → MCP → tool handler → API client path execute
 * successfully in local development without a running MailFlow backend.
 *
 * Design rules:
 *  - Never import Axios or any HTTP library.
 *  - All returned objects must satisfy the exact TypeScript types from
 *    src/types/mailflow.ts — the TypeScript compiler enforces this.
 *  - Campaign state is shared across all MockMailFlowApiClient instances
 *    within a process lifetime via _campaignStore, so create → list works
 *    correctly even though toolRegistry creates a new client per call.
 *  - Call resetMockCampaignStore() in beforeEach to isolate test state.
 *  - Timestamps are always fresh (new Date().toISOString()) so TTL-sensitive
 *    tests do not flake.
 *  - Never instantiate this class in production (MOCK_MAILFLOW guard in
 *    toolRegistry.ts is the enforcement point).
 */

import { createLogger } from "./logger.js";
import {
  asCampaignId,
  type CampaignId,
  type ISODateString,
  type ReplyId,
  type SmtpSettingsId,
} from "../types/common.js";
import type {
  Campaign,
  CampaignStats,
  CreateCampaignRequest,
  ListRepliesParams,
  ListRepliesResult,
  SmtpSettings,
  UpdateCampaignRequest,
  UpdateSmtpSettingsRequest,
  RecipientCountResult,
  AiPromptSaveResult,
  PersonalizedEmailGenerationResult,
  PersonalizedEmailsResult,
  SaveAiPromptRequest,
  CsvSaveResult,
  BulkSaveResult,
  SequenceProgressResult,
  PendingFollowUpsResult,
  RecipientSequenceHistoryResult,
  RecipientSequenceLookupRequest,
  ReplyIntelligenceSummary,
  ReplyLeadListResult,
  ReplySuggestionResult,
  AutonomousRecommendationResult,
  CampaignAutonomousRecommendationsResult,
  CampaignAutonomousSummaryResult,
  SequenceAdaptationPreviewResult,
} from "../types/mailflow.js";
import type { IMailFlowApiClient } from "./mailflowApiClient.js";

const log = createLogger("mockMailflowApiClient");

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): ISODateString {
  return new Date().toISOString() as ISODateString;
}

function asReplyId(id: string): ReplyId {
  return id as ReplyId;
}

function asSmtpId(id: string): SmtpSettingsId {
  return id as SmtpSettingsId;
}

// ── Mock base objects ─────────────────────────────────────────────────────────

function mockCampaign(
  id: CampaignId,
  overrides: Partial<Campaign> = {},
): Campaign {
  const ts = now();
  return {
    id,
    name:          `Mock Campaign (${id})`,
    subject:       "Mock subject line",
    fromName:      "Mock Sender",
    fromEmail:     "mock@example.com",
    replyToEmail:  null,
    bodyFormat:    "html",
    body:          "<p>Mock campaign body.</p>",
    status:        "draft",
    scheduledAt:   null,
    startedAt:     null,
    pausedAt:      null,
    completedAt:   null,
    createdAt:     ts,
    updatedAt:     ts,
    ...overrides,
  };
}

function mockStats(id: CampaignId): CampaignStats {
  return {
    campaignId:    id,
    sent:          1_000,
    delivered:     980,
    opened:        441,
    clicked:       120,
    bounced:       20,
    unsubscribed:  5,
    replied:       32,
    openRate:      0.45,
    clickRate:     0.12,
    bounceRate:    0.02,
    replyRate:     0.033,
    calculatedAt:  now(),
    sequence: {
      totalRecipients: 25,
      activeRecipients: 10,
      pausedRecipients: 0,
      completedRecipients: 5,
      stoppedRecipients: 0,
      repliedRecipients: 3,
      bouncedRecipients: 1,
      unsubscribedRecipients: 1,
      pendingFollowUps: 10,
      dueFollowUps: 2,
      touchSendCount: 33,
      replyCount: 3,
      unsubscribeCount: 1,
      bounceCount: 1,
      completionRate: 0.2,
      stopReasonBreakdown: { replied: 3, bounced: 1, unsubscribed: 1 },
      touchPerformance: [
        { touchNumber: 1, planned: 25, sent: 25, replied: 2, bounced: 1, unsubscribed: 1 },
        { touchNumber: 2, planned: 25, sent: 8, replied: 1, bounced: 0, unsubscribed: 0 },
      ],
    },
  };
}

const BASE_SMTP: SmtpSettings = {
  id:          asSmtpId("smtp-mock-001"),
  host:        "smtp.example.com",
  port:        587,
  username:    "mock-user@example.com",
  encryption:  "tls",
  fromEmail:   "noreply@example.com",
  fromName:    "Mock Mailer",
  isVerified:  true,
  updatedAt:   new Date().toISOString() as ISODateString,
};

// ── Shared in-process campaign store ─────────────────────────────────────────
//
// Module-level Map shared across all MockMailFlowApiClient instances within
// a single Node.js process. This ensures that createCampaign() → getAllCampaigns()
// returns the newly created campaign, matching real backend behaviour.
//
// toolRegistry creates a fresh client instance per tool call; without this
// shared store every create would be invisible to the next list call.
//
// Tests: call resetMockCampaignStore() in beforeEach to start from a clean
// slate and avoid cross-test contamination.

const _campaignStore = new Map<string, Campaign>();

function seedStoreIfEmpty(): void {
  if (_campaignStore.size > 0) return;
  const seeds: Array<[string, Partial<Campaign>]> = [
    ["mock-camp-001", { name: "Summer Sale Campaign",    status: "draft"   }],
    ["mock-camp-002", { name: "Eid Offer Campaign",      status: "draft"   }],
    ["mock-camp-003", { name: "Product Launch Campaign", status: "paused"  }],
  ];
  for (const [id, overrides] of seeds) {
    const camp = mockCampaign(asCampaignId(id), overrides);
    _campaignStore.set(id, camp);
  }
}

/**
 * Resets all mock campaign data and re-seeds the default three campaigns.
 * Call in beforeEach to isolate tests that create or mutate campaigns.
 */
export function resetMockCampaignStore(): void {
  _campaignStore.clear();
}

// ── MockMailFlowApiClient ─────────────────────────────────────────────────────

export class MockMailFlowApiClient implements IMailFlowApiClient {

  // ── Campaign ────────────────────────────────────────────────────────────────

  async getAllCampaigns(): Promise<Campaign[]> {
    seedStoreIfEmpty();
    const campaigns = Array.from(_campaignStore.values());
    log.debug({ count: campaigns.length }, "mock getAllCampaigns");
    return campaigns;
  }

  async createCampaign(data: CreateCampaignRequest): Promise<Campaign> {
    seedStoreIfEmpty();
    const id = asCampaignId(`mock-${Date.now()}`);
    log.debug({ campaignId: id, name: data.name }, "mock createCampaign");
    const campaign = mockCampaign(id, {
      name:    data.name,
      subject: data.subject,
      body:    data.emailContent,
    });
    _campaignStore.set(id, campaign);
    return campaign;
  }

  async updateCampaign(id: CampaignId, data: UpdateCampaignRequest): Promise<Campaign> {
    seedStoreIfEmpty();
    log.debug({ campaignId: id }, "mock updateCampaign");
    const existing = _campaignStore.get(id) ?? mockCampaign(id);
    const updated = mockCampaign(id, {
      ...existing,
      ...(data.name       !== undefined ? { name:       data.name }       : {}),
      ...(data.subject    !== undefined ? { subject:    data.subject }    : {}),
      ...(data.fromName   !== undefined ? { fromName:   data.fromName }   : {}),
      ...(data.fromEmail  !== undefined ? { fromEmail:  data.fromEmail }  : {}),
      ...(data.body       !== undefined ? { body:       data.body }       : {}),
      ...(data.bodyFormat !== undefined ? { bodyFormat: data.bodyFormat } : {}),
      updatedAt: now(),
    });
    _campaignStore.set(id, updated);
    return updated;
  }

  async startCampaign(id: CampaignId): Promise<Campaign> {
    seedStoreIfEmpty();
    log.debug({ campaignId: id }, "mock startCampaign");
    const existing = _campaignStore.get(id) ?? mockCampaign(id);
    const updated = { ...existing, status: "running" as const, startedAt: now() };
    _campaignStore.set(id, updated);
    return updated;
  }

  async pauseCampaign(id: CampaignId): Promise<Campaign> {
    seedStoreIfEmpty();
    log.debug({ campaignId: id }, "mock pauseCampaign");
    const existing = _campaignStore.get(id) ?? mockCampaign(id);
    const updated = { ...existing, status: "paused" as const, pausedAt: now() };
    _campaignStore.set(id, updated);
    return updated;
  }

  async resumeCampaign(id: CampaignId): Promise<Campaign> {
    seedStoreIfEmpty();
    log.debug({ campaignId: id }, "mock resumeCampaign");
    const existing = _campaignStore.get(id) ?? mockCampaign(id);
    const updated = { ...existing, status: "running" as const, pausedAt: null };
    _campaignStore.set(id, updated);
    return updated;
  }

  // ── Analytics ───────────────────────────────────────────────────────────────

  async getCampaignStats(id: CampaignId): Promise<CampaignStats> {
    log.debug({ campaignId: id }, "mock getCampaignStats");
    return mockStats(id);
  }

  async getSequenceProgress(id: CampaignId): Promise<SequenceProgressResult> {
    return mockStats(id).sequence as SequenceProgressResult;
  }

  async getPendingFollowUps(id: CampaignId, limit = 10): Promise<PendingFollowUpsResult> {
    return {
      campaignId: Number(id),
      total: Math.min(limit, 2),
      items: [
        {
          recipientId: 1,
          currentTouchNumber: 1,
          nextTouchNumber: 2,
          nextScheduledTouchAt: now(),
          sequenceStatus: "active",
          email: "sample@example.com",
          name: "Sample Recipient",
          touchSubject: "Following up on my note",
          touchObjective: "gentle follow-up",
          touchCtaType: "reply_cta",
        },
      ].slice(0, limit),
    };
  }

  async getRecipientTouchHistory(input: RecipientSequenceLookupRequest): Promise<RecipientSequenceHistoryResult> {
    return {
      campaignId: Number(input.campaignId),
      recipientId: Number(input.recipientId ?? 1),
      recipientEmail: input.recipientEmail ?? "sample@example.com",
      recipientName: "Sample Recipient",
      sequenceState: {
        currentTouchNumber: 1,
        nextTouchNumber: 2,
        sequenceStatus: "active",
        nextScheduledTouchAt: now(),
      },
      touches: [
        {
          touchNumber: 1,
          executionStatus: "sent",
          sentAt: now(),
          personalizedSubject: "Quick question, Sam",
        },
        {
          touchNumber: 2,
          executionStatus: "pending",
          scheduledForAt: now(),
          personalizedSubject: "Following up on my note",
        },
      ],
    };
  }

  async markRecipientReplied(_input: RecipientSequenceLookupRequest): Promise<{ message: string }> {
    return { message: "Marked as replied" };
  }

  async markRecipientBounced(_input: RecipientSequenceLookupRequest): Promise<{ message: string }> {
    return { message: "Marked as bounced" };
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async listReplies(params: ListRepliesParams): Promise<ListRepliesResult> {
    const campaignId = params.campaignId ?? asCampaignId("all");
    log.debug({ campaignId }, "mock listReplies");

    const items = [
      {
        id:         asReplyId("reply-001"),
        campaignId,
        fromEmail:  "customer1@example.com",
        fromName:   "Alice Smith",
        subject:    "Re: Your newsletter",
        bodyText:   "Great content! Really enjoyed this edition.",
        bodyHtml:   "<p>Great content! Really enjoyed this edition.</p>",
        status:     "unread" as const,
        receivedAt: now(),
      },
      {
        id:         asReplyId("reply-002"),
        campaignId,
        fromEmail:  "customer2@example.com",
        fromName:   "Bob Jones",
        subject:    "Re: Your newsletter",
        bodyText:   "Please unsubscribe me from future emails.",
        bodyHtml:   "<p>Please unsubscribe me from future emails.</p>",
        status:     "unread" as const,
        receivedAt: now(),
      },
      {
        id:         asReplyId("reply-003"),
        campaignId,
        fromEmail:  "customer3@example.com",
        fromName:   null,
        subject:    "Re: Special offer",
        bodyText:   "When does this offer expire?",
        bodyHtml:   "<p>When does this offer expire?</p>",
        status:     "read" as const,
        receivedAt: now(),
      },
    ];

    const pageSize = params.pageSize ?? items.length;
    const page     = params.page     ?? 1;

    return {
      items:       items.slice(0, pageSize),
      total:       items.length,
      page,
      pageSize,
      hasNextPage: false,
    };
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getReplyIntelligenceSummary(_params: { campaignId?: CampaignId }): Promise<ReplyIntelligenceSummary> {
    return {
      totalReplies: 5,
      positiveReplyRate: 0.4,
      meetingReadyCount: 1,
      unsubscribeCount: 1,
      sentimentDistribution: { positive: 2, neutral: 1, negative: 2 },
      objectionBreakdown: { pricing: 1, competitor: 1 },
      hottestLeadScore: 92,
      averageResponseTimeMinutes: 85,
      sequenceToMeetingConversion: 0.2,
    };
  }

  async listHotLeads(_params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult> {
    return {
      total: 1,
      leads: [{
        replyId: 1,
        campaignId: 1,
        recipientId: 1,
        category: "meeting_interest",
        hotLeadScore: 92,
        leadTemperature: "meeting_ready",
        meetingReady: true,
        replySummary: "Can we talk tomorrow?",
        receivedAt: now(),
        subject: "Re: quick question",
        recipientEmail: "buyer@example.com",
        recipientName: "Buyer",
        campaignName: "Mock Campaign",
      }],
    };
  }

  async listMeetingReadyLeads(params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult> {
    return this.listHotLeads(params);
  }

  async draftReplySuggestion(_replyId: string): Promise<ReplySuggestionResult> {
    return {
      replyId: 1,
      category: "objection_price",
      autoReplyMode: "auto_reply_safe",
      requiresHumanReview: false,
      reviewReason: null,
      suggestedReplyText: "Hi there,\n\nUnderstood. In many cases teams start small before expanding.\n\nHappy to share a lightweight approach if that would be useful.\n\nBest,",
      suggestedReplyHtml: "<p>Hi there,</p><p>Understood. In many cases teams start small before expanding.</p><p>Happy to share a lightweight approach if that would be useful.</p><p>Best,</p>",
      diagnostics: null,
    };
  }

  async markReplyHumanReview(input: { replyId: string; reason?: string }): Promise<{ message: string; replyId: number }> {
    return { message: "Reply marked for human review", replyId: Number(input.replyId) || 1 };
  }

  async getSmtpSettings(): Promise<SmtpSettings> {
    log.debug("mock getSmtpSettings");
    return { ...BASE_SMTP, updatedAt: now() };
  }

  async updateSmtpSettings(data: UpdateSmtpSettingsRequest): Promise<SmtpSettings> {
    log.debug("mock updateSmtpSettings");
    return {
      ...BASE_SMTP,
      ...(data.host       !== undefined ? { host:       data.host }       : {}),
      ...(data.port       !== undefined ? { port:       data.port }       : {}),
      ...(data.encryption !== undefined ? { encryption: data.encryption } : {}),
      ...(data.fromEmail  !== undefined ? { fromEmail:  data.fromEmail }  : {}),
      ...(data.fromName   !== undefined ? { fromName:   data.fromName }   : {}),
      updatedAt: now(),
    };
  }

  // ── Phase 1: AI Campaign (mock) ─────────────────────────────────────────────

  async getRecipientCount(id: CampaignId): Promise<RecipientCountResult> {
    log.debug({ campaignId: id }, "mock getRecipientCount");
    return { campaignId: Number(id), pendingCount: 25, totalCount: 25 };
  }

  async saveAiPrompt(data: SaveAiPromptRequest): Promise<AiPromptSaveResult> {
    log.debug({ campaignId: data.campaignId }, "mock saveAiPrompt");
    return { message: "AI prompt configuration saved", campaignId: Number(data.campaignId) };
  }

  async generatePersonalizedEmails(
    id: CampaignId,
    options: {
      mode?: "default" | "low_promotional_plaintext" | "executive_direct" | "friendly_human" | "value_first";
      tone?: "executive_direct" | "founder_style" | "consultant_style" | "friendly_human" | "technical_advisor" | "concise_enterprise";
      ctaType?: "curiosity_cta" | "soft_meeting_cta" | "reply_cta" | "value_cta" | "direct_cta" | "no_pressure_cta";
      sequenceType?: "cold_outreach" | "warm_followup" | "reengagement" | "founder_outreach";
      sequenceLength?: 3 | 4;
      includeBreakupEmail?: boolean;
      removeBreakupEmail?: boolean;
      shortenEmails?: boolean;
      intent?: string;
    } = {},
  ): Promise<PersonalizedEmailGenerationResult> {
    const mode = options.mode ?? "low_promotional_plaintext";
    log.debug({ campaignId: id, ...options }, "mock generatePersonalizedEmails");
    return {
      message: "Personalized email generation complete",
      campaignId: Number(id),
      totalRecipients: 25,
      generatedCount: 25,
      failedCount: 0,
      touchesPerLead: options.removeBreakupEmail ? 3 : (options.sequenceLength ?? 4),
      totalGeneratedTouches: 25 * (options.removeBreakupEmail ? 3 : (options.sequenceLength ?? 4)),
      modeUsed: mode === "default" ? "low_promotional_plaintext" : mode,
      preview: {
        recipientEmail: "sample@example.com",
        subject: "Quick question, Sam",
        bodyText: "Hi Sam,\n\nI noticed your team is doing a lot manually. Would it help if I shared one simple idea?\n\nBest,\nTaylor",
      },
      strategy: {
        tone: options.tone ?? "friendly_human",
        ctaType: options.ctaType ?? "curiosity_cta",
        ctaText: "Worth sharing a quick idea?",
        sequenceType: options.sequenceType ?? "cold_outreach",
        outreachApproach: "value-first cold outreach",
        reasoning: ["Mock tone reasoning", "Mock CTA reasoning", "Mock sequence reasoning"],
      },
      touchSchedule: options.removeBreakupEmail ? [0, 3, 7] : [0, 3, 7, 14],
      previewSequence: [
        {
          touchNumber: 1,
          subject: "Quick question, Sam",
          bodyText: "Hi Sam,\n\nWould it help if I shared one idea?\n\nBest,\nTaylor",
          ctaType: options.ctaType ?? "curiosity_cta",
          ctaText: "Worth sharing a quick idea?",
          delayDays: 0,
          tone: options.tone ?? "friendly_human",
          objective: "open conversation",
        },
      ],
      deliverability: {
        inboxRisk: "medium",
        likelyTab: "promotions_likely",
        reasons: ["Promotional wording detected"],
        recommendations: ["Use shorter plain-text email"],
        promotionalKeywordScore: 2,
        linkCount: 0,
        imageCount: 0,
        subjectSpamRiskScore: 0,
        bodySpamRiskScore: 18,
      },
    };
  }

  async getPersonalizedEmails(id: CampaignId, limit = 10): Promise<PersonalizedEmailsResult> {
    log.debug({ campaignId: id, limit }, "mock getPersonalizedEmails");
    return {
      campaignId: Number(id),
      total: 1,
      emails: [
        {
          id: 1,
          recipientId: 1,
          personalizedSubject: "Quick question, Sam",
          personalizedBody: "<p>Hi there! We have an exciting offer just for you.</p>",
          toneUsed: "friendly_human",
          ctaType: "curiosity_cta",
          ctaText: "Worth sharing a quick idea?",
          sequenceType: "cold_outreach",
          touchNumber: 1,
          deliverabilityRisk: "medium",
          strategyReasoning: "Mock reasoning",
          generationStatus: "generated",
          recipientEmail: "sample@example.com",
          recipientName: "Sample Recipient",
          sequenceTouches: [
            {
              touchNumber: 1,
              sequenceType: "cold_outreach",
              objective: "open conversation",
              recommendedDelayDays: 0,
              toneUsed: "friendly_human",
              ctaType: "curiosity_cta",
              ctaText: "Worth sharing a quick idea?",
              personalizedSubject: "Quick question, Sam",
              personalizedBody: "<p>Hi Sam</p>",
              personalizedText: "Hi Sam",
              previousTouchSummary: null,
              deliverabilityRisk: "medium",
              strategyReasoning: "Mock reasoning",
            },
          ],
        },
      ],
    };
  }

  async saveRecipientsCsv(id: CampaignId, rows: Array<Record<string, string>>): Promise<CsvSaveResult> {
    log.debug({ campaignId: id, rowCount: rows.length }, "mock saveRecipientsCsv");
    return { added: rows.length, rejected: 0 };
  }

  async saveRecipientsBulk(id: CampaignId, recipients: Array<Record<string, unknown>>): Promise<BulkSaveResult> {
    log.debug({ campaignId: id, count: recipients.length }, "mock saveRecipientsBulk");
    return { saved: recipients.length, skipped: 0 };
  }

  async getAutonomousRecommendation(input: { recipientId: string }): Promise<AutonomousRecommendationResult> {
    const recipientId = Number(input.recipientId);
    return {
      recipientId,
      campaignId: 1,
      leadName: "Sample Recipient",
      leadEmail: "sample@example.com",
      priority: {
        priorityLevel: "high",
        recommendedAction: "Queue a tailored follow-up and monitor closely.",
        confidence: 0.82,
        reasons: ["Mock hot lead score is high."],
      },
      recommendedAction: "prioritize_lead",
      autonomousDecision: {
        action: "prioritize_lead",
        confidence: 0.82,
        reasons: ["Mock hot lead score is high."],
      },
      safety: {
        allowed: true,
        status: "allowed",
        requiresHumanApproval: false,
      },
      adaptationPreview: {
        adaptedTouches: [],
        adaptationSummary: "No future touches were changed.",
        changedTouchNumbers: [],
        adaptationReasons: ["No sequence adaptation trigger detected."],
        requiresHumanReview: false,
        safetyBlocked: false,
        recommendedAction: "keep_sequence_unchanged",
      },
      humanEscalation: {
        escalate: false,
        priority: "high",
        reason: "No human escalation trigger detected.",
        suggestedOwner: "sdr",
      },
      reasons: ["Mock hot lead score is high."],
      nextBestAction: "Continue monitoring and keep the current sequence unchanged.",
      replyContext: {
        category: "positive_interest",
        meetingReady: false,
        hotLeadScore: 72,
      },
    };
  }

  async getCampaignAutonomousRecommendations(input: { campaignId: CampaignId }): Promise<CampaignAutonomousRecommendationsResult> {
    const recommendation = await this.getAutonomousRecommendation({ recipientId: "1" });
    return {
      campaignId: Number(input.campaignId),
      recommendations: [{ ...recommendation, campaignId: Number(input.campaignId) }],
    };
  }

  async getCampaignAutonomousSummary(input: { campaignId: CampaignId }): Promise<CampaignAutonomousSummaryResult> {
    const recommendation = await this.getAutonomousRecommendation({ recipientId: "1" });
    return {
      campaignId: Number(input.campaignId),
      urgentLeads: 0,
      meetingReadyLeads: 0,
      humanReviewNeeded: 0,
      safetyBlockedLeads: 0,
      recommendedCampaignAction: "Continue current sequence and monitor reply intelligence.",
      topOptimizationRecommendation: "Keep future touches reviewable and avoid autonomous send changes.",
      topPriorities: [{ ...recommendation, campaignId: Number(input.campaignId) }],
    };
  }

  async previewSequenceAdaptation(input: {
    recipientId: string;
    campaignId: CampaignId;
    replyText?: string;
    scenario?: string;
  }): Promise<SequenceAdaptationPreviewResult> {
    const recommendation = await this.getAutonomousRecommendation({ recipientId: input.recipientId });
    return {
      recipientId: recommendation.recipientId,
      campaignId: Number(input.campaignId),
      safety: recommendation.safety,
      priority: recommendation.priority,
      recommendedAction: input.scenario === "pricing_objection" ? "switch_to_value_cta" : recommendation.recommendedAction,
      adaptationPreview: {
        adaptedTouches: [],
        adaptationSummary: input.scenario === "pricing_objection"
          ? "Adapted future touch 2 using switch_to_value_cta."
          : "No future touches were changed.",
        changedTouchNumbers: input.scenario === "pricing_objection" ? [2] : [],
        adaptationReasons: input.scenario === "pricing_objection"
          ? ["Pricing objection detected; future touches should become value-focused."]
          : ["No sequence adaptation trigger detected."],
        requiresHumanReview: false,
        safetyBlocked: false,
        recommendedAction: input.scenario === "pricing_objection" ? "switch_to_value_cta" : "keep_sequence_unchanged",
      },
      humanEscalation: recommendation.humanEscalation,
      nextBestAction: recommendation.nextBestAction,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns a mock MailFlow API client for use in development / MOCK_MAILFLOW mode.
 * Never call this in production — enforce via MOCK_MAILFLOW guard at the call site.
 *
 * All instances share the same _campaignStore so create → list works correctly.
 */
export function createMockMailFlowApiClient(): IMailFlowApiClient {
  return new MockMailFlowApiClient();
}
