import { describe, it, expect } from "vitest";
import { enrichmentAgent } from "../EnrichmentAgent.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

function minimalState(
  partial: Pick<AgentGraphStateType, "userMessage" | "intent"> &
    Partial<AgentGraphStateType>,
): AgentGraphStateType {
  return {
    sessionId: "sess",
    userId: "user-1",
    messages: [],
    userMessage: partial.userMessage,
    intent: partial.intent,
    ...partial,
  } as AgentGraphStateType;
}

describe("EnrichmentAgent — Phase 3 website vs email", () => {
  it("needs_input when website slot contains an email (analyze_company)", async () => {
    const out = await enrichmentAgent.handle(
      minimalState({
        userMessage: "Analyze company using website deltaprimeaisolutions@gmail.com",
        intent: "analyze_company",
      }),
    );
    expect(out.toolName).toBeUndefined();
    expect(out.formattedResponse).toContain("needs_input");
    expect(out.formattedResponse).toContain("not an email");
  });

  it("dispatches fetch_website_content for a valid https URL", async () => {
    const out = await enrichmentAgent.handle(
      minimalState({
        userMessage: "Analyze company OpenAI using website https://openai.com",
        intent: "analyze_company",
      }),
    );
    expect(out.toolName).toBe("fetch_website_content");
    expect((out.toolArgs as Record<string, unknown>)?.url).toBe("https://openai.com");
  });

  it("dispatches fetch for bare domain", async () => {
    const out = await enrichmentAgent.handle(
      minimalState({
        userMessage: "Generate outreach for Stripe using stripe.com",
        intent: "generate_outreach",
      }),
    );
    expect(out.toolName).toBe("fetch_website_content");
    expect(String((out.toolArgs as Record<string, unknown>)?.url)).toContain("stripe.com");
  });
});
