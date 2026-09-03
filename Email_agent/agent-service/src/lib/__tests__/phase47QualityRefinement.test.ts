import { afterEach, describe, expect, it, vi } from "vitest";
import { generateCompanyPainPoints } from "../companyPainPointEngine.js";
import type { WebsiteIntelligence } from "../companyWebsiteEnrichment.js";
import { buildDeepCompanyProfile } from "../deepCompanyProfile.js";
import { buildExecutiveCTASet } from "../executiveCTAEngine.js";
import { generateExecutiveArchetypeEmail } from "../executiveEmailArchetypes.js";
import { buildExecutiveEmailSequence } from "../executiveOutreachSequence.js";
import { buildExecutiveIntelligence } from "../executiveIntelligenceEngine.js";
import { interpretExecutiveSignal } from "../executiveSignalInterpreter.js";
import { detectExternalEvents, fetchExternalBusinessIntelligence } from "../externalBusinessIntelligence.js";
import { buildPersonaIntelligence } from "../personaIntelligence.js";
import { buildStrategicNarrative } from "../strategicNarrativeEngine.js";
import { diversifyStrategicText, repeatedPhraseCount } from "../strategicLanguageVariation.js";

function intelligence(content: string, domain = "example.com"): WebsiteIntelligence {
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

function executiveFixture(content = "Enterprise IT services digital transformation cloud ERP implementation finance reporting partner expansion AI automation delivery operations") {
  const profile = buildDeepCompanyProfile(intelligence(content, "systemsltd.com"));
  const pain = generateCompanyPainPoints(profile);
  const personas = buildPersonaIntelligence(profile, pain, profile.triggerIntelligence, profile.hiringIntelligence);
  const executive = buildExecutiveIntelligence(profile, pain, personas);
  const narrative = buildStrategicNarrative(profile, pain, executive);
  const persona = executive.buyerPersonaProfiles[0]!;
  return { profile, pain, personas, executive, narrative, persona };
}

describe("Phase 4.7 quality refinement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reduces repeated strategic phrases", () => {
    const text = "workflow map, workflow map, handoff quality, operating cadence, reporting visibility";
    const diversified = diversifyStrategicText(text, {
      companyName: "Systems",
      industry: "enterprise IT services",
      persona: "COO",
    });

    expect(repeatedPhraseCount(diversified)).toBe(0);
    expect(diversified).not.toContain("workflow map");
  });

  it("generates diverse executive CTA language", () => {
    const { profile, persona } = executiveFixture();
    const ctas = Object.values(buildExecutiveCTASet({ profile, persona }));

    expect(new Set(ctas).size).toBeGreaterThan(6);
    expect(ctas.join(" ")).not.toMatch(/Useful if I send|workflow map/i);
  });

  it("turns raw signals into readable executive interpretation", () => {
    const support = interpretExecutiveSignal("Operational website signal: support.");
    const erp = interpretExecutiveSignal("ERP language suggests enterprise workflow modernization.");

    expect(support).toMatch(/Customer support and operational continuity/i);
    expect(erp).toMatch(/enterprise systems modernization/i);
    expect(`${support} ${erp}`).not.toMatch(/Operational website signal|language suggests/i);
  });

  it("varies email archetypes and avoids repeated openings", () => {
    const { profile, executive, narrative, persona } = executiveFixture();
    const context = { profile, executive, narrative, persona, ctaStyle: "strategy-call" as const };
    const emails = [
      generateExecutiveArchetypeEmail("strategic-advisory", context, 0),
      generateExecutiveArchetypeEmail("operational-insight", context, 1),
      generateExecutiveArchetypeEmail("direct-executive", context, 2),
    ];
    const openings = emails.map((email) => email.split("\n").find((line) => line.trim() && !line.startsWith("Hi ")) ?? "");

    expect(new Set(openings).size).toBe(3);
    expect(emails.join("\n")).not.toMatch(/I was reviewing|signal that stood out|Would it be useful/i);
  });

  it("builds a 5-touch sequence without repetitive CTA patterns", () => {
    const { profile, executive, narrative } = executiveFixture();
    const sequence = buildExecutiveEmailSequence(profile, executive, narrative);
    const combined = [
      sequence.coldOutreach,
      sequence.executiveIntro,
      sequence.followUp1,
      sequence.followUp2,
      sequence.valueReinforcement,
      sequence.softBreakup,
    ].join("\n");

    expect(combined).toContain("Hi {{first_name}}");
    expect(combined).not.toMatch(/I was reviewing|signal that stood out|Useful if I send the workflow map/i);
    expect((combined.match(/workflow map/gi) ?? []).length).toBe(0);
  });

  it("detects bounded external events with confidence and no hallucinated funding", () => {
    const events = detectExternalEvents([
      {
        url: "https://example.com/news",
        content: "Company announced a Microsoft partner collaboration and a new product launch for enterprise customers.",
      },
    ]);

    expect(events.some((event) => event.type === "partnership")).toBe(true);
    expect(events.some((event) => event.type === "product")).toBe(true);
    expect(events.every((event) => event.confidence > 50)).toBe(true);
    expect(events.some((event) => event.type === "funding" || event.type === "acquisition")).toBe(false);
  });

  it("keeps external enrichment bounded and verification-safe", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(
      url.includes("/news")
        ? "<html>Company announced a partnership and new market expansion.</html>"
        : "<html>No recent updates.</html>",
      { headers: { "content-type": "text/html" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const external = await fetchExternalBusinessIntelligence(intelligence("homepage content", "example.com"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(external.externalTriggerConfidence).toBeGreaterThan(40);
    expect(JSON.stringify(external)).not.toMatch(/funding round|acquisition/i);
  });
});
