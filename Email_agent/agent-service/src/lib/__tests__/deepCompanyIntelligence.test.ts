import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWebsiteIntelligence } from "../companyWebsiteEnrichment.js";
import { buildDeepCompanyProfile } from "../deepCompanyProfile.js";
import { generateCompanyPainPoints } from "../companyPainPointEngine.js";
import { generateOutreachIntelligence } from "../outreachIntelligenceEngine.js";

function mockFetchWithHtml(html: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      text: async () => html,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deep company intelligence", () => {
  it("website enrichment handles fetch failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    const result = await fetchWebsiteIntelligence("https://unreachable.example");

    expect(result.limited).toBe(true);
    expect(result.combinedText).toBe("");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("company profile avoids generic classification when content has healthcare SaaS signals", async () => {
    mockFetchWithHtml(
      "<html><body>Healthcare SaaS EHR practice management patient engagement claims billing revenue cycle providers clinical support</body></html>",
    );

    const intelligence = await fetchWebsiteIntelligence("https://healthops.example");
    const profile = buildDeepCompanyProfile(intelligence);

    expect(profile.industry).toBe("healthcare SaaS");
    expect(profile.industry).not.toBe("B2B services or technology provider");
    expect(profile.confidence).toBeGreaterThan(50);
  });

  it("healthcare SaaS produces healthcare-specific pain points", async () => {
    mockFetchWithHtml(
      "<html><body>Healthcare platform for EHR practice management claims billing revenue cycle patient onboarding and provider support</body></html>",
    );

    const profile = buildDeepCompanyProfile(await fetchWebsiteIntelligence("https://clinicflow.example"));
    const pain = generateCompanyPainPoints(profile);

    expect(pain.painPoints.join(" ")).toMatch(/provider|claims|billing|Revenue cycle|healthcare/i);
  });

  it("enterprise IT services produces resource, proposal, and pipeline pain points", async () => {
    mockFetchWithHtml(
      "<html><body>Enterprise IT services digital transformation cloud DevOps managed services proposal delivery resource planning CRM pipeline reporting</body></html>",
    );

    const profile = buildDeepCompanyProfile(await fetchWebsiteIntelligence("https://itdelivery.example"));
    const pain = generateCompanyPainPoints(profile);

    expect(profile.industry).toBe("enterprise IT services");
    expect(pain.painPoints.join(" ")).toMatch(/proposal|resource|pipeline/i);
  });

  it("AI platform produces explainability, ROI, and security objections", async () => {
    mockFetchWithHtml(
      "<html><body>Artificial intelligence platform machine learning decisioning analytics automation for enterprise customer operations</body></html>",
    );

    const profile = buildDeepCompanyProfile(await fetchWebsiteIntelligence("https://decisionai.example"));
    const pain = generateCompanyPainPoints(profile);
    const outreach = generateOutreachIntelligence(profile, pain);

    expect(profile.industry).toBe("AI decisioning platform");
    expect(outreach.likelyObjections.join(" ")).toMatch(/Explainability|Security|pilot|outcomes|procurement|ROI/i);
  });
});
