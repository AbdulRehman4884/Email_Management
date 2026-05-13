export type LeadPriorityLevel = "low" | "medium" | "high" | "urgent" | "executive_attention";

export interface LeadPrioritizationInput {
  leadScore?: number | null;
  hotLeadScore?: number | null;
  meetingLikelihood?: number | null;
  meetingReady?: boolean | null;
  urgencyLevel?: string | null;
  sentiment?: string | null;
  replyCategory?: string | null;
  recipientTitle?: string | null;
  companySize?: string | number | null;
  industry?: string | null;
  openedCount?: number | null;
  repliedCount?: number | null;
  objectionCount?: number | null;
}

export interface LeadPrioritizationResult {
  priorityLevel: LeadPriorityLevel;
  recommendedAction: string;
  confidence: number;
  reasons: string[];
}

export interface HumanEscalationResult {
  escalate: boolean;
  priority: LeadPriorityLevel;
  reason: string;
  suggestedOwner: "sdr" | "account_executive" | "sales_manager" | "legal" | "security";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function isExecutiveTitle(title?: string | null): boolean {
  return /\b(ceo|cfo|coo|cto|cio|cmo|cro|chief|founder|co-founder|president|vp|vice president|head of|director)\b/i.test(String(title ?? ""));
}

function isEnterprise(input: LeadPrioritizationInput): boolean {
  const size = String(input.companySize ?? "").toLowerCase();
  return /\b(enterprise|1000|5000|10000|large)\b/.test(size) || Number(input.leadScore ?? 0) >= 90;
}

export function prioritizeLead(input: LeadPrioritizationInput): LeadPrioritizationResult {
  const reasons: string[] = [];
  let score = 25;

  if (input.meetingReady) {
    score += 35;
    reasons.push("Meeting-ready signal detected.");
  }
  if ((input.hotLeadScore ?? 0) >= 70) {
    score += 25;
    reasons.push("Hot lead score is high.");
  }
  if ((input.meetingLikelihood ?? 0) >= 70) {
    score += 15;
    reasons.push("Meeting likelihood is strong.");
  }
  if (input.urgencyLevel === "high") {
    score += 15;
    reasons.push("Reply shows urgency.");
  }
  if (input.sentiment === "positive") {
    score += 10;
    reasons.push("Positive sentiment.");
  }
  if (isExecutiveTitle(input.recipientTitle)) {
    score += 15;
    reasons.push("Executive or senior title.");
  }
  if (isEnterprise(input)) {
    score += 10;
    reasons.push("Enterprise or high-value account signal.");
  }
  if ((input.openedCount ?? 0) >= 3 && !input.replyCategory) {
    score += 8;
    reasons.push("Repeated opens without reply.");
  }
  if ((input.objectionCount ?? 0) >= 2) {
    score -= 10;
    reasons.push("Repeated objections reduce near-term conversion probability.");
  }
  if (input.replyCategory === "unsubscribe_request" || input.replyCategory === "spam_warning") {
    score = 0;
    reasons.push("Stop signal blocks prioritization.");
  }

  const finalScore = clamp(score);
  const priorityLevel: LeadPriorityLevel =
    input.replyCategory === "spam_warning" || input.replyCategory === "unsubscribe_request"
      ? "low"
      : isExecutiveTitle(input.recipientTitle) && finalScore >= 75
        ? "executive_attention"
        : finalScore >= 85
          ? "urgent"
          : finalScore >= 65
            ? "high"
            : finalScore >= 40
              ? "medium"
              : "low";

  const recommendedAction =
    priorityLevel === "executive_attention"
      ? "Escalate to an account executive before any automated follow-up."
      : priorityLevel === "urgent"
        ? "Prioritize manual response and pause automation."
        : priorityLevel === "high"
          ? "Queue a tailored follow-up and monitor closely."
          : priorityLevel === "medium"
            ? "Continue with adaptive low-pressure sequence."
            : "Deprioritize and avoid additional pressure.";

  return {
    priorityLevel,
    recommendedAction,
    confidence: Math.max(0.35, Math.min(0.95, finalScore / 100)),
    reasons: reasons.length ? reasons : ["No strong buying or urgency signals found."],
  };
}

export function detectHumanEscalationNeed(input: LeadPrioritizationInput & {
  bodyText?: string | null;
  requiresHumanReview?: boolean | null;
  intentConfidence?: number | null;
}): HumanEscalationResult {
  const body = String(input.bodyText ?? "").toLowerCase();
  const priority = prioritizeLead(input).priorityLevel;

  if (/\b(legal|lawyer|attorney|cease|gdpr)\b/.test(body)) {
    return { escalate: true, priority: "urgent", reason: "Legal or compliance language detected.", suggestedOwner: "legal" };
  }
  if (/\b(security|soc 2|sso|procurement|contract|msa|dpa)\b/.test(body)) {
    return { escalate: true, priority: "high", reason: "Security, procurement, or contract question detected.", suggestedOwner: "security" };
  }
  if (input.requiresHumanReview || (input.intentConfidence ?? 1) < 0.55) {
    return { escalate: true, priority: "high", reason: "Low-confidence or review-required reply.", suggestedOwner: "sdr" };
  }
  if (input.meetingReady || (input.meetingLikelihood ?? 0) >= 85) {
    return { escalate: true, priority: "urgent", reason: "High meeting intent.", suggestedOwner: "account_executive" };
  }
  if (isExecutiveTitle(input.recipientTitle) || isEnterprise(input)) {
    return { escalate: true, priority: priority === "low" ? "high" : priority, reason: "Executive or high-value lead.", suggestedOwner: "account_executive" };
  }
  if ((input.objectionCount ?? 0) >= 2) {
    return { escalate: true, priority: "medium", reason: "Repeated objections need human handling.", suggestedOwner: "sdr" };
  }
  return { escalate: false, priority, reason: "No human escalation trigger detected.", suggestedOwner: "sdr" };
}
