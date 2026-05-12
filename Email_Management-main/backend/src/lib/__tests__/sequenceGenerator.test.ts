import { describe, expect, it } from "vitest";
import { generateSequencePlan } from "../sequenceGenerator.js";

describe("sequenceGenerator", () => {
  it("generates 4 touches with the standard delays", () => {
    const plan = generateSequencePlan({
      leadScore: 55,
      recipientTitle: "VP Operations",
    });

    expect(plan.touches).toHaveLength(4);
    expect(plan.touches.map((touch) => touch.delayDays)).toEqual([0, 3, 7, 14]);
  });

  it("includes a breakup email by default", () => {
    const plan = generateSequencePlan({
      leadScore: 40,
      recipientTitle: "Director of Operations",
    });

    expect(plan.touches[3]?.ctaType).toBe("no_pressure_cta");
    expect(plan.touches[3]?.objective.toLowerCase()).toContain("final");
  });

  it("changes CTAs naturally across touches", () => {
    const plan = generateSequencePlan({
      leadScore: 82,
      recipientTitle: "Senior Manager, Partnerships",
    });

    const ctas = plan.touches.map((touch) => touch.ctaType);
    expect(ctas[0]).toBe("soft_meeting_cta");
    expect(ctas[1]).toBe("reply_cta");
    expect(ctas[2]).toBe("value_cta");
    expect(ctas[3]).toBe("no_pressure_cta");
  });

  it("supports a shortened 3-touch sequence without breakup email", () => {
    const plan = generateSequencePlan({
      leadScore: 55,
      recipientTitle: "Founder",
      includeBreakupEmail: false,
      sequenceLength: 3,
    });

    expect(plan.touches).toHaveLength(3);
    expect(plan.touches.map((touch) => touch.delayDays)).toEqual([0, 3, 7]);
  });
});
