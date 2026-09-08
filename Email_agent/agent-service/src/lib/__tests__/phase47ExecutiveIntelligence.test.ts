import { describe, expect, it } from "vitest";
import { generateCompanyPainPoints } from "../companyPainPointEngine.js";
import type { WebsiteIntelligence } from "../companyWebsiteEnrichment.js";
import { buildDeepCompanyProfile } from "../deepCompanyProfile.js";
import { buildExecutiveEmailSequence } from "../executiveOutreachSequence.js";
import { buildExecutiveIntelligence } from "../executiveIntelligenceEngine.js";
import { buildPersonaIntelligence } from "../personaIntelligence.js";
import { buildStrategicNarrative } from "../strategicNarrativeEngine.js";

function intelligence(content: string, domain = "systemsltd.com"): WebsiteIntelligence {
  return {
    requestedUrl: `https://${domain}`,
    normalizedUrl: `https://${domain}`,
    domain,
    pagesAttempted: [`https://${domain}`, `https://${domain}/careers`],
    pagesFetched: [
      { url: `https://${domain}`, ok: true, status: 200, content },
      { url: `https://${domain}/careers`, ok: true, status: 200, content },
    ],
    combinedText: content,
    limited: false,
    errors: [],
  };
}

describe("Phase 4.7 executive intelligence", () => {
  it("extracts executive priorities, source-aware triggers, and commercial scores", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "Enterprise IT services digital transformation cloud migration proposal resource planning finance reporting billing reconciliation AI automation implementation manager revenue operations",
    ));
    const pain = generateCompanyPainPoints(profile);
    const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
    const executive = buildExecutiveIntelligence(profile, pain, personas);

    expect(executive.executivePriorities.length).toBeGreaterThan(0);
    expect(executive.executivePriorities[0].confidence).toBeGreaterThan(50);
    expect(executive.strategicTriggers.length).toBeGreaterThan(0);
    expect(executive.strategicTriggers[0]).toMatchObject({
      businessImplication: expect.any(String),
      outreachRecommendation: expect.any(String),
    });
    expect(executive.scores.strategicOpportunityScore).toBeGreaterThan(50);
    expect(executive.sourceAwareness.join(" ")).toContain("Website:");
  });

  it("maps CFO, CIO, COO, and transformation buyer priorities without fake facts", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "Fintech platform lending leasing ERP modernization finance reporting reconciliation cloud migration enterprise rollout",
      "netsoltech.com",
    ));
    const pain = generateCompanyPainPoints(profile);
    const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
    const executive = buildExecutiveIntelligence(profile, pain, personas);
    const personaNames = executive.buyerPersonaProfiles.map((persona) => persona.persona).join(" ");

    expect(personaNames).toMatch(/CFO|Director Financial Operations|CIO|COO|Transformation|ERP/);
    expect(executive.buyerPersonaProfiles[0].priorities.length).toBeGreaterThan(0);
    expect(JSON.stringify(executive)).not.toMatch(/funding round|acquisition|named executive/i);
  });

  it("generates strategic narrative and executive sequence for campaign preview", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "Healthcare SaaS EHR revenue cycle billing claims customer onboarding AI initiative support workflow automation",
      "curemd.com",
    ));
    const pain = generateCompanyPainPoints(profile);
    const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
    const executive = buildExecutiveIntelligence(profile, pain, personas);
    const narrative = buildStrategicNarrative(profile, pain, executive);
    const sequence = buildExecutiveEmailSequence(profile, executive, narrative);

    expect(narrative.campaignPositioning).toMatch(/AI Email Campaign Intelligence/i);
    expect(narrative.whyCare).toMatch(/care/i);
    expect(sequence.coldOutreach).toContain("Hi {{first_name}}");
    expect(sequence.executiveIntro).toContain("Hi {{first_name}}");
    expect(sequence.followUp1).toContain("Hi {{first_name}}");
    expect(sequence.followUp2).toContain("Hi {{first_name}}");
    expect(sequence.valueReinforcement).toContain("Hi {{first_name}}");
    expect(sequence.softBreakup).toContain("Hi {{first_name}}");
    expect(sequence.coldOutreach).not.toMatch(/revolutionary|game-changing|unlock|guaranteed/i);
  });
});
