import { describe, expect, it } from "vitest";
import {
  detectHumanEscalationNeed,
  prioritizeLead,
} from "../leadPrioritization.js";

describe("leadPrioritization", () => {
  it("marks hot meeting-ready leads urgent", () => {
    const result = prioritizeLead({
      hotLeadScore: 91,
      meetingLikelihood: 92,
      meetingReady: true,
      sentiment: "positive",
      urgencyLevel: "high",
    });

    expect(result.priorityLevel).toBe("urgent");
    expect(result.recommendedAction).toMatch(/manual response/i);
  });

  it("boosts executive leads to executive attention", () => {
    const result = prioritizeLead({
      leadScore: 90,
      hotLeadScore: 80,
      recipientTitle: "Chief Operating Officer",
      meetingLikelihood: 80,
    });

    expect(result.priorityLevel).toBe("executive_attention");
    expect(result.reasons.join(" ")).toMatch(/executive/i);
  });

  it("detects enterprise escalation", () => {
    const result = detectHumanEscalationNeed({
      leadScore: 93,
      companySize: "Enterprise 5000 employees",
      recipientTitle: "VP Sales",
    });

    expect(result.escalate).toBe(true);
    expect(result.suggestedOwner).toBe("account_executive");
  });

  it("routes legal replies to legal escalation", () => {
    const result = detectHumanEscalationNeed({
      bodyText: "Send this to legal and cease all contact.",
    });

    expect(result.escalate).toBe(true);
    expect(result.priority).toBe("urgent");
    expect(result.suggestedOwner).toBe("legal");
  });
});
