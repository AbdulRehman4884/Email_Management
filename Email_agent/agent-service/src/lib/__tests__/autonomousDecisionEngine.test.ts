import { describe, expect, it } from "vitest";
import {
  coordinateAutonomousAgents,
  decideNextBestAction,
} from "../autonomousDecisionEngine.js";

describe("autonomousDecisionEngine", () => {
  it("softens future touches after a pricing objection", () => {
    const result = decideNextBestAction({
      replyCategory: "objection_price",
      objectionType: "pricing",
      sentiment: "neutral",
    });

    expect(result.action).toBe("regenerate_future_touches");
    expect(result.recommendedTone).toBe("consultant_style");
    expect(result.recommendedCta).toBe("value_cta");
    expect(result.reasons.join(" ")).toMatch(/pricing/i);
  });

  it("escalates meeting interest for executive leads", () => {
    const result = decideNextBestAction({
      replyCategory: "meeting_interest",
      meetingReady: true,
      meetingLikelihood: 95,
      recipientTitle: "Chief Revenue Officer",
      leadScore: 92,
    });

    expect(result.action).toBe("escalate_to_human");
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("prioritizes warm engaged leads without forcing a human escalation", () => {
    const result = decideNextBestAction({
      hotLeadScore: 75,
      leadScore: 72,
      ctaEngagement: true,
      recipientTitle: "Revenue Operations Manager",
    });

    expect(result.action).toBe("prioritize_lead");
    expect(result.requiresHumanApproval).toBe(false);
  });

  it("stops sequence for unsubscribe and spam signals", () => {
    expect(decideNextBestAction({ replyCategory: "unsubscribe_request" }).action).toBe("stop_sequence");
    const spam = decideNextBestAction({ replyCategory: "spam_warning" });
    expect(spam.action).toBe("stop_sequence");
    expect(spam.requiresHumanApproval).toBe(true);
  });

  it("assigns workflow ownership without conflicting with stop policy", () => {
    const result = coordinateAutonomousAgents({
      replyCategory: "objection_price",
    });

    expect(result.ownerAgent).toBe("sdr_strategy");
    expect(result.conflictPolicy).toMatch(/unsubscribe/i);
  });
});
