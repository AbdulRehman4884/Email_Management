import { describe, expect, it } from "vitest";
import { buildDeepCompanyProfile } from "../deepCompanyProfile.js";
import { generateCompanyPainPoints } from "../companyPainPointEngine.js";
import { generateHiringSummary } from "../hiringIntelligence.js";
import { buildPersonaIntelligence } from "../personaIntelligence.js";
import { buildTriggerAwareOutreach } from "../triggerAwareOutreach.js";
import { buildTriggerIntelligence } from "../triggerIntelligence.js";
import type { WebsiteIntelligence } from "../companyWebsiteEnrichment.js";

function intelligence(content: string, careers = content): WebsiteIntelligence {
  return {
    requestedUrl: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    pagesAttempted: ["https://example.com", "https://example.com/careers"],
    pagesFetched: [
      { url: "https://example.com", ok: true, status: 200, content },
      { url: "https://example.com/careers", ok: true, status: 200, content: careers },
    ],
    combinedText: `${content}\n${careers}`,
    limited: false,
    errors: [],
  };
}

describe("Phase 4.6 hiring intelligence", () => {
  it("detects careers page and AI hiring signals", () => {
    const hiring = generateHiringSummary(intelligence("", "Open positions AI Engineer ML Engineer Data Scientist"));
    expect(hiring.careersPageDetected).toBe(true);
    expect(hiring.departmentsHiring).toContain("AI / data");
    expect(hiring.technologyAdoptionSignals.join(" ")).toMatch(/AI|ML/i);
  });

  it("detects finance hiring and GTM scaling", () => {
    const hiring = generateHiringSummary(intelligence("", "SDR Revenue Operations Finance Operations Analyst Accounting Analyst"));
    expect(hiring.departmentsHiring).toContain("GTM / revenue");
    expect(hiring.departmentsHiring).toContain("finance operations");
    expect(hiring.financeExpansionSignals.join(" ")).toMatch(/Finance|accounting/i);
  });
});

describe("Phase 4.6 trigger intelligence", () => {
  it("detects expansion, partnership, AI initiative, and cloud transformation signals", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "AI initiative generative AI cloud migration digital transformation new office expansion AWS partner platform launch billing reconciliation",
      "Cloud Engineer AI Engineer",
    ));
    const trigger = profile.triggerIntelligence;
    expect(trigger.expansionSignals.join(" ")).toMatch(/expansion|office/i);
    expect(trigger.partnershipSignals.join(" ")).toMatch(/partner/i);
    expect(trigger.aiMaturitySignals.join(" ")).toMatch(/AI|Generative|machine/i);
    expect(trigger.transformationSignals.join(" ")).toMatch(/Cloud|transformation/i);
    expect(trigger.urgencyScore).toBeGreaterThan(60);
  });
});

describe("Phase 4.6 persona intelligence", () => {
  it("generates realistic multi-persona strategy and maps pain points", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "Enterprise IT services digital transformation cloud migration CRM proposal resource planning",
      "Implementation Manager Revenue Operations SDR",
    ));
    const pain = generateCompanyPainPoints(profile);
    const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
    expect(personas.primaryBuyer).toMatch(/Revenue Operations|Professional Services|Delivery|Financial|Transformation/);
    expect(personas.personaStrategies.length).toBeGreaterThan(1);
    expect(personas.personaStrategies[0].painPoints.length).toBeGreaterThan(0);
  });
});

describe("Phase 4.6 trigger-aware outreach", () => {
  it("generates role-specific outreach, urgency-aware CTA, and trigger-aware messaging", () => {
    const profile = buildDeepCompanyProfile(intelligence(
      "Healthcare SaaS revenue cycle billing claims automation AI initiative",
      "Implementation Manager Finance Operations Analyst Onboarding Specialist",
    ));
    const pain = generateCompanyPainPoints(profile);
    const trigger = buildTriggerIntelligence(profile, profile.hiringIntelligence, "AI initiative billing claims revenue cycle");
    const personas = buildPersonaIntelligence(profile, pain, trigger, profile.hiringIntelligence);
    const outreach = buildTriggerAwareOutreach(profile, pain, trigger, personas);
    expect(outreach.urgencyAwareCTA).toMatch(/workflow|note/i);
    expect(outreach.triggerAwareAngle).toMatch(/hiring|finance|AI|workflow/i);
    expect(outreach.personaVariants.length).toBeGreaterThan(0);
    expect(outreach.personaVariants[0].email).toContain("Hi {{first_name}}");
  });
});
