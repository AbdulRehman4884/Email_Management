import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  campaignSequenceTouchesTable,
  campaignTable,
  emailRepliesTable,
  recipientSequenceStateTable,
  recipientTable,
  replyIntelligenceTable,
  suppressionListTable,
} from "../db/schema.js";
import { db } from "./db.js";
import { dbPool } from "./db.js";
import { generateReplySuggestion } from "./objectionHandling.js";
import { recordRecipientReply } from "./replyDetection.js";
import { stopRecipientSequence, type SequenceStopReason, type SequenceStatus } from "./sequenceExecutionEngine.js";

export type ReplyIntentCategory =
  | "positive_interest"
  | "meeting_interest"
  | "objection_price"
  | "objection_timing"
  | "objection_competitor"
  | "objection_authority"
  | "unsubscribe_request"
  | "negative_not_interested"
  | "neutral_question"
  | "auto_reply"
  | "spam_warning";

export type ReplySentiment = "positive" | "neutral" | "negative";
export type UrgencyLevel = "low" | "medium" | "high";
export type LeadTemperature = "cold" | "warm" | "hot" | "meeting_ready";
export type AutoReplyStrategyMode =
  | "suggest_only"
  | "draft_reply"
  | "auto_reply_safe"
  | "human_review_required";
export type ReplyReviewStatus = "pending" | "human_review" | "reviewed";
export type ObjectionType =
  | "pricing"
  | "timing"
  | "competitor"
  | "authority"
  | "trust"
  | "complexity"
  | "implementation_effort"
  | "no_perceived_need";

export interface DetectReplyIntentResult {
  category: ReplyIntentCategory;
  confidence: number;
  sentiment: ReplySentiment;
  buyingSignalStrength: number;
  urgencyLevel: UrgencyLevel;
  meetingLikelihood: number;
  requiresHumanReview: boolean;
}

export interface HotLeadScoreResult {
  leadTemperature: LeadTemperature;
  hotLeadScore: number;
  reasons: string[];
}

export interface MeetingReadyResult {
  meetingReady: boolean;
  reasons: string[];
}

export interface ReplyIntelligenceResult extends DetectReplyIntentResult, HotLeadScoreResult {
  objectionType: ObjectionType | null;
  reviewStatus: ReplyReviewStatus;
  autoReplyMode: AutoReplyStrategyMode;
  detectedLanguage: string;
  meetingReady: boolean;
  reviewReason: string | null;
  responseTimeMinutes: number | null;
  priorReplyCount: number;
  isHighValueLead: boolean;
  summary: string;
  reasoning: string[];
  suggestedReplyText: string | null;
  suggestedReplyHtml: string | null;
  suggestionDiagnostics: string | null;
}

interface ReplyContext {
  replyId: number;
  campaignId: number;
  recipientId: number;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  receivedAt: Date;
  fromEmail: string;
  recipientName: string | null;
  recipientEmail: string;
  senderName: string | null;
  senderEmail: string | null;
  recipientTitle: string | null;
  leadScore: number | null;
  priorReplyCount: number;
  responseTimeMinutes: number | null;
  isSuppressed: boolean;
}

const EXECUTIVE_TITLE_RE = /\b(founder|co[- ]?founder|ceo|chief|cfo|cto|coo|president|vp|vice president|head of|director)\b/i;
const LEGAL_REVIEW_RE = /\b(lawyer|attorney|legal|gdpr|privacy|compliance|can-spam|report|remove my data|cease)\b/i;
const ANGRY_RE = /\b(stop spamming|spam|harassing|annoying|report you|abuse|complaint)\b/i;
const AUTO_REPLY_RE = /\b(out of office|ooo\b|vacation|automatic reply|auto(?:matic)? reply|away from the office|mailbox unavailable)\b/i;
const MEETING_RE = /\b(book a meeting|book a demo|schedule a call|schedule time|send your calendar|available next week|available tomorrow|can we talk|let'?s talk|let'?s schedule|share your calendar|demo)\b/i;
const POSITIVE_RE = /\b(interesting|interested|share more|tell me more|sounds good|looks good|worth learning|curious|send more|would love to learn)\b/i;
const UNSUBSCRIBE_RE = /\b(unsubscribe|remove me|stop emailing|take me off|do not contact|opt out)\b/i;
const SPAM_RE = /\b(this is spam|stop spamming|spam complaint|report spam)\b/i;
const NEGATIVE_RE = /\b(not interested|no thanks|no thank you|not for us|pass on this|please stop reaching out)\b/i;
const PRICING_RE = /\b(too expensive|no budget|budget issue|out of budget|price|pricing)\b/i;
const TIMING_RE = /\b(not right now|next quarter|later this year|bad timing|circle back|timing isn'?t right)\b/i;
const COMPETITOR_RE = /\b(already use|already using|using hubspot|using salesforce|using another vendor|existing vendor|competitor)\b/i;
const AUTHORITY_RE = /\b(not the right person|wrong person|talk to|speak with|someone else handles|not my area)\b/i;
const TRUST_RE = /\b(proof|reference|customer story|case study|trust|security|compliance)\b/i;
const COMPLEXITY_RE = /\b(too complex|complicated|hard to use|complexity)\b/i;
const IMPLEMENTATION_RE = /\b(implementation|integration|migration|rollout|setup effort|too much effort)\b/i;
const NEED_RE = /\b(don'?t need|no need|not a priority|not relevant)\b/i;
const URGENT_RE = /\b(today|tomorrow|asap|this week|urgent|soon)\b/i;

function normalizeText(value: string): string {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function clampScore(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseCustomFields(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numericField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function detectLanguage(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(hola|gracias|por favor)\b/.test(lower)) return "es";
  if (/\b(bonjour|merci)\b/.test(lower)) return "fr";
  if (/\b(hallo|danke)\b/.test(lower)) return "de";
  return "en";
}

function summarizeReply(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= 220) return normalized;
  return `${normalized.slice(0, 217).trim()}...`;
}

function categorySentiment(category: ReplyIntentCategory): ReplySentiment {
  switch (category) {
    case "positive_interest":
    case "meeting_interest":
      return "positive";
    case "unsubscribe_request":
    case "negative_not_interested":
    case "spam_warning":
    case "objection_price":
    case "objection_timing":
    case "objection_competitor":
    case "objection_authority":
      return "negative";
    default:
      return "neutral";
  }
}

function classifyObjectionType(text: string, category: ReplyIntentCategory): ObjectionType | null {
  if (category === "objection_price") return "pricing";
  if (category === "objection_timing") return "timing";
  if (category === "objection_competitor") return "competitor";
  if (category === "objection_authority") return "authority";
  if (TRUST_RE.test(text)) return "trust";
  if (COMPLEXITY_RE.test(text)) return "complexity";
  if (IMPLEMENTATION_RE.test(text)) return "implementation_effort";
  if (NEED_RE.test(text)) return "no_perceived_need";
  return null;
}

export function detectReplyIntent(input: {
  subject?: string | null;
  bodyText?: string | null;
}): DetectReplyIntentResult {
  const combined = `${input.subject ?? ""}\n${input.bodyText ?? ""}`.toLowerCase();

  const match = (regex: RegExp) => regex.test(combined);

  let category: ReplyIntentCategory = "neutral_question";
  let confidence = 0.6;
  if (match(AUTO_REPLY_RE)) {
    category = "auto_reply";
    confidence = 0.93;
  } else if (match(UNSUBSCRIBE_RE)) {
    category = "unsubscribe_request";
    confidence = 0.98;
  } else if (match(SPAM_RE)) {
    category = "spam_warning";
    confidence = 0.98;
  } else if (match(MEETING_RE)) {
    category = "meeting_interest";
    confidence = 0.94;
  } else if (match(PRICING_RE)) {
    category = "objection_price";
    confidence = 0.9;
  } else if (match(TIMING_RE)) {
    category = "objection_timing";
    confidence = 0.88;
  } else if (match(COMPETITOR_RE)) {
    category = "objection_competitor";
    confidence = 0.88;
  } else if (match(AUTHORITY_RE)) {
    category = "objection_authority";
    confidence = 0.87;
  } else if (match(NEGATIVE_RE)) {
    category = "negative_not_interested";
    confidence = 0.92;
  } else if (combined.includes("?")) {
    category = "neutral_question";
    confidence = 0.72;
  } else if (match(POSITIVE_RE)) {
    category = "positive_interest";
    confidence = 0.84;
  }

  const urgencyLevel: UrgencyLevel = URGENT_RE.test(combined)
    ? "high"
    : /\b(next week|soon|this month)\b/.test(combined)
      ? "medium"
      : "low";

  const buyingSignalStrength = clampScore(
    category === "meeting_interest"
      ? 95
      : category === "positive_interest"
        ? 70
        : category === "neutral_question"
          ? 45
          : /^objection_/.test(category)
            ? 28
            : category === "auto_reply"
              ? 5
              : 0,
  );

  const meetingLikelihood = clampScore(
    category === "meeting_interest"
      ? 95
      : category === "positive_interest"
        ? 65
        : category === "neutral_question"
          ? 35
          : 5,
  );

  const requiresHumanReview =
    confidence < 0.62 ||
    match(LEGAL_REVIEW_RE) ||
    match(ANGRY_RE) ||
    category === "spam_warning";

  return {
    category,
    confidence: Number(confidence.toFixed(2)),
    sentiment: categorySentiment(category),
    buyingSignalStrength,
    urgencyLevel,
    meetingLikelihood,
    requiresHumanReview,
  };
}

export function detectMeetingReadyLead(input: {
  category: ReplyIntentCategory;
  meetingLikelihood: number;
  urgencyLevel: UrgencyLevel;
  recipientTitle?: string | null;
}): MeetingReadyResult {
  const reasons: string[] = [];
  const decisionMaker = EXECUTIVE_TITLE_RE.test(String(input.recipientTitle ?? ""));
  if (input.category === "meeting_interest") reasons.push("Explicit meeting language detected");
  if (input.meetingLikelihood >= 80) reasons.push("High meeting likelihood");
  if (input.urgencyLevel === "high") reasons.push("Urgent timing language detected");
  if (decisionMaker) reasons.push("Executive or decision-maker title detected");
  return {
    meetingReady:
      input.category === "meeting_interest" ||
      (input.meetingLikelihood >= 85 && input.urgencyLevel !== "low") ||
      (input.meetingLikelihood >= 80 && decisionMaker),
    reasons,
  };
}

export function scoreHotLead(input: {
  category: ReplyIntentCategory;
  sentiment: ReplySentiment;
  urgencyLevel: UrgencyLevel;
  meetingLikelihood: number;
  priorReplyCount: number;
  responseTimeMinutes: number | null;
  recipientTitle?: string | null;
  leadScore?: number | null;
  meetingReady?: boolean;
}): HotLeadScoreResult {
  let score = 0;
  const reasons: string[] = [];

  if (input.category === "meeting_interest") {
    score += 55;
    reasons.push("Explicit meeting language");
  } else if (input.category === "positive_interest") {
    score += 28;
    reasons.push("Positive interest reply");
  } else if (input.category === "neutral_question") {
    score += 18;
    reasons.push("Engaged question from lead");
  }

  if (input.sentiment === "positive") {
    score += 10;
    reasons.push("Positive sentiment");
  }
  if (input.urgencyLevel === "high") {
    score += 15;
    reasons.push("Urgent reply timing");
  } else if (input.urgencyLevel === "medium") {
    score += 8;
  }
  if (input.priorReplyCount >= 1) {
    score += 10;
    reasons.push("Multiple reply signals");
  }
  if (input.responseTimeMinutes != null && input.responseTimeMinutes <= 120) {
    score += 10;
    reasons.push("Fast response time");
  }
  if (EXECUTIVE_TITLE_RE.test(String(input.recipientTitle ?? ""))) {
    score += 10;
    reasons.push("Executive title");
  }
  if ((input.leadScore ?? 0) >= 80) {
    score += 8;
    reasons.push("High lead score");
  }
  score += Math.round(input.meetingLikelihood * 0.12);

  const hotLeadScore = clampScore(score);
  const leadTemperature: LeadTemperature =
    input.meetingReady || hotLeadScore >= 90
      ? "meeting_ready"
      : hotLeadScore >= 70
        ? "hot"
        : hotLeadScore >= 40
          ? "warm"
          : "cold";

  return {
    leadTemperature,
    hotLeadScore,
    reasons,
  };
}

function autoReplyModeFor(input: {
  category: ReplyIntentCategory;
  requiresHumanReview: boolean;
  isHighValueLead: boolean;
  meetingReady: boolean;
}): AutoReplyStrategyMode {
  if (
    input.requiresHumanReview ||
    input.category === "unsubscribe_request" ||
    input.category === "spam_warning" ||
    input.isHighValueLead ||
    input.meetingReady
  ) {
    return "human_review_required";
  }
  if (input.category === "positive_interest" || input.category === "meeting_interest" || input.category === "neutral_question") {
    return "draft_reply";
  }
  if (/^objection_/.test(input.category)) {
    return "auto_reply_safe";
  }
  return "suggest_only";
}

function reviewReasonFor(input: {
  requiresHumanReview: boolean;
  category: ReplyIntentCategory;
  isHighValueLead: boolean;
  confidence: number;
  meetingReady: boolean;
  text: string;
}): string | null {
  if (input.category === "unsubscribe_request") return "Unsubscribe requests should not receive an auto-reply.";
  if (input.category === "spam_warning") return "Spam complaint detected.";
  if (LEGAL_REVIEW_RE.test(input.text)) return "Legal or compliance language detected.";
  if (input.meetingReady) return "Meeting-ready leads should be prioritized for a human response.";
  if (input.isHighValueLead) return "High-value lead detected.";
  if (input.confidence < 0.62) return "Intent confidence is low.";
  return input.requiresHumanReview ? "Reply tone or risk requires human review." : null;
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

async function loadReplyContext(replyId: number): Promise<ReplyContext | null> {
  const [row] = await db
    .select({
      replyId: emailRepliesTable.id,
      campaignId: emailRepliesTable.campaignId,
      recipientId: emailRepliesTable.recipientId,
      subject: emailRepliesTable.subject,
      bodyText: emailRepliesTable.bodyText,
      bodyHtml: emailRepliesTable.bodyHtml,
      receivedAt: emailRepliesTable.receivedAt,
      fromEmail: emailRepliesTable.fromEmail,
      recipientName: recipientTable.name,
      recipientEmail: recipientTable.email,
      customFields: recipientTable.customFields,
      senderName: campaignTable.fromName,
      senderEmail: campaignTable.fromEmail,
      sequenceLastTouchSentAt: recipientSequenceStateTable.lastTouchSentAt,
      recipientSentAt: recipientTable.sentAt,
    })
    .from(emailRepliesTable)
    .innerJoin(recipientTable, eq(emailRepliesTable.recipientId, recipientTable.id))
    .innerJoin(campaignTable, eq(emailRepliesTable.campaignId, campaignTable.id))
    .leftJoin(
      recipientSequenceStateTable,
      and(
        eq(recipientSequenceStateTable.campaignId, emailRepliesTable.campaignId),
        eq(recipientSequenceStateTable.recipientId, emailRepliesTable.recipientId),
      ),
    )
    .where(eq(emailRepliesTable.id, replyId))
    .limit(1);

  if (!row) return null;

  const customFields = parseCustomFields(row.customFields);
  const recipientTitle = stringField(customFields, ["title", "role", "jobTitle", "seniority"]);
  const leadScore = numericField(customFields, ["leadScore", "score", "lead_score"]);

  const [priorReplyRow] = await db
    .select({ count: count() })
    .from(emailRepliesTable)
    .where(and(
      eq(emailRepliesTable.campaignId, row.campaignId),
      eq(emailRepliesTable.recipientId, row.recipientId),
      eq(emailRepliesTable.direction, "inbound"),
      sql`${emailRepliesTable.id} <> ${replyId}`,
    ));
  const priorReplyCount = Number(priorReplyRow?.count ?? 0);

  const [touchRow] = await db
    .select({ sentAt: campaignSequenceTouchesTable.sentAt })
    .from(campaignSequenceTouchesTable)
    .where(and(
      eq(campaignSequenceTouchesTable.campaignId, row.campaignId),
      eq(campaignSequenceTouchesTable.recipientId, row.recipientId),
      sql`${campaignSequenceTouchesTable.sentAt} IS NOT NULL`,
    ))
    .orderBy(desc(campaignSequenceTouchesTable.sentAt))
    .limit(1);

  const receivedAt = coerceDate(row.receivedAt) ?? new Date();
  const lastSentAt =
    coerceDate(touchRow?.sentAt) ??
    coerceDate(row.sequenceLastTouchSentAt) ??
    coerceDate(row.recipientSentAt);
  const responseTimeMinutes = lastSentAt
    ? Math.max(0, Math.round((receivedAt.getTime() - lastSentAt.getTime()) / 60000))
    : null;

  const [suppressed] = await db
    .select({ id: suppressionListTable.id })
    .from(suppressionListTable)
    .where(eq(suppressionListTable.email, row.recipientEmail.toLowerCase()))
    .limit(1);

  return {
    replyId: row.replyId,
    campaignId: row.campaignId,
    recipientId: row.recipientId,
    subject: row.subject,
    bodyText: row.bodyText?.trim() || row.bodyHtml?.replace(/<[^>]+>/g, " ").trim() || "",
    bodyHtml: row.bodyHtml,
    receivedAt,
    fromEmail: row.fromEmail,
    recipientName: row.recipientName,
    recipientEmail: row.recipientEmail,
    senderName: row.senderName,
    senderEmail: row.senderEmail,
    recipientTitle,
    leadScore,
    priorReplyCount,
    responseTimeMinutes,
    isSuppressed: Boolean(suppressed),
  };
}

export function analyzeReplyIntelligence(input: {
  subject?: string | null;
  bodyText?: string | null;
  recipientTitle?: string | null;
  leadScore?: number | null;
  priorReplyCount?: number;
  responseTimeMinutes?: number | null;
}): Omit<ReplyIntelligenceResult, "suggestedReplyText" | "suggestedReplyHtml" | "suggestionDiagnostics"> {
  const detected = detectReplyIntent({
    subject: input.subject,
    bodyText: input.bodyText,
  });
  const fullText = `${input.subject ?? ""}\n${input.bodyText ?? ""}`.toLowerCase();
  const objectionType = classifyObjectionType(fullText, detected.category);
  const isHighValueLead =
    EXECUTIVE_TITLE_RE.test(String(input.recipientTitle ?? "")) ||
    (input.leadScore ?? 0) >= 85;
  const meetingReadyResult = detectMeetingReadyLead({
    category: detected.category,
    meetingLikelihood: detected.meetingLikelihood,
    urgencyLevel: detected.urgencyLevel,
    recipientTitle: input.recipientTitle,
  });
  const hotLead = scoreHotLead({
    category: detected.category,
    sentiment: detected.sentiment,
    urgencyLevel: detected.urgencyLevel,
    meetingLikelihood: detected.meetingLikelihood,
    priorReplyCount: input.priorReplyCount ?? 0,
    responseTimeMinutes: input.responseTimeMinutes ?? null,
    recipientTitle: input.recipientTitle,
    leadScore: input.leadScore,
    meetingReady: meetingReadyResult.meetingReady,
  });
  const autoReplyMode = autoReplyModeFor({
    category: detected.category,
    requiresHumanReview: detected.requiresHumanReview,
    isHighValueLead,
    meetingReady: meetingReadyResult.meetingReady,
  });
  const reviewReason = reviewReasonFor({
    requiresHumanReview: detected.requiresHumanReview,
    category: detected.category,
    isHighValueLead,
    confidence: detected.confidence,
    meetingReady: meetingReadyResult.meetingReady,
    text: fullText,
  });
  const reasoning = [
    `Detected category: ${detected.category}.`,
    `Sentiment: ${detected.sentiment}.`,
    ...(objectionType ? [`Objection type: ${objectionType}.`] : []),
    ...meetingReadyResult.reasons.map((reason) => `Meeting-ready signal: ${reason}`),
    ...hotLead.reasons.map((reason) => `Hot lead signal: ${reason}`),
  ];

  return {
    ...detected,
    ...hotLead,
    objectionType,
    reviewStatus: reviewReason ? "human_review" : "pending",
    autoReplyMode,
    detectedLanguage: detectLanguage(fullText),
    meetingReady: meetingReadyResult.meetingReady,
    reviewReason,
    responseTimeMinutes: input.responseTimeMinutes ?? null,
    priorReplyCount: input.priorReplyCount ?? 0,
    isHighValueLead,
    summary: summarizeReply(input.bodyText ?? ""),
    reasoning,
  };
}

export async function analyzeAndStoreReplyIntelligence(replyId: number): Promise<ReplyIntelligenceResult> {
  const context = await loadReplyContext(replyId);
  if (!context) {
    throw new Error(`Reply ${replyId} not found for intelligence analysis`);
  }

  const base = analyzeReplyIntelligence({
    subject: context.subject,
    bodyText: context.bodyText,
    recipientTitle: context.recipientTitle,
    leadScore: context.leadScore,
    priorReplyCount: context.priorReplyCount,
    responseTimeMinutes: context.responseTimeMinutes,
  });

  const suggestion = generateReplySuggestion({
    analysis: base,
    replySubject: context.subject,
    recipientName: context.recipientName,
    senderName: context.senderName,
    senderEmail: context.senderEmail,
    recipientEmail: context.recipientEmail,
    smtpProvider: "unknown",
  });

  const full: ReplyIntelligenceResult = {
    ...base,
    suggestedReplyText: suggestion?.bodyText ?? null,
    suggestedReplyHtml: suggestion?.bodyHtml ?? null,
    suggestionDiagnostics: suggestion
      ? JSON.stringify({
          autoReplyMode: suggestion.autoReplyMode,
          quality: suggestion.quality,
          deliverability: {
            inboxRisk: suggestion.deliverability.inboxRisk,
            likelyTab: suggestion.deliverability.likelyTab,
            reasons: suggestion.deliverability.reasons,
          },
          reasoning: suggestion.reasoning,
        })
      : null,
  };

  const existing = await getReplyIntelligenceByReplyId(replyId);
  const payload = {
    replyId,
    campaignId: context.campaignId,
    recipientId: context.recipientId,
    intentCategory: full.category,
    intentConfidence: full.confidence,
    sentiment: full.sentiment,
    buyingSignalStrength: full.buyingSignalStrength,
    urgencyLevel: full.urgencyLevel,
    meetingLikelihood: full.meetingLikelihood,
    objectionType: full.objectionType,
    meetingReady: full.meetingReady,
    leadTemperature: full.leadTemperature,
    hotLeadScore: full.hotLeadScore,
    requiresHumanReview: full.requiresHumanReview,
    reviewStatus: full.reviewStatus,
    reviewReason: full.reviewReason,
    autoReplyMode: full.autoReplyMode,
    detectedLanguage: full.detectedLanguage,
    replySummary: full.summary,
    suggestedReplyText: full.suggestedReplyText,
    suggestedReplyHtml: full.suggestedReplyHtml,
    suggestionDiagnostics: full.suggestionDiagnostics,
    reasoning: JSON.stringify(full.reasoning),
    responseTimeMinutes: full.responseTimeMinutes,
    priorReplyCount: full.priorReplyCount,
    isHighValueLead: full.isHighValueLead,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(replyIntelligenceTable).set(payload).where(eq(replyIntelligenceTable.replyId, replyId));
  } else {
    await db.insert(replyIntelligenceTable).values(payload);
  }

  return full;
}

export async function applyReplyIntelligenceStopRules(input: {
  campaignId: number;
  recipientId: number;
  recipientEmail?: string | null;
  analysis: Pick<ReplyIntelligenceResult, "category" | "meetingReady">;
  occurredAt?: Date;
}): Promise<{ action: string; markedReplied: boolean }> {
  const occurredAt = input.occurredAt ?? new Date();

  if (input.analysis.category === "auto_reply") {
    return { action: "auto_reply_no_stop", markedReplied: false };
  }

  const replyRecord = await recordRecipientReply({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    repliedAt: occurredAt,
  });

  let sequenceStatus: Extract<SequenceStatus, "paused" | "stopped" | "bounced" | "replied" | "unsubscribed" | "completed"> = "paused";
  let stopReason: SequenceStopReason = "replied";
  let pauseFlag = true;
  let action = "paused_pending_reply";

  switch (input.analysis.category) {
    case "meeting_interest":
      sequenceStatus = "replied";
      stopReason = "meeting_ready";
      pauseFlag = false;
      action = "stopped_meeting_ready";
      break;
    case "positive_interest":
      sequenceStatus = "paused";
      stopReason = "positive_interest";
      pauseFlag = true;
      action = "paused_positive_interest";
      break;
    case "unsubscribe_request":
      sequenceStatus = "unsubscribed";
      stopReason = "unsubscribed";
      pauseFlag = false;
      action = "stopped_unsubscribed";
      if (input.recipientEmail) {
        await dbPool.query(
          `INSERT INTO suppression_list (email, reason)
           VALUES ($1, $2)
           ON CONFLICT (email) DO NOTHING`,
          [input.recipientEmail.toLowerCase().trim(), "reply_unsubscribe_request"],
        );
      }
      break;
    case "negative_not_interested":
      sequenceStatus = "stopped";
      stopReason = "not_interested";
      pauseFlag = false;
      action = "stopped_not_interested";
      break;
    case "spam_warning":
      sequenceStatus = "stopped";
      stopReason = "spam_complaint";
      pauseFlag = false;
      action = "stopped_spam_complaint";
      break;
    default:
      sequenceStatus = /^objection_/.test(input.analysis.category) ? "paused" : "paused";
      stopReason = /^objection_/.test(input.analysis.category) ? "objection" : "replied";
      pauseFlag = true;
      action = /^objection_/.test(input.analysis.category) ? "paused_objection" : "paused_pending_reply";
      break;
  }

  await stopRecipientSequence({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    sequenceStatus,
    stopReason,
    occurredAt,
    pauseFlag,
  });

  return { action, markedReplied: !replyRecord.alreadyMarked };
}

export async function getReplyIntelligenceByReplyId(replyId: number): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(replyIntelligenceTable)
    .where(eq(replyIntelligenceTable.replyId, replyId))
    .limit(1);
  return row ?? null;
}

export async function markReplyForHumanReview(replyId: number, reason?: string | null): Promise<void> {
  await db
    .update(replyIntelligenceTable)
    .set({
      requiresHumanReview: true,
      reviewStatus: "human_review",
      reviewReason: reason?.trim() || "Marked for human review.",
      updatedAt: new Date(),
    })
    .where(eq(replyIntelligenceTable.replyId, replyId));
}

export async function listHotLeads(input: {
  userId: number;
  campaignId?: number | null;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const rows = await db
    .select({
      replyId: replyIntelligenceTable.replyId,
      campaignId: replyIntelligenceTable.campaignId,
      recipientId: replyIntelligenceTable.recipientId,
      category: replyIntelligenceTable.intentCategory,
      hotLeadScore: replyIntelligenceTable.hotLeadScore,
      leadTemperature: replyIntelligenceTable.leadTemperature,
      meetingReady: replyIntelligenceTable.meetingReady,
      replySummary: replyIntelligenceTable.replySummary,
      receivedAt: emailRepliesTable.receivedAt,
      subject: emailRepliesTable.subject,
      recipientEmail: recipientTable.email,
      recipientName: recipientTable.name,
      campaignName: campaignTable.name,
    })
    .from(replyIntelligenceTable)
    .innerJoin(emailRepliesTable, eq(replyIntelligenceTable.replyId, emailRepliesTable.id))
    .innerJoin(campaignTable, eq(replyIntelligenceTable.campaignId, campaignTable.id))
    .innerJoin(recipientTable, eq(replyIntelligenceTable.recipientId, recipientTable.id))
    .where(and(
      eq(campaignTable.userId, input.userId),
      sql`${replyIntelligenceTable.hotLeadScore} >= 40`,
      ...(input.campaignId ? [eq(replyIntelligenceTable.campaignId, input.campaignId)] : []),
    ))
    .orderBy(desc(replyIntelligenceTable.hotLeadScore), desc(emailRepliesTable.receivedAt))
    .limit(limit);
  return rows;
}

export async function listMeetingReadyLeads(input: {
  userId: number;
  campaignId?: number | null;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 10));
  const rows = await db
    .select({
      replyId: replyIntelligenceTable.replyId,
      campaignId: replyIntelligenceTable.campaignId,
      recipientId: replyIntelligenceTable.recipientId,
      category: replyIntelligenceTable.intentCategory,
      hotLeadScore: replyIntelligenceTable.hotLeadScore,
      reviewReason: replyIntelligenceTable.reviewReason,
      replySummary: replyIntelligenceTable.replySummary,
      receivedAt: emailRepliesTable.receivedAt,
      subject: emailRepliesTable.subject,
      recipientEmail: recipientTable.email,
      recipientName: recipientTable.name,
      campaignName: campaignTable.name,
    })
    .from(replyIntelligenceTable)
    .innerJoin(emailRepliesTable, eq(replyIntelligenceTable.replyId, emailRepliesTable.id))
    .innerJoin(campaignTable, eq(replyIntelligenceTable.campaignId, campaignTable.id))
    .innerJoin(recipientTable, eq(replyIntelligenceTable.recipientId, recipientTable.id))
    .where(and(
      eq(campaignTable.userId, input.userId),
      eq(replyIntelligenceTable.meetingReady, true),
      ...(input.campaignId ? [eq(replyIntelligenceTable.campaignId, input.campaignId)] : []),
    ))
    .orderBy(desc(emailRepliesTable.receivedAt))
    .limit(limit);
  return rows;
}

export async function summarizeObjections(input: {
  userId: number;
  campaignId?: number | null;
}): Promise<{
  totalReplies: number;
  positiveReplyRate: number;
  meetingReadyCount: number;
  unsubscribeCount: number;
  sentimentDistribution: Record<string, number>;
  objectionBreakdown: Record<string, number>;
  hottestLeadScore: number;
  averageResponseTimeMinutes: number;
  sequenceToMeetingConversion: number;
}> {
  const rows = await db
    .select({
      category: replyIntelligenceTable.intentCategory,
      sentiment: replyIntelligenceTable.sentiment,
      objectionType: replyIntelligenceTable.objectionType,
      hotLeadScore: replyIntelligenceTable.hotLeadScore,
      responseTimeMinutes: replyIntelligenceTable.responseTimeMinutes,
      meetingReady: replyIntelligenceTable.meetingReady,
    })
    .from(replyIntelligenceTable)
    .innerJoin(campaignTable, eq(replyIntelligenceTable.campaignId, campaignTable.id))
    .where(and(
      eq(campaignTable.userId, input.userId),
      ...(input.campaignId ? [eq(replyIntelligenceTable.campaignId, input.campaignId)] : []),
    ));

  const totalReplies = rows.length;
  const positiveReplies = rows.filter((row) => row.category === "positive_interest" || row.category === "meeting_interest").length;
  const meetingReadyCount = rows.filter((row) => row.meetingReady).length;
  const unsubscribeCount = rows.filter((row) => row.category === "unsubscribe_request").length;
  const objectionBreakdown = rows.reduce<Record<string, number>>((acc, row) => {
    if (row.objectionType) acc[row.objectionType] = (acc[row.objectionType] ?? 0) + 1;
    return acc;
  }, {});
  const sentimentDistribution = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.sentiment ?? "neutral";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const responseTimes = rows
    .map((row) => row.responseTimeMinutes)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    totalReplies,
    positiveReplyRate: totalReplies > 0 ? positiveReplies / totalReplies : 0,
    meetingReadyCount,
    unsubscribeCount,
    sentimentDistribution,
    objectionBreakdown,
    hottestLeadScore: rows.reduce((max, row) => Math.max(max, row.hotLeadScore ?? 0), 0),
    averageResponseTimeMinutes:
      responseTimes.length > 0
        ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
        : 0,
    sequenceToMeetingConversion: totalReplies > 0 ? meetingReadyCount / totalReplies : 0,
  };
}
