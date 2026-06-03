import { describe, expect, it } from "vitest";
import {
  buildSdrStrategy,
  selectBestCTA,
  selectBestTone,
} from "../sdrStrategy.js";

describe("sdrStrategy", () => {
  describe("selectBestCTA", () => {
    it("executive chooses curiosity or direct CTA", () => {
      const result = selectBestCTA({
        leadScore: 60,
        recipientTitle: "CEO",
      });

      expect(["curiosity_cta", "direct_cta"]).toContain(result.ctaType);
    });

    it("warm lead chooses soft meeting CTA", () => {
      const result = selectBestCTA({
        leadScore: 88,
        recipientTitle: "Senior Partnerships Manager",
        confidence: 0.95,
      });

      expect(result.ctaType).toBe("soft_meeting_cta");
    });

    it("technical lead chooses value CTA", () => {
      const result = selectBestCTA({
        leadScore: 55,
        recipientTitle: "Engineering Manager",
      });

      expect(result.ctaType).toBe("value_cta");
    });
  });

  describe("selectBestTone", () => {
    it("CEO chooses executive_direct or concise enterprise style", () => {
      const result = selectBestTone({
        recipientTitle: "CEO",
      });

      expect(["concise_enterprise", "executive_direct"]).toContain(result.tone);
    });

    it("engineer chooses technical advisor", () => {
      const result = selectBestTone({
        recipientTitle: "Lead Engineer",
      });

      expect(result.tone).toBe("technical_advisor");
    });

    it("startup founder chooses friendly human", () => {
      const result = selectBestTone({
        recipientTitle: "Founder",
        companySize: "11-50 startup",
      });

      expect(result.tone).toBe("friendly_human");
    });
  });

  it("builds a combined SDR strategy summary", () => {
    const strategy = buildSdrStrategy({
      leadScore: 72,
      recipientTitle: "Founder",
      companySize: "11-50 startup",
      painPoints: ["manual follow-up"],
    });

    expect(strategy.tone).toBeTruthy();
    expect(strategy.ctaType).toBeTruthy();
    expect(strategy.sequenceType).toBeTruthy();
    expect(strategy.reasoning.length).toBeGreaterThanOrEqual(3);
  });
});
