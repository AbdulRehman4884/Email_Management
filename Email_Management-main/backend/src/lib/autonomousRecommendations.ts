import { dbPool } from "./db.js";
import {
  autonomousSafetyGuard,
  type AutonomousSafetyResult,
} from "./autonomousSafetyGuard.js";
import {
  detectHumanEscalationNeed,
  prioritizeLead,
  type HumanEscalationResult,
  type LeadPrioritizationResult,
} from "./leadPrioritization.js";
import {
  adaptFutureTouches,
  type AdaptableSequenceTouch,
  type DeliverabilitySignals,
  type SequenceAdaptationResult,
} from "./sequenceAdaptation.js";
import {
  detectReplyIntent,
  type ObjectionType,
  type ReplyIntentCategory,
  type ReplySentiment,
  type UrgencyLevel,
} from "./replyIntelligence.js";

export type AutonomousScenario =
  | "pricing_objection"
  | "competitor_objection"
  | "timing_objection"
  | "meeting_interest"
  | "positive_interest"
  | "unsubscribe"
  | "spam_complaint";

export interface AutonomousRecommendationRequest {
  userId: number;
  recipientId: number;
  campaignId?: number | null;
  replyText?: string | null;
  scenario?: AutonomousScenario | null;
}

export interface AutonomousDecisionPreview {
  action: string;
  confidence: number;
  reasons: string[];
}

export interface AutonomousLeadRecommendation {
  recipientId: number;
  campaignId: number;
  leadName: string | null;
  leadEmail: string;
  priority: LeadPrioritizationResult;
  recommendedAction: string;
  autonomousDecision: AutonomousDecisionPreview;
  safety: AutonomousSafetyResult;
  adaptationPreview: SequenceAdaptationResult | null;
  humanEscalation: HumanEscalationResult;
  reasons: string[];
  nextBestAction: string;
  replyContext: {
    category: string | null;
    confidence: number | null;
    sentiment: string | null;
    objectionType: string | null;
    meetingReady: boolean;
    hotLeadScore: number;
  };
}

export interface CampaignAutonomousSummary {
  campaignId: number;
  urgentLeads: number;
  meetingReadyLeads: number;
  humanReviewNeeded: number;
  safetyBlockedLeads: number;
  recommendedCampaignAction: string;
  topOptimizationRecommendation: string;
  topPriorities: AutonomousLeadRecommendation[];
}

interface RecipientRow {
  id: number;
  campaign_id: number;
  email: string;
  status: string;
  name: string | null;
  opened_at: Date | string | null;
  replied_at: Date | string | null;
  custom_fields: string | null;
  sequence_status: string | null;
  stop_reason: string | null;
}

interface ReplyContextRow {
  reply_id: number | null;
  body_text: string | null;
  intent_category: string | null;
  intent_confidence: number | null;
  sentiment: string | null;
  buying_signal_strength: number | null;
  urgency_level: string | null;
  meeting_likelihood: number | null;
  objection_type: string | null;
  meeting_ready: boolean | null;
  lead_temperature: string | null;
  hot_lead_score: number | null;
  requires_human_review: boolean | null;
  review_status: string | null;
  prior_reply_count: number | null;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numberField(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scenarioReplyText(scenario?: AutonomousScenario | null): string | null {
  switch (scenario) {
    case "pricing_objection":
      return "Too expensive";
    case "competitor_objection":
      return "We already use another provider";
    case "timing_objection":
      return "Not right now, maybe next quarter";
    case "meeting_interest":
      return "Let's schedule a call next week";
    case "positive_interest":
      return "This looks interesting, can you share more?";
    case "unsubscribe":
      return "Remove me from your list";
    case "spam_complaint":
      return "This is spam. Stop spamming me.";
    default:
      return null;
  }
}

function normalizeReplyContext(row: ReplyContextRow | null, overrideText?: string | null) {
  if (overrideText) {
    const detected = detectReplyIntent({ bodyText: overrideText });
    return {
      bodyText: overrideText,
      category: detected.category,
      confidence: detected.confidence,
      sentiment: detected.sentiment,
      buyingSignalStrength: detected.buyingSignalStrength,
      urgencyLevel: detected.urgencyLevel,
      meetingLikelihood: detected.meetingLikelihood,
      objectionType: objectionFromCategory(detected.category),
      meetingReady: detected.category === "meeting_interest" || detected.meetingLikelihood >= 80,
      hotLeadScore: detected.category === "meeting_interest" ? 85 : detected.buyingSignalStrength,
      requiresHumanReview: detected.requiresHumanReview,
      reviewStatus: detected.requiresHumanReview ? "pending" : "reviewed",
      priorReplyCount: 0,
    };
  }

  return {
    bodyText: row?.body_text ?? null,
    category: row?.intent_category ?? null,
    confidence: row?.intent_confidence ?? null,
    sentiment: row?.sentiment ?? null,
    buyingSignalStrength: row?.buying_signal_strength ?? 0,
    urgencyLevel: row?.urgency_level ?? null,
    meetingLikelihood: row?.meeting_likelihood ?? 0,
    objectionType: row?.objection_type ?? null,
    meetingReady: Boolean(row?.meeting_ready),
    hotLeadScore: row?.hot_lead_score ?? 0,
    requiresHumanReview: Boolean(row?.requires_human_review),
    reviewStatus: row?.review_status ?? null,
    priorReplyCount: row?.prior_reply_count ?? 0,
  };
}

function objectionFromCategory(category: ReplyIntentCategory | null | undefined): string | null {
  if (category === "objection_price") return "pricing";
  if (category === "objection_timing") return "timing";
  if (category === "objection_competitor") return "competitor";
  if (category === "objection_authority") return "authority";
  return null;
}

function deliverabilityFromTouches(touches: AdaptableSequenceTouch[]): DeliverabilitySignals | null {
  const hasHighRisk = touches.some((touch) => String(touch.deliverabilityRisk ?? "").toLowerCase() === "high");
  return hasHighRisk
    ? { inboxRisk: "high", reasons: ["At least one future touch has high deliverability risk."] }
    : null;
}

function uniqueReasons(...groups: Array<Array<string | undefined> | undefined>): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const reason of group ?? []) {
      const clean = String(reason ?? "").trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

function pickRecommendedAction(
  safety: AutonomousSafetyResult,
  escalation: HumanEscalationResult,
  adaptation: SequenceAdaptationResult | null,
  priority: LeadPrioritizationResult,
): string {
  if (!safety.allowed || safety.status === "blocked") return "stop_sequence";
  if (escalation.escalate) return "escalate_to_human";
  if (adaptation?.recommendedAction && adaptation.recommendedAction !== "keep_sequence_unchanged") {
    return adaptation.recommendedAction;
  }
  if (priority.priorityLevel === "urgent" || priority.priorityLevel === "executive_attention") {
    return "prioritize_lead";
  }
  return "continue_sequence";
}

function nextBestAction(action: string, safety: AutonomousSafetyResult, escalation: HumanEscalationResult): string {
  if (!safety.allowed || safety.status === "blocked") {
    return `Automation is blocked for this lead because ${safety.reason ?? "a safety rule was triggered"}`;
  }
  if (escalation.escalate) {
    return "Review and respond to this lead before sending further follow-ups.";
  }
  if (action === "pause_sequence") {
    return "Pause follow-ups and draft a human reply.";
  }
  if (action === "stop_sequence") {
    return "Stop future automation for this lead.";
  }
  if (action === "switch_to_value_cta" || action === "shorten_future_touches") {
    return "Review the adapted future-touch preview before applying any sequence changes.";
  }
  return "Continue monitoring and keep the current sequence unchanged.";
}

async function fetchRecipient(userId: number, recipientId: number, campaignId?: number | null): Promise<RecipientRow | null> {
  const params: unknown[] = [userId, recipientId];
  const campaignFilter = campaignId ? "AND c.id = $3" : "";
  if (campaignId) params.push(campaignId);

  const result = await dbPool.query<RecipientRow>(
    `
      SELECT
        r.id,
        r.campaign_id,
        r.email,
        r.status,
        r.name,
        r.opened_at,
        r.replied_at,
        r.custom_fields,
        rss.sequence_status,
        rss.stop_reason
      FROM recipients r
      JOIN campaigns c ON c.id = r.campaign_id
      LEFT JOIN recipient_sequence_state rss
        ON rss.recipient_id = r.id AND rss.campaign_id = r.campaign_id
      WHERE c.user_id = $1 AND r.id = $2 ${campaignFilter}
      LIMIT 1
    `,
    params,
  );
  return result.rows[0] ?? null;
}

async function fetchLatestReplyContext(campaignId: number, recipientId: number): Promise<ReplyContextRow | null> {
  const result = await dbPool.query<ReplyContextRow>(
    `
      SELECT
        er.id AS reply_id,
        er.body_text,
        ri.intent_category,
        ri.intent_confidence,
        ri.sentiment,
        ri.buying_signal_strength,
        ri.urgency_level,
        ri.meeting_likelihood,
        ri.objection_type,
        ri.meeting_ready,
        ri.lead_temperature,
        ri.hot_lead_score,
        ri.requires_human_review,
        ri.review_status,
        ri.prior_reply_count
      FROM email_replies er
      LEFT JOIN reply_intelligence ri ON ri.reply_id = er.id
      WHERE er.campaign_id = $1 AND er.recipient_id = $2 AND er.direction = 'inbound'
      ORDER BY er.received_at DESC
      LIMIT 1
    `,
    [campaignId, recipientId],
  );
  return result.rows[0] ?? null;
}

async function fetchTouches(campaignId: number, recipientId: number): Promise<AdaptableSequenceTouch[]> {
  const result = await dbPool.query<AdaptableSequenceTouch>(
    `
      SELECT
        id,
        touch_number AS "touchNumber",
        objective,
        recommended_delay_days AS "recommendedDelayDays",
        tone_used AS "toneUsed",
        cta_type AS "ctaType",
        cta_text AS "ctaText",
        personalized_subject AS "personalizedSubject",
        personalized_body AS "personalizedBody",
        personalized_text AS "personalizedText",
        previous_touch_summary AS "previousTouchSummary",
        deliverability_risk AS "deliverabilityRisk",
        strategy_reasoning AS "strategyReasoning",
        execution_status AS "executionStatus",
        sent_at AS "sentAt"
      FROM campaign_sequence_touches
      WHERE campaign_id = $1 AND recipient_id = $2
      ORDER BY touch_number ASC
    `,
    [campaignId, recipientId],
  );
  return result.rows;
}

export async function getAutonomousLeadRecommendation(
  input: AutonomousRecommendationRequest,
): Promise<AutonomousLeadRecommendation | null> {
  const recipient = await fetchRecipient(input.userId, input.recipientId, input.campaignId);
  if (!recipient) return null;

  const scenarioText = input.replyText ?? scenarioReplyText(input.scenario);
  const [replyRow, touches] = await Promise.all([
    fetchLatestReplyContext(recipient.campaign_id, recipient.id),
    fetchTouches(recipient.campaign_id, recipient.id),
  ]);
  const reply = normalizeReplyContext(replyRow, scenarioText);
  const custom = parseJsonObject(recipient.custom_fields);
  const title = stringField(custom.title) ?? stringField(custom.jobTitle) ?? stringField(custom.role);
  const companySize = stringField(custom.companySize) ?? stringField(custom.company_size) ?? numberField(custom.employeeCount);
  const leadScore = numberField(custom.leadScore) ?? numberField(custom.lead_score);
  const openedCount = recipient.opened_at ? 1 : 0;
  const repliedCount = recipient.replied_at || reply.category ? Math.max(1, Number(reply.priorReplyCount ?? 0) + 1) : 0;

  const priority = prioritizeLead({
    leadScore,
    hotLeadScore: reply.hotLeadScore,
    meetingLikelihood: reply.meetingLikelihood,
    meetingReady: reply.meetingReady,
    urgencyLevel: reply.urgencyLevel,
    sentiment: reply.sentiment,
    replyCategory: reply.category,
    recipientTitle: title,
    companySize,
    industry: stringField(custom.industry),
    openedCount,
    repliedCount,
    objectionCount: reply.objectionType ? 1 : 0,
  });

  const safety = autonomousSafetyGuard({
    action: "continue_sequence",
    replyCategory: reply.category,
    sentiment: reply.sentiment,
    reviewStatus: reply.reviewStatus,
    requiresHumanReview: reply.requiresHumanReview,
    recipientStatus: recipient.status,
    sequenceStatus: recipient.sequence_status,
    stopReason: recipient.stop_reason,
    bodyText: reply.bodyText,
  });

  const adaptationPreview = touches.length
    ? adaptFutureTouches({
      currentTouches: touches,
      replyIntelligence: {
        category: reply.category as ReplyIntentCategory | undefined,
        confidence: reply.confidence ?? undefined,
        sentiment: reply.sentiment as ReplySentiment | undefined,
        buyingSignalStrength: reply.buyingSignalStrength ?? undefined,
        urgencyLevel: reply.urgencyLevel as UrgencyLevel | undefined,
        meetingLikelihood: reply.meetingLikelihood ?? undefined,
        objectionType: reply.objectionType as ObjectionType | null | undefined,
        meetingReady: reply.meetingReady,
        hotLeadScore: reply.hotLeadScore,
        requiresHumanReview: reply.requiresHumanReview,
      },
      objectionType: reply.objectionType,
      leadPriority: priority,
      deliverabilityDiagnostics: deliverabilityFromTouches(touches),
      safetyGuard: safety,
      previousTouchHistory: touches.filter((touch) => touch.sentAt != null),
    })
    : null;

  const humanEscalation = detectHumanEscalationNeed({
    leadScore,
    hotLeadScore: reply.hotLeadScore,
    meetingLikelihood: reply.meetingLikelihood,
    meetingReady: reply.meetingReady,
    urgencyLevel: reply.urgencyLevel,
    sentiment: reply.sentiment,
    replyCategory: reply.category,
    recipientTitle: title,
    companySize,
    industry: stringField(custom.industry),
    openedCount,
    repliedCount,
    objectionCount: reply.objectionType ? 1 : 0,
    bodyText: reply.bodyText,
    requiresHumanReview: reply.requiresHumanReview,
    intentConfidence: reply.confidence,
  });

  const recommendedAction = pickRecommendedAction(safety, humanEscalation, adaptationPreview, priority);
  const reasons = uniqueReasons(
    priority.reasons,
    adaptationPreview?.adaptationReasons,
    [humanEscalation.reason, safety.reason],
  );

  return {
    recipientId: recipient.id,
    campaignId: recipient.campaign_id,
    leadName: recipient.name,
    leadEmail: recipient.email,
    priority,
    recommendedAction,
    autonomousDecision: {
      action: recommendedAction,
      confidence: Math.max(priority.confidence, reply.confidence ?? 0.4),
      reasons,
    },
    safety,
    adaptationPreview,
    humanEscalation,
    reasons,
    nextBestAction: nextBestAction(recommendedAction, safety, humanEscalation),
    replyContext: {
      category: reply.category,
      confidence: reply.confidence,
      sentiment: reply.sentiment,
      objectionType: reply.objectionType,
      meetingReady: reply.meetingReady,
      hotLeadScore: reply.hotLeadScore,
    },
  };
}

async function fetchCampaignRecipientIds(userId: number, campaignId: number): Promise<number[]> {
  const result = await dbPool.query<{ id: number }>(
    `
      SELECT r.id
      FROM recipients r
      JOIN campaigns c ON c.id = r.campaign_id
      WHERE c.user_id = $1 AND c.id = $2
      ORDER BY r.id ASC
    `,
    [userId, campaignId],
  );
  return result.rows.map((row) => row.id);
}

function priorityRank(recommendation: AutonomousLeadRecommendation): number {
  const rank: Record<string, number> = {
    low: 1,
    medium: 2,
    high: 3,
    urgent: 4,
    executive_attention: 5,
  };
  return rank[recommendation.priority.priorityLevel] ?? 0;
}

export function sortAutonomousRecommendations(
  recommendations: AutonomousLeadRecommendation[],
): AutonomousLeadRecommendation[] {
  return [...recommendations].sort((a, b) => {
    const aBlocked = !a.safety.allowed || a.safety.status === "blocked";
    const bBlocked = !b.safety.allowed || b.safety.status === "blocked";
    if (aBlocked !== bBlocked) return aBlocked ? -1 : 1;
    if (a.replyContext.meetingReady !== b.replyContext.meetingReady) return a.replyContext.meetingReady ? -1 : 1;
    const rankDiff = priorityRank(b) - priorityRank(a);
    if (rankDiff !== 0) return rankDiff;
    return b.replyContext.hotLeadScore - a.replyContext.hotLeadScore;
  });
}

export async function getCampaignAutonomousRecommendations(userId: number, campaignId: number) {
  const recipientIds = await fetchCampaignRecipientIds(userId, campaignId);
  const recommendations = await Promise.all(
    recipientIds.map((recipientId) => getAutonomousLeadRecommendation({ userId, campaignId, recipientId })),
  );
  return sortAutonomousRecommendations(
    recommendations.filter((rec): rec is AutonomousLeadRecommendation => rec != null),
  );
}

export async function getCampaignAutonomousSummary(
  userId: number,
  campaignId: number,
): Promise<CampaignAutonomousSummary> {
  const recommendations = await getCampaignAutonomousRecommendations(userId, campaignId);
  const urgentLeads = recommendations.filter((rec) =>
    rec.priority.priorityLevel === "urgent" || rec.priority.priorityLevel === "executive_attention"
  ).length;
  const meetingReadyLeads = recommendations.filter((rec) => rec.replyContext.meetingReady).length;
  const humanReviewNeeded = recommendations.filter((rec) =>
    rec.humanEscalation.escalate || rec.safety.requiresHumanApproval || rec.adaptationPreview?.requiresHumanReview
  ).length;
  const safetyBlockedLeads = recommendations.filter((rec) => !rec.safety.allowed || rec.safety.status === "blocked").length;

  const recommendedCampaignAction = safetyBlockedLeads > 0
    ? "Review safety-blocked leads and ensure no automation continues for them."
    : meetingReadyLeads > 0
      ? "Review meeting-ready leads first."
      : urgentLeads > 0
        ? "Prioritize urgent leads before routine follow-ups."
        : "Continue current sequence and monitor reply intelligence.";

  const topOptimizationRecommendation = recommendations.some((rec) => rec.adaptationPreview?.recommendedAction === "switch_to_value_cta")
    ? "Use value-focused follow-ups where objections are present."
    : recommendations.some((rec) => rec.adaptationPreview?.recommendedAction === "shorten_future_touches")
      ? "Shorten future touches for high deliverability-risk leads."
      : "Keep future touches reviewable and avoid autonomous send changes.";

  return {
    campaignId,
    urgentLeads,
    meetingReadyLeads,
    humanReviewNeeded,
    safetyBlockedLeads,
    recommendedCampaignAction,
    topOptimizationRecommendation,
    topPriorities: recommendations.slice(0, 5),
  };
}
