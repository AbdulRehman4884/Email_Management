import { describe, expect, it } from "vitest";
import { autonomousSafetyGuard } from "../autonomousSafetyGuard.js";
import {
  adaptFutureTouches,
  summarizeAdaptation,
  type AdaptableSequenceTouch,
} from "../sequenceAdaptation.js";

function touches(): AdaptableSequenceTouch[] {
  return [
    {
      id: 1,
      touchNumber: 1,
      personalizedSubject: "Initial note",
      personalizedBody: "Initial meeting ask that has already been sent.",
      personalizedText: "Initial meeting ask that has already been sent.",
      ctaType: "soft_meeting_cta",
      ctaText: "Open to a 15-minute meeting?",
      executionStatus: "sent",
      sentAt: new Date("2026-05-01T09:00:00Z"),
    },
    {
      id: 2,
      touchNumber: 2,
      personalizedSubject: "Following up",
      personalizedBody: "Can we schedule a demo? This is the best way to improve your workflow.",
      personalizedText: "Can we schedule a demo? This is the best way to improve your workflow.",
      ctaType: "soft_meeting_cta",
      ctaText: "Open to a 15-minute meeting?",
      recommendedDelayDays: 3,
      executionStatus: "pending",
      sentAt: null,
    },
  ];
}

describe("sequenceAdaptation", () => {
  it("pricing objection softens future touch and changes CTA to value_cta", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: {
        category: "objection_price",
        confidence: 0.91,
        objectionType: "pricing",
      },
      objectionType: "pricing",
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.recommendedAction).toBe("switch_to_value_cta");
    expect(result.changedTouchNumbers).toEqual([2]);
    expect(result.adaptedTouches[1]?.ctaType).toBe("value_cta");
    expect(result.adaptedTouches[1]?.personalizedBody).toMatch(/lightweight example/i);
    expect(result.adaptedTouches[1]?.personalizedBody).not.toMatch(/schedule a demo/i);
  });

  it("competitor objection changes future language", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: {
        category: "objection_competitor",
        confidence: 0.88,
        objectionType: "competitor",
      },
      objectionType: "competitor",
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.recommendedAction).toBe("switch_to_value_cta");
    expect(result.adaptedTouches[1]?.personalizedBody).toMatch(/already have a platform/i);
    expect(result.adaptedTouches[1]?.personalizedBody).toMatch(/manual work still exists/i);
  });

  it("timing objection delays future touch", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: {
        category: "objection_timing",
        confidence: 0.9,
        objectionType: "timing",
      },
      objectionType: "timing",
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.recommendedAction).toBe("soften_future_touches");
    expect(result.adaptedTouches[1]?.recommendedDelayDays).toBeGreaterThan(3);
    expect(result.adaptedTouches[1]?.ctaType).toBe("reply_cta");
    expect(result.adaptedTouches[1]?.personalizedBody).toMatch(/No pressure/i);
  });

  it("meeting interest recommends stop_sequence plus human escalation", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: {
        category: "meeting_interest",
        confidence: 0.96,
        meetingReady: true,
      },
      leadPriority: {
        priorityLevel: "urgent",
        recommendedAction: "Prioritize manual response and pause automation.",
        confidence: 0.92,
        reasons: ["Meeting-ready signal detected."],
      },
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.recommendedAction).toBe("escalate_to_human");
    expect(result.requiresHumanReview).toBe(true);
    expect(result.changedTouchNumbers).toEqual([]);
    expect(summarizeAdaptation(result)).toMatch(/escalate/i);
  });

  it("unsubscribe, spam, and legal safety block adaptation and stop sequence", () => {
    const unsubscribe = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: { category: "unsubscribe_request", confidence: 0.98 },
      safetyGuard: autonomousSafetyGuard({ action: "continue_sequence", replyCategory: "unsubscribe_request" }),
    });
    const spam = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: { category: "spam_warning", confidence: 0.98 },
      safetyGuard: autonomousSafetyGuard({ action: "continue_sequence", replyCategory: "spam_warning" }),
    });
    const legal = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: { category: "neutral_question", confidence: 0.8 },
      safetyGuard: autonomousSafetyGuard({ action: "stop_sequence", bodyText: "Please send this to legal and cease contact." }),
    });

    for (const result of [unsubscribe, spam, legal]) {
      expect(result.safetyBlocked).toBe(true);
      expect(result.recommendedAction).toBe("stop_sequence");
      expect(result.changedTouchNumbers).toEqual([]);
    }
  });

  it("sent touches are never mutated", () => {
    const input = touches();
    const originalSentBody = input[0]?.personalizedBody;
    const result = adaptFutureTouches({
      currentTouches: input,
      replyIntelligence: { category: "objection_price", confidence: 0.9, objectionType: "pricing" },
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.adaptedTouches[0]?.personalizedBody).toBe(originalSentBody);
    expect(input[0]?.personalizedBody).toBe(originalSentBody);
    expect(input[1]?.ctaType).toBe("soft_meeting_cta");
    expect(result.adaptedTouches[1]?.ctaType).toBe("value_cta");
  });

  it("high deliverability risk shortens future touches", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: { category: "neutral_question", confidence: 0.85 },
      deliverabilityDiagnostics: {
        inboxRisk: "high",
        promotionalKeywordScore: 80,
        linkCount: 4,
      },
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.recommendedAction).toBe("shorten_future_touches");
    expect(result.adaptedTouches[1]?.personalizedBody.length).toBeLessThan(420);
    expect(result.adaptedTouches[1]?.personalizedBody).not.toMatch(/best/i);
  });

  it("low confidence requires human review", () => {
    const result = adaptFutureTouches({
      currentTouches: touches(),
      replyIntelligence: { category: "neutral_question", confidence: 0.42 },
      safetyGuard: { allowed: true, status: "allowed", requiresHumanApproval: false },
    });

    expect(result.requiresHumanReview).toBe(true);
    expect(result.safetyBlocked).toBe(false);
    expect(result.adaptationReasons.join(" ")).toMatch(/Low-confidence/i);
  });
});
