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

export interface AutonomousSafetyInput {
  action: AutonomousAction;
  replyCategory?: string | null;
  sentiment?: string | null;
  reviewStatus?: string | null;
  requiresHumanReview?: boolean | null;
  recipientStatus?: string | null;
  sequenceStatus?: string | null;
  stopReason?: string | null;
  bodyText?: string | null;
}

export interface AutonomousSafetyResult {
  allowed: boolean;
  status: "allowed" | "blocked" | "human_review_required";
  reason?: string;
  requiresHumanApproval: boolean;
}

const BLOCKED_CATEGORIES = new Set([
  "unsubscribe_request",
  "spam_warning",
  "auto_reply",
]);

const TERMINAL_RECIPIENT_STATUSES = new Set(["bounced", "failed", "complained"]);
const TERMINAL_SEQUENCE_REASONS = new Set(["unsubscribed", "bounced", "spam_complaint", "not_interested"]);

export function autonomousSafetyGuard(input: AutonomousSafetyInput): AutonomousSafetyResult {
  const body = String(input.bodyText ?? "").toLowerCase();
  const category = String(input.replyCategory ?? "").toLowerCase();
  const action = input.action;

  if (BLOCKED_CATEGORIES.has(category)) {
    return {
      allowed: false,
      status: "blocked",
      reason: `Autonomy blocked for ${category}.`,
      requiresHumanApproval: true,
    };
  }

  if (TERMINAL_RECIPIENT_STATUSES.has(String(input.recipientStatus ?? "").toLowerCase())) {
    return {
      allowed: false,
      status: "blocked",
      reason: "Recipient is in a terminal delivery or complaint state.",
      requiresHumanApproval: true,
    };
  }

  if (TERMINAL_SEQUENCE_REASONS.has(String(input.stopReason ?? "").toLowerCase())) {
    return {
      allowed: false,
      status: "blocked",
      reason: `Sequence stop rule already applied: ${input.stopReason}.`,
      requiresHumanApproval: true,
    };
  }

  if (/\b(legal|lawyer|attorney|cease|gdpr|compliance|security review|procurement|contract)\b/.test(body)) {
    return {
      allowed: action === "escalate_to_human" || action === "pause_sequence" || action === "stop_sequence",
      status: "human_review_required",
      reason: "Legal, compliance, security, procurement, or contract language requires human review.",
      requiresHumanApproval: true,
    };
  }

  if (input.requiresHumanReview || input.reviewStatus === "human_review") {
    return {
      allowed: action === "escalate_to_human" || action === "pause_sequence" || action === "mark_meeting_ready",
      status: "human_review_required",
      reason: "Reply intelligence requires human review.",
      requiresHumanApproval: true,
    };
  }

  if (action === "send_followup_early" && category.includes("objection")) {
    return {
      allowed: false,
      status: "blocked",
      reason: "Do not accelerate follow-up after an objection.",
      requiresHumanApproval: true,
    };
  }

  return { allowed: true, status: "allowed", requiresHumanApproval: false };
}
