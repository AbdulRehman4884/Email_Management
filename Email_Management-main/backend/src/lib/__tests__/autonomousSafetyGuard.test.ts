import { describe, expect, it } from "vitest";
import { autonomousSafetyGuard } from "../autonomousSafetyGuard.js";

describe("autonomousSafetyGuard", () => {
  it("blocks unsubscribe autonomy", () => {
    const result = autonomousSafetyGuard({
      action: "continue_sequence",
      replyCategory: "unsubscribe_request",
    });

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("blocks spam complaints from future automation", () => {
    const result = autonomousSafetyGuard({
      action: "send_followup_early",
      replyCategory: "spam_warning",
      bodyText: "This is spam. Stop spamming me.",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/spam/i);
  });

  it("requires human review for legal language", () => {
    const result = autonomousSafetyGuard({
      action: "regenerate_future_touches",
      bodyText: "Please cease contact or I will send this to legal.",
    });

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("human_review_required");
    expect(result.requiresHumanApproval).toBe(true);
  });

  it("allows safe low-risk adaptation", () => {
    const result = autonomousSafetyGuard({
      action: "delay_followup",
      replyCategory: "positive_interest",
      sentiment: "positive",
    });

    expect(result.allowed).toBe(true);
    expect(result.status).toBe("allowed");
  });
});
