import { afterEach, describe, expect, it, vi } from "vitest";
import { researchOutreachAgent } from "../ResearchOutreachAgent.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

function minimalState(userMessage: string): AgentGraphStateType {
  return {
    sessionId: "sess",
    userId: "user-1",
    messages: [],
    userMessage,
    intent: "outreach_research",
  } as AgentGraphStateType;
}

function stubFetch(html: string) {
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

describe("ResearchOutreachAgent Phase 4.7", () => {
  it("research prompt with 10 URLs routes to read-only deep research output", async () => {
    stubFetch("<html><body>Enterprise IT services cloud DevOps proposal resource planning CRM pipeline finance reporting</body></html>");
    const urls = Array.from({ length: 10 }, (_, index) => `https://company${index + 1}.example`).join(" ");

    const out = await researchOutreachAgent.handle(minimalState(`Research these companies only. No campaign creation. ${urls}`));

    expect(out.toolName).toBeUndefined();
    expect(out.requiresApproval).toBe(false);
    expect(out.formattedResponse).toContain("# Executive Campaign Intelligence Report");
    expect(out.formattedResponse).toContain("## 10. Company10");
    expect(out.formattedResponse).toContain("# Portfolio Executive Campaign Summary");
  });

  it("does not call campaign or personalized-email tools", async () => {
    stubFetch("<html><body>Fintech lending leasing payments invoice reconciliation CFO finance teams</body></html>");

    const out = await researchOutreachAgent.handle(
      minimalState("Generate deep SDR intelligence only for https://netsoltech.com https://qlu.ai. Do not create campaigns."),
    );

    expect(out.toolName).toBeUndefined();
    expect(out.toolName).not.toBe("create_campaign");
    expect(out.toolName).not.toBe("generate_personalized_emails");
    expect(out.toolArgs).toEqual({});
  });

  it("enforces max 10 URL limit", async () => {
    stubFetch("<html><body>Software development product engineering AI data services</body></html>");
    const urls = Array.from({ length: 12 }, (_, index) => `https://limit${index + 1}.example`).join(" ");

    const out = await researchOutreachAgent.handle(minimalState(`Research mode only: ${urls}`));

    expect(out.formattedResponse).toContain("Processed the first 10 URLs");
    expect(out.formattedResponse).toContain("## 10. Limit10");
    expect(out.formattedResponse).not.toContain("## 11. Limit11");
  });

  it("output includes confidence scores and no raw JSON", async () => {
    stubFetch("<html><body>Healthcare SaaS EHR patient billing claims revenue cycle provider onboarding</body></html>");

    const out = await researchOutreachAgent.handle(minimalState("Research https://curemd.com only, output templates only"));

    expect(out.formattedResponse).toMatch(/Confidence:\s*\d+\/100/);
    expect(out.formattedResponse).toMatch(/Lead priority:[\s\S]*\d+\/100/);
    expect(out.formattedResponse).not.toContain("```json");
    expect(out.formattedResponse).not.toContain('"companyName"');
  });

  it("structured trigger-aware output includes why-now, personas, urgency, and portfolio trigger summary", async () => {
    stubFetch("<html><body>Careers open positions SDR Revenue Operations Implementation Manager AI Engineer Finance Operations Analyst cloud migration partner expansion</body></html>");

    const out = await researchOutreachAgent.handle(
      minimalState("Research trigger-aware SDR intelligence only for https://growthops.example. Do not send emails."),
    );

    expect(out.toolName).toBeUndefined();
    expect(out.formattedResponse).toContain("**Hiring and growth**");
    expect(out.formattedResponse).toContain("**Trigger and why-now signals**");
    expect(out.formattedResponse).toContain("### Supporting Intelligence");
    expect(out.formattedResponse).toContain("### Recommended Buyer Persona");
    expect(out.formattedResponse).toContain("**Persona-specific outreach variants**");
    expect(out.formattedResponse).toContain("Urgency:");
    expect(out.formattedResponse).toContain("# Portfolio Executive Campaign Summary");
    expect(out.formattedResponse).toContain("### Strategic Summary");
    expect(out.formattedResponse).toContain("### Executive Outreach Email");
    expect(out.formattedResponse).toContain("### Follow-Up Sequence");
    expect(out.formattedResponse).toContain("### Recommended Campaign Action");
  });

  it("generates executive campaign strategy while staying read-safe", async () => {
    stubFetch("<html><body>Enterprise IT services cloud transformation resource planning finance reporting AI automation implementation manager</body></html>");

    const out = await researchOutreachAgent.handle(
      minimalState("Prepare executive campaign intelligence for https://systemsltd.com. Do not send."),
    );

    expect(out.toolName).toBeUndefined();
    expect(out.requiresApproval).toBe(false);
    expect(out.formattedResponse).toContain("AI Email Campaign Intelligence Agent output");
    expect(out.formattedResponse).toContain("### Executive Outreach Email");
    expect(out.formattedResponse).toContain("### Campaign Recommendation");
    expect(out.formattedResponse).toContain("### Supporting Intelligence");
    expect(out.formattedResponse).toContain("Touch 1 - Executive insight");
    expect(out.formattedResponse).toContain("Touch 5 - Soft breakup");
    expect(out.formattedResponse).toMatch(/No campaign, recipient, SMTP, schedule, or send action/);
  });

  it("outputs company-wise copy-ready outreach templates for every URL", async () => {
    stubFetch("<html><body>Enterprise IT services cloud transformation finance reporting delivery operations AI automation</body></html>");

    const out = await researchOutreachAgent.handle(
      minimalState([
        "Research these companies and generate executive campaign intelligence only.",
        "Do not create campaigns. Do not send emails. Do not ask for campaign ID.",
        "https://www.systemsltd.com https://www.netsoltech.com https://10pearls.com",
      ].join("\n")),
    );

    const response = out.formattedResponse ?? "";
    const firstCompanyIndex = response.indexOf("## 1.");
    const portfolioIndex = response.indexOf("# Portfolio Executive Campaign Summary");

    expect(out.toolName).toBeUndefined();
    expect(out.requiresApproval).toBe(false);
    expect(firstCompanyIndex).toBeGreaterThan(-1);
    expect(portfolioIndex).toBeGreaterThan(firstCompanyIndex);
    expect(response.match(/### Executive Outreach Email/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/Subject:/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/### Follow-Up Sequence/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/### Campaign Recommendation/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response).not.toMatch(/Which campaign|campaign ID|create_campaign|generate_personalized_emails/i);
  });

  it("uses template-first outreach mode when the user asks for email templates", async () => {
    stubFetch("<html><body>Enterprise IT services cloud transformation finance reporting delivery operations AI automation</body></html>");

    const out = await researchOutreachAgent.handle(
      minimalState([
        "Generate professional outreach email templates for these companies.",
        "Do not create campaign. Do not send emails.",
        "https://www.systemsltd.com https://www.netsoltech.com https://10pearls.com",
      ].join("\n")),
    );

    const response = out.formattedResponse ?? "";

    expect(out.toolName).toBeUndefined();
    expect(out.requiresApproval).toBe(false);
    expect(response).toContain("# Outreach Email Templates");
    expect(response).not.toContain("# Executive Campaign Intelligence Report");
    expect(response.match(/### Email Body/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/Subject:/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/### Follow-Up 1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/### Follow-Up 2/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response.match(/### Recommended CTA/g)?.length).toBeGreaterThanOrEqual(3);
    expect(response).toContain("### Campaign Recommendation");
    expect(response).not.toMatch(/Which campaign|campaign ID|create_campaign|start_campaign|send campaign/i);
  });
});
