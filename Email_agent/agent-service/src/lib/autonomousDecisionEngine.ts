export type AutonomousAction =
  | "continue_sequence"
  | "pause_sequence"
  | "stop_sequence"
  | "regenerate_future_touches"
  | "escalate_to_human"
  | "change_tone"
  | "change_cta"
  | "shorten_sequence"
  | "send_followup_early"
  | "delay_followup"
  | "mark_meeting_ready"
  | "prioritize_lead"
  | "deprioritize_lead";

export interface AutonomousDecisionInput {
  leadScore?: number | null;
  hotLeadScore?: number | null;
  replyCategory?: string | null;
  sentiment?: string | null;
  urgencyLevel?: string | null;
  meetingLikelihood?: number | null;
  meetingReady?: boolean | null;
  objectionType?: string | null;
  objectionCount?: number | null;
  deliverabilityRisk?: "low" | "medium" | "high" | string | null;
  openedCount?: number | null;
  repliedCount?: number | null;
  responseTimeMinutes?: number | null;
  recipientTitle?: string | null;
  companySize?: string | number | null;
  ctaEngagement?: boolean | null;
}

export interface AutonomousDecisionResult {
  action: AutonomousAction;
  confidence: number;
  recommendedTone?: string;
  recommendedCta?: string;
  reasons: string[];
  requiresHumanApproval: boolean;
}

function executive(title?: string | null): boolean {
  return /\b(ceo|cfo|coo|cto|cio|cmo|cro|chief|founder|president|vp|director|head of)\b/i.test(String(title ?? ""));
}

function highValue(input: AutonomousDecisionInput): boolean {
  const size = String(input.companySize ?? "").toLowerCase();
  return Number(input.leadScore ?? 0) >= 85 || /\b(enterprise|1000|5000|large)\b/.test(size) || executive(input.recipientTitle);
}

export function decideNextBestAction(input: AutonomousDecisionInput): AutonomousDecisionResult {
  const category = String(input.replyCategory ?? "").toLowerCase();
  const reasons: string[] = [];

  if (category === "unsubscribe_request" || category === "spam_warning") {
    return {
      action: "stop_sequence",
      confidence: 0.99,
      reasons: [`${category} requires automation stop.`],
      requiresHumanApproval: category === "spam_warning",
    };
  }

  if (input.meetingReady || category === "meeting_interest" || Number(input.meetingLikelihood ?? 0) >= 85) {
    reasons.push("Meeting intent detected.");
    if (highValue(input)) reasons.push("Lead is high-value or senior.");
    return {
      action: highValue(input) ? "escalate_to_human" : "mark_meeting_ready",
      confidence: 0.92,
      recommendedTone: "concise_enterprise",
      recommendedCta: "soft_meeting_cta",
      reasons,
      requiresHumanApproval: true,
    };
  }

  if (category === "positive_interest") {
    return {
      action: "delay_followup",
      confidence: 0.78,
      recommendedTone: "friendly_human",
      recommendedCta: "reply_cta",
      reasons: ["Positive interest should pause pressure and use a softer follow-up."],
      requiresHumanApproval: highValue(input),
    };
  }

  if (category === "objection_price" || input.objectionType === "pricing") {
    return {
      action: "regenerate_future_touches",
      confidence: 0.82,
      recommendedTone: "consultant_style",
      recommendedCta: "value_cta",
      reasons: ["Pricing objection should shift future touches to value and smaller-start framing."],
      requiresHumanApproval: highValue(input),
    };
  }

  if (category === "objection_competitor") {
    return {
      action: "change_cta",
      confidence: 0.76,
      recommendedTone: "consultant_style",
      recommendedCta: "value_cta",
      reasons: ["Competitor objection needs a non-comparative value CTA."],
      requiresHumanApproval: highValue(input),
    };
  }

  if (category === "objection_timing") {
    return {
      action: "delay_followup",
      confidence: 0.78,
      recommendedTone: "friendly_human",
      recommendedCta: "no_pressure_cta",
      reasons: ["Timing objection should delay follow-up and reduce pressure."],
      requiresHumanApproval: false,
    };
  }

  if (input.deliverabilityRisk === "high") {
    return {
      action: "change_tone",
      confidence: 0.8,
      recommendedTone: "friendly_human",
      recommendedCta: "reply_cta",
      reasons: ["High deliverability risk should move future touches toward plain text and fewer links."],
      requiresHumanApproval: false,
    };
  }

  if (Number(input.openedCount ?? 0) >= 3 && Number(input.repliedCount ?? 0) === 0) {
    return {
      action: "shorten_sequence",
      confidence: 0.68,
      recommendedTone: "friendly_human",
      recommendedCta: "curiosity_cta",
      reasons: ["Multiple opens with no reply suggests shorter copy and curiosity CTA."],
      requiresHumanApproval: false,
    };
  }

  if (Number(input.hotLeadScore ?? 0) >= 70 || Number(input.leadScore ?? 0) >= 80 || input.ctaEngagement) {
    return {
      action: "prioritize_lead",
      confidence: 0.72,
      recommendedTone: executive(input.recipientTitle) ? "concise_enterprise" : "friendly_human",
      recommendedCta: "soft_meeting_cta",
      reasons: ["Engagement and score justify higher priority."],
      requiresHumanApproval: highValue(input),
    };
  }

  return {
    action: "continue_sequence",
    confidence: 0.6,
    recommendedTone: "friendly_human",
    recommendedCta: "curiosity_cta",
    reasons: ["No stop, escalation, or adaptation trigger detected."],
    requiresHumanApproval: false,
  };
}

export function coordinateAutonomousAgents(input: AutonomousDecisionInput): {
  ownerAgent: "enrichment" | "sdr_strategy" | "reply_intelligence" | "analytics" | "autonomous_decision";
  workflowOrder: string[];
  conflictPolicy: string;
} {
  const decision = decideNextBestAction(input);
  const ownerAgent =
    decision.action === "escalate_to_human" || decision.action === "mark_meeting_ready"
      ? "reply_intelligence"
      : decision.action === "regenerate_future_touches" || decision.action === "shorten_sequence"
        ? "sdr_strategy"
        : decision.action === "prioritize_lead" || decision.action === "deprioritize_lead"
          ? "analytics"
          : "autonomous_decision";

  return {
    ownerAgent,
    workflowOrder: ["enrichment", "reply_intelligence", "analytics", "sdr_strategy", "autonomous_decision"],
    conflictPolicy: "Stop, unsubscribe, bounce, spam, and human-review decisions override optimization decisions.",
  };
}
