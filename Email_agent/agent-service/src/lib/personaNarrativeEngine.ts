import { mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { buildExecutiveOpening } from "./executiveOpeningArchetypes.js";

export interface PersonaNarrative {
  persona: string;
  priorities: string[];
  concern: string;
  valueProposition: string;
  ctaPreference: string;
}

export function buildPersonaNarrative(input: {
  persona?: string;
  industry?: string;
  companyName?: string;
  signals?: string[];
}): PersonaNarrative {
  const persona = input.persona || "VP Operations";
  const narrative = mapIndustryNarrative(input);
  const text = `${persona} ${input.industry ?? ""} ${(input.signals ?? []).join(" ")}`;

  if (/\b(CFO|Finance|Revenue Cycle|Financial Operations)\b/i.test(text)) {
    return {
      persona,
      priorities: ["forecast confidence", "billing visibility", "clean exception handling"],
      concern: "whether outbound and account follow-up create more finance ambiguity than they resolve",
      valueProposition: `Connect ${narrative.vertical} messaging to commercial visibility and finance workflow clarity.`,
      ctaPreference: "finance visibility walkthrough",
    };
  }

  if (/\b(CIO|CTO|Digital|Transformation|AI|Data|ERP)\b/i.test(text)) {
    return {
      persona,
      priorities: ["modernization credibility", "integration risk", "adoption proof"],
      concern: "whether the message reflects implementation reality or just another technology pitch",
      valueProposition: `Frame ${narrative.vertical} outreach around adoption, integration, and proof rather than generic AI language.`,
      ctaPreference: "modernization readiness discussion",
    };
  }

  if (/\b(Delivery|Services|Implementation|Onboarding|Professional Services)\b/i.test(text)) {
    return {
      persona,
      priorities: ["delivery visibility", "handoff clarity", "resource coordination"],
      concern: "whether sales messaging creates delivery expectations the team cannot easily operationalize",
      valueProposition: `Turn buyer-facing claims into clearer delivery and onboarding expectations for ${narrative.vertical}.`,
      ctaPreference: "delivery coordination review",
    };
  }

  if (/\b(Revenue|Sales|GTM|SDR)\b/i.test(text)) {
    return {
      persona,
      priorities: ["account quality", "pipeline focus", "rep consistency"],
      concern: "whether outreach volume is masking weak account context",
      valueProposition: `Improve first-touch quality and account prioritization for ${narrative.vertical} campaigns.`,
      ctaPreference: "campaign strategy preview",
    };
  }

  return {
    persona,
    priorities: narrative.pressures.slice(0, 3),
    concern: "whether growth is creating avoidable coordination drag across teams",
    valueProposition: `Make ${narrative.vertical} outreach more specific, commercially grounded, and easier to review before launch.`,
    ctaPreference: "operational visibility review",
  };
}

export function personaOpening(input: {
  companyName: string;
  persona: string;
  industry?: string;
  offset?: number;
}): string {
  return buildExecutiveOpening(input);
}
