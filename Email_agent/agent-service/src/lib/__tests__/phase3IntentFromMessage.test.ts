import { describe, it, expect } from "vitest";
import { inferPhase3IntentFromUserMessage } from "../phase3IntentFromMessage.js";

describe("inferPhase3IntentFromUserMessage", () => {
  it("detects analyze_company", () => {
    expect(inferPhase3IntentFromUserMessage("Analyze company OpenAI using https://openai.com")).toBe(
      "analyze_company",
    );
  });

  it("detects detect_pain_points", () => {
    expect(inferPhase3IntentFromUserMessage("detect pain points for Acme")).toBe("detect_pain_points");
  });

  it("detects generate_outreach", () => {
    expect(inferPhase3IntentFromUserMessage("generate outreach for Stripe")).toBe("generate_outreach");
  });

  it("detects enrich_company", () => {
    expect(inferPhase3IntentFromUserMessage("fully enrich company Acme")).toBe("enrich_company");
  });

  it("returns undefined for unrelated text", () => {
    expect(inferPhase3IntentFromUserMessage("yes")).toBeUndefined();
  });
});
