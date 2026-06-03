import { describe, expect, it } from "vitest";
import { applyExecutiveConversationalRealism } from "../executiveConversationalRealism.js";
import { buildExecutiveOpening } from "../executiveOpeningArchetypes.js";
import { buildExecutiveCTASet } from "../executiveCTAEngine.js";
import { generateExecutiveArchetypeEmail } from "../executiveEmailArchetypes.js";
import { containsAiFingerprint, forbiddenMicroPhrases } from "../microPhraseRealism.js";
import type { DeepCompanyProfile } from "../deepCompanyProfile.js";
import type { ExecutiveIntelligence } from "../executiveIntelligenceEngine.js";
import type { StrategicNarrative } from "../strategicNarrativeEngine.js";

const FORBIDDEN = /the relevant conversation is|pressure-testing|credible outreach angle|read-only view|credibly claim|market story does create/i;

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

describe("Phase 5.3 micro-language realism", () => {
  it("cleans AI-consultant fingerprints from direct text", () => {
    const raw = [
      "The relevant conversation is not another tool pitch. It is whether visibility is clear.",
      "Open to pressure-testing a read-only view?",
      "The market story does create a credible outreach angle around what the company can credibly claim.",
    ].join(" ");

    const cleaned = applyExecutiveConversationalRealism(raw, {
      companyName: "Systems Limited",
      industry: "enterprise transformation services",
      persona: "VP Operations",
    });

    expect(cleaned).not.toMatch(FORBIDDEN);
    expect(containsAiFingerprint(cleaned)).toBe(false);
  });

  it("generates materially different openings for the acceptance companies", () => {
    const openings = [
      buildExecutiveOpening({ companyName: "Systems Limited", persona: "VP Operations", industry: "enterprise transformation services" }),
      buildExecutiveOpening({ companyName: "NETSOL Technologies", persona: "Director Finance Operations", industry: "fintech lending platform" }),
      buildExecutiveOpening({ companyName: "10Pearls", persona: "Digital Transformation Lead", industry: "product engineering services" }),
    ];

    expect(new Set(openings).size).toBe(3);
    expect(openings.join("\n")).not.toMatch(/looks like the kind of business|useful conversation|credibly claim/i);
  });

  it("keeps CTA language conversational and avoids pressure-testing", () => {
    const p = profile("NETSOL Technologies", "fintech and lending platform");
    const ctas = buildExecutiveCTASet({ profile: p, persona: executive(p).buyerPersonaProfiles[0] });

    expect(Object.values(ctas).join("\n")).not.toMatch(/pressure-testing|read-only view/i);
    expect(new Set(Object.values(ctas)).size).toBeGreaterThan(6);
  });

  it("generated archetype emails avoid forbidden micro phrases", () => {
    const p = profile("10Pearls", "product engineering and innovation services");
    const context = {
      profile: p,
      executive: executive(p),
      narrative: narrative(p.companyName),
      persona: executive(p).buyerPersonaProfiles[0]!,
      ctaStyle: "exploratory" as const,
    };

    const emails = [
      generateExecutiveArchetypeEmail("strategic-advisory", context, 0),
      generateExecutiveArchetypeEmail("soft-consultative", context, 1),
      generateExecutiveArchetypeEmail("direct-executive", context, 2),
    ].join("\n\n");

    expect(emails).not.toMatch(FORBIDDEN);
    for (const phrase of forbiddenMicroPhrases()) {
      expect(emails.toLowerCase()).not.toContain(phrase);
    }
  });
});
