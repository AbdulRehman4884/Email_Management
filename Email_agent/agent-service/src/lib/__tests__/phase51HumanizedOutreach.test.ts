import { describe, expect, it } from "vitest";
import { generateExecutiveArchetypeEmail, generateExecutiveSubjectLine } from "../executiveEmailArchetypes.js";
import { buildExecutiveCTASet } from "../executiveCTAEngine.js";
import { hasRoboticPhrasing, humanizeSequence, phraseRepetitionScore } from "../outreachHumanizationEngine.js";
import { executiveSubjectFor, mapIndustryNarrative } from "../industryNarrativeMapper.js";
import type { DeepCompanyProfile } from "../deepCompanyProfile.js";
import type { ExecutiveIntelligence } from "../executiveIntelligenceEngine.js";
import type { StrategicNarrative } from "../strategicNarrativeEngine.js";

function profile(companyName: string, industry: string): DeepCompanyProfile {
  return {
    companyName,
    domain: `${companyName.toLowerCase().replace(/\s+/g, "")}.com`,
    website: `https://${companyName.toLowerCase().replace(/\s+/g, "")}.com`,
    confidence: 82,
    industry,
    subIndustry: industry,
    businessModel: "B2B services",
    services: [industry],
    products: [],
    targetCustomers: ["enterprise buyers"],
    likelyBuyerPersonas: ["VP Operations"],
    keySignals: [industry],
    technologySignals: [],
    growthSignals: [],
    operationalSignals: [],
    financeWorkflowSignals: [],
    salesWorkflowSignals: [],
    risks: [],
    assumptions: [],
    hiringSignals: [],
    hiringDepartments: [],
    triggerSignals: [],
    urgencySignals: [],
    aiMaturitySignals: [],
    financeTransformationSignals: [],
    likelyInitiatives: [],
    primaryBuyerPersona: "VP Operations",
    secondaryBuyerPersonas: ["Digital Transformation Lead"],
    whyNowSignals: [],
    confidenceBreakdown: { website: 80, industry: 80, persona: 75, triggers: 60 },
  };
}

function executive(p: DeepCompanyProfile): ExecutiveIntelligence {
  return {
    executivePriorities: [{ priority: "delivery visibility", confidence: 80, source: "website" }],
    operationalPressures: ["delivery visibility"],
    growthIndicators: [],
    financeTransformationOpportunities: [],
    deliveryBottlenecks: [],
    scalingPainPoints: [],
    aiAdoptionMaturity: "developing",
    customerExperienceWeaknesses: [],
    reportingInefficiencies: [],
    workflowAutomationOpportunities: [],
    boardLevelConcerns: [],
    departmentalFriction: [],
    processInefficiencies: ["manual account handoff"],
    scalingRisks: [],
    profitabilityPressure: [],
    operationalComplexity: [],
    buyerPersonaProfiles: [{
      persona: p.primaryBuyerPersona,
      priorities: ["delivery visibility"],
      likelyObjections: ["timing"],
      outreachAngle: "delivery visibility",
      strongestValueProposition: "clearer account context",
    }],
    strategicTriggers: [],
    scores: {
      urgencyScore: 72,
      outreachReadiness: 76,
      financeTransformationFit: 45,
      aiAdoptionFit: 60,
      workflowAutomationFit: 70,
      operationalComplexityFit: 82,
      enterpriseMaturity: 78,
      strategicOpportunityScore: 80,
    },
    sourceAwareness: [],
    confidence: 80,
  };
}

function narrative(companyName: string): StrategicNarrative {
  return {
    strategicStory: `${companyName} has an enterprise story.`,
    whyCare: "Leadership cares about delivery visibility.",
    whyNow: "Signals are current.",
    operationalPressure: "delivery coordination and buyer handoff clarity",
    businessOutcome: "better delivery visibility",
    firstDepartmentToBenefit: "Operations leadership",
    strategicAngle: `${companyName} delivery coordination`,
    personalizationBasis: [],
    campaignPositioning: "AI Email Campaign Intelligence",
  };
}

describe("Phase 5.1 humanized executive outreach", () => {
  it("maps company verticals into materially different narratives and subjects", () => {
    const systems = executiveSubjectFor({ companyName: "Systems Limited", industry: "enterprise transformation services" });
    const netsol = executiveSubjectFor({ companyName: "NETSOL Technologies", industry: "fintech lending platform" });
    const pearls = executiveSubjectFor({ companyName: "10Pearls", industry: "product engineering innovation services" });

    expect(systems).toMatch(/delivery|enterprise|scale/i);
    expect(netsol).toMatch(/lending|platform/i);
    expect(pearls).toMatch(/engineering|product/i);
    expect(new Set([systems, netsol, pearls]).size).toBe(3);
  });

  it("humanization removes robotic phrases and reduces repetition", () => {
    const raw = "public positioning points to a practical executive question. Would a short review be useful? campaign personalization and operational follow-through.";
    const humanized = humanizeSequence([raw, raw], { companyName: "Systems Limited", industry: "enterprise IT" }).join("\n");
    expect(hasRoboticPhrasing(humanized)).toBe(false);
    expect(phraseRepetitionScore(humanized)).toBeLessThan(2);
  });

  it("generates varied executive emails and CTA language", () => {
    const p = profile("NETSOL Technologies", "fintech and lending platform");
    const context = {
      profile: p,
      executive: executive(p),
      narrative: narrative(p.companyName),
      persona: executive(p).buyerPersonaProfiles[0]!,
      ctaStyle: "finance-review" as const,
    };

    const email1 = generateExecutiveArchetypeEmail("strategic-advisory", context, 0);
    const email2 = generateExecutiveArchetypeEmail("operational-insight", context, 2);
    const ctas = buildExecutiveCTASet({ profile: p, persona: context.persona });

    expect(email1).not.toBe(email2);
    expect(email1 + email2).not.toMatch(/I was reviewing|workflow map|execution rhythm and context discipline/i);
    expect(new Set(Object.values(ctas)).size).toBeGreaterThan(5);
  });

  it("subject helper stays executive and anti-spam", () => {
    const p = profile("10Pearls", "product engineering and innovation services");
    const context = {
      profile: p,
      executive: executive(p),
      narrative: narrative(p.companyName),
      persona: executive(p).buyerPersonaProfiles[0]!,
      ctaStyle: "exploratory" as const,
    };
    const subject = generateExecutiveSubjectLine(context);
    expect(subject).toMatch(/Engineering|product|delivery/i);
    expect(subject).not.toMatch(/idea|quick|free|guaranteed|unlock/i);
  });

  it("maps industry narrative for the acceptance companies", () => {
    expect(mapIndustryNarrative({ companyName: "Systems Limited", industry: "enterprise IT services" }).vertical).toBe("enterprise transformation services");
    expect(mapIndustryNarrative({ companyName: "NETSOL Technologies", industry: "lending fintech" }).vertical).toBe("fintech and lending operations");
    expect(mapIndustryNarrative({ companyName: "10Pearls", industry: "product engineering" }).vertical).toBe("product engineering and innovation services");
  });
});
