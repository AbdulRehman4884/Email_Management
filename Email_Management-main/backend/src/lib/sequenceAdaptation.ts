import type { AutonomousSafetyResult } from "./autonomousSafetyGuard.js";
import type { LeadPrioritizationResult } from "./leadPrioritization.js";
import type { ReplyIntelligenceResult } from "./replyIntelligence.js";

export type SequenceAdaptationAction =
  | "soften_future_touches"
  | "make_more_direct"
  | "switch_to_value_cta"
  | "switch_to_reply_cta"
  | "shorten_future_touches"
  | "pause_sequence"
  | "stop_sequence"
  | "escalate_to_human"
  | "keep_sequence_unchanged";

export interface AdaptableSequenceTouch {
  id?: number;
  touchNumber: number;
  objective?: string | null;
  recommendedDelayDays?: number | null;
  toneUsed?: string | null;
  ctaType?: string | null;
  ctaText?: string | null;
  personalizedSubject?: string | null;
  personalizedBody: string;
  personalizedText?: string | null;
  previousTouchSummary?: string | null;
  deliverabilityRisk?: string | null;
  strategyReasoning?: string | null;
  executionStatus?: string | null;
  sentAt?: Date | string | null;
  [key: string]: unknown;
}

export interface DeliverabilitySignals {
  inboxRisk?: "low" | "medium" | "high" | string | null;
  likelyTab?: string | null;
  linkCount?: number | null;
  promotionalKeywordScore?: number | null;
  reasons?: string[] | null;
  recommendations?: string[] | null;
}

export interface SequenceAdaptationInput {
  currentTouches: AdaptableSequenceTouch[];
  replyIntelligence?: Partial<ReplyIntelligenceResult> | null;
  objectionType?: string | null;
  leadPriority?: Partial<LeadPrioritizationResult> | null;
  deliverabilityDiagnostics?: DeliverabilitySignals | null;
  safetyGuard?: AutonomousSafetyResult | null;
  previousTouchHistory?: AdaptableSequenceTouch[] | null;
}

export interface SequenceAdaptationResult {
  adaptedTouches: AdaptableSequenceTouch[];
  adaptationSummary: string;
  changedTouchNumbers: number[];
  adaptationReasons: string[];
  requiresHumanReview: boolean;
  safetyBlocked: boolean;
  recommendedAction: SequenceAdaptationAction;
}

const MEETING_HEAVY_RE = /\b(book|schedule|demo|meeting|calendar|call|15[- ]?minute|30[- ]?minute)\b/gi;
const PROMOTIONAL_RE = /\b(amazing|best|guaranteed|revolutionary|limited time|act now|free trial|discount|deal)\b/gi;

function cloneTouch(touch: AdaptableSequenceTouch): AdaptableSequenceTouch {
  return { ...touch };
}

function isUnsentFutureTouch(touch: AdaptableSequenceTouch): boolean {
  const status = String(touch.executionStatus ?? "").toLowerCase();
  return touch.sentAt == null && status !== "sent" && status !== "sending" && status !== "skipped";
}

function normalizeBody(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function shortenBody(body: string, maxChars = 520): string {
  const plain = normalizeBody(body.replace(/<[^>]*>/g, " "));
  if (plain.length <= maxChars) return plain;
  const truncated = plain.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return `${truncated}.`;
}

function removeMeetingPressure(body: string): string {
  return normalizeBody(body.replace(MEETING_HEAVY_RE, "chat"));
}

function reducePromotionalLanguage(body: string): string {
  return normalizeBody(body.replace(PROMOTIONAL_RE, "useful"));
}

function applyValueCta(touch: AdaptableSequenceTouch): AdaptableSequenceTouch {
  return {
    ...touch,
    ctaType: "value_cta",
    ctaText: "I can share a practical example if useful.",
    toneUsed: touch.toneUsed ?? "consultant_style",
    personalizedBody: `${removeMeetingPressure(shortenBody(touch.personalizedBody, 700))}\n\nIf helpful, I can send a lightweight example of where teams usually start.`,
    personalizedText: `${removeMeetingPressure(shortenBody(touch.personalizedText ?? touch.personalizedBody, 700))}\n\nIf helpful, I can send a lightweight example of where teams usually start.`,
    strategyReasoning: appendReason(touch.strategyReasoning, "Adapted for pricing objection: value-focused CTA and less meeting-heavy language."),
  };
}

function applyCompetitorFraming(touch: AdaptableSequenceTouch): AdaptableSequenceTouch {
  return {
    ...touch,
    ctaType: "value_cta",
    ctaText: "Worth comparing where manual work still exists?",
    toneUsed: touch.toneUsed ?? "consultant_style",
    personalizedBody: `Makes sense if you already have a platform in place. ${shortenBody(touch.personalizedBody, 560)}\n\nThe useful comparison is usually where manual work still exists around the current setup.`,
    personalizedText: `Makes sense if you already have a platform in place. ${shortenBody(touch.personalizedText ?? touch.personalizedBody, 560)}\n\nThe useful comparison is usually where manual work still exists around the current setup.`,
    strategyReasoning: appendReason(touch.strategyReasoning, "Adapted for competitor objection: acknowledge current setup and focus on workflow gaps."),
  };
}

function applyTimingDelay(touch: AdaptableSequenceTouch): AdaptableSequenceTouch {
  const currentDelay = Math.max(0, Number(touch.recommendedDelayDays ?? 0));
  return {
    ...touch,
    recommendedDelayDays: Math.max(currentDelay + 7, 14),
    ctaType: "reply_cta",
    ctaText: "Would a later check-in be better?",
    toneUsed: "friendly_human",
    personalizedBody: `${shortenBody(touch.personalizedBody, 620)}\n\nNo pressure from my side. Would a later check-in be better?`,
    personalizedText: `${shortenBody(touch.personalizedText ?? touch.personalizedBody, 620)}\n\nNo pressure from my side. Would a later check-in be better?`,
    strategyReasoning: appendReason(touch.strategyReasoning, "Adapted for timing objection: delayed and softened CTA."),
  };
}

function applyDeliverabilityShortening(touch: AdaptableSequenceTouch): AdaptableSequenceTouch {
  const body = reducePromotionalLanguage(shortenBody(touch.personalizedText ?? touch.personalizedBody, 360));
  return {
    ...touch,
    personalizedBody: body,
    personalizedText: body,
    ctaType: touch.ctaType === "soft_meeting_cta" || touch.ctaType === "direct_cta" ? "reply_cta" : touch.ctaType,
    ctaText: touch.ctaText && touch.ctaText.length <= 120 ? touch.ctaText : "Worth a quick look?",
    deliverabilityRisk: "high",
    strategyReasoning: appendReason(touch.strategyReasoning, "Adapted for high deliverability risk: shortened copy and reduced promotional wording."),
  };
}

function appendReason(existing: string | null | undefined, reason: string): string {
  const base = String(existing ?? "").trim();
  return base ? `${base} ${reason}` : reason;
}

function hasHighDeliverabilityRisk(signals?: DeliverabilitySignals | null): boolean {
  if (!signals) return false;
  return signals.inboxRisk === "high" ||
    Number(signals.promotionalKeywordScore ?? 0) >= 55 ||
    Number(signals.linkCount ?? 0) >= 3;
}

function resolveAction(input: SequenceAdaptationInput): {
  action: SequenceAdaptationAction;
  reasons: string[];
  requiresHumanReview: boolean;
  safetyBlocked: boolean;
} {
  const reply = input.replyIntelligence;
  const category = String(reply?.category ?? "");
  const objectionType = String(input.objectionType ?? reply?.objectionType ?? "");
  const reasons: string[] = [];
  let requiresHumanReview = Boolean(reply?.requiresHumanReview) || Number(reply?.confidence ?? 1) < 0.55;

  if (Number(reply?.confidence ?? 1) < 0.55) {
    reasons.push("Low-confidence reply intelligence requires human review.");
  }

  if (input.safetyGuard && (!input.safetyGuard.allowed || input.safetyGuard.status !== "allowed")) {
    reasons.push(input.safetyGuard.reason ?? "Safety guard blocked autonomous adaptation.");
    return {
      action: "stop_sequence",
      reasons,
      requiresHumanReview: true,
      safetyBlocked: true,
    };
  }

  if (category === "unsubscribe_request" || category === "spam_warning") {
    reasons.push(`${category} requires stopping all automation.`);
    return { action: "stop_sequence", reasons, requiresHumanReview: true, safetyBlocked: true };
  }

  if (category === "meeting_interest" || reply?.meetingReady) {
    reasons.push("Meeting interest should stop the sequence and escalate to a human.");
    return { action: "escalate_to_human", reasons, requiresHumanReview: true, safetyBlocked: false };
  }

  if (category === "positive_interest") {
    reasons.push("Positive interest should pause automation and prompt a human reply.");
    return { action: "pause_sequence", reasons, requiresHumanReview: true, safetyBlocked: false };
  }

  if (category === "objection_price" || objectionType === "pricing") {
    reasons.push("Pricing objection detected; future touches should become value-focused.");
    return { action: "switch_to_value_cta", reasons, requiresHumanReview, safetyBlocked: false };
  }

  if (category === "objection_competitor" || objectionType === "competitor") {
    reasons.push("Competitor objection detected; future touches should acknowledge current setup and focus on gaps.");
    return { action: "switch_to_value_cta", reasons, requiresHumanReview, safetyBlocked: false };
  }

  if (category === "objection_timing" || objectionType === "timing") {
    reasons.push("Timing objection detected; future touches should be delayed and softened.");
    return { action: "soften_future_touches", reasons, requiresHumanReview, safetyBlocked: false };
  }

  if (hasHighDeliverabilityRisk(input.deliverabilityDiagnostics)) {
    reasons.push("High deliverability risk detected; future touches should be shortened.");
    return { action: "shorten_future_touches", reasons, requiresHumanReview, safetyBlocked: false };
  }

  if (input.leadPriority?.priorityLevel === "urgent" || input.leadPriority?.priorityLevel === "executive_attention") {
    reasons.push("High-priority lead should receive a more direct future CTA.");
    return { action: "make_more_direct", reasons, requiresHumanReview, safetyBlocked: false };
  }

  return {
    action: "keep_sequence_unchanged",
    reasons: reasons.length ? reasons : ["No sequence adaptation trigger detected."],
    requiresHumanReview,
    safetyBlocked: false,
  };
}

export function adaptFutureTouches(input: SequenceAdaptationInput): SequenceAdaptationResult {
  const { action, reasons, requiresHumanReview, safetyBlocked } = resolveAction(input);
  const changedTouchNumbers: number[] = [];
  const adaptedTouches = input.currentTouches.map((touch) => {
    const cloned = cloneTouch(touch);
    if (!isUnsentFutureTouch(cloned) || safetyBlocked || action === "pause_sequence" || action === "stop_sequence" || action === "escalate_to_human" || action === "keep_sequence_unchanged") {
      return cloned;
    }

    let adapted = cloned;
    if (action === "switch_to_value_cta") {
      adapted = input.replyIntelligence?.category === "objection_competitor" || input.objectionType === "competitor"
        ? applyCompetitorFraming(cloned)
        : applyValueCta(cloned);
    } else if (action === "soften_future_touches") {
      adapted = applyTimingDelay(cloned);
    } else if (action === "shorten_future_touches") {
      adapted = applyDeliverabilityShortening(cloned);
    } else if (action === "make_more_direct") {
      adapted = {
        ...cloned,
        ctaType: "soft_meeting_cta",
        ctaText: "Would it be useful to compare notes this week?",
        strategyReasoning: appendReason(cloned.strategyReasoning, "Adapted for high-priority lead: clearer but still low-pressure CTA."),
      };
    }

    changedTouchNumbers.push(adapted.touchNumber);
    return adapted;
  });

  const result: SequenceAdaptationResult = {
    adaptedTouches,
    adaptationSummary: "",
    changedTouchNumbers,
    adaptationReasons: reasons,
    requiresHumanReview,
    safetyBlocked,
    recommendedAction: safetyBlocked ? "stop_sequence" : action,
  };
  return {
    ...result,
    adaptationSummary: summarizeAdaptation(result),
  };
}

export function summarizeAdaptation(result: SequenceAdaptationResult): string {
  if (result.safetyBlocked) {
    return "Safety guard blocked autonomous adaptation; stop sequence and route to human review.";
  }
  if (result.recommendedAction === "pause_sequence") {
    return "Pause sequence and suggest a human reply before any future automation.";
  }
  if (result.recommendedAction === "escalate_to_human") {
    return "Stop sequence and escalate this lead to a human owner.";
  }
  if (result.changedTouchNumbers.length === 0) {
    return "No future touches were changed.";
  }
  return `Adapted future touch${result.changedTouchNumbers.length === 1 ? "" : "es"} ${result.changedTouchNumbers.join(", ")} using ${result.recommendedAction}.`;
}
