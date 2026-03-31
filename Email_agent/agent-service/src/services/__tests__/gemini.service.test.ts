/**
 * src/services/__tests__/gemini.service.test.ts
 *
 * NOTE: The active LLM provider is now OpenAI (see openai.service.test.ts).
 * This file retains basic GeminiService tests for the legacy class which
 * still exists in the codebase but is no longer wired into any live path.
 *
 * Tests verify that GeminiService still compiles and its classifyIntent()
 * interface contract is unchanged, in case a future migration re-activates it.
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { GeminiService } from "../gemini.service.js";

function spyOnGenerateJson(
  service: GeminiService,
  returnValue: string,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(service as unknown as { generateJson: () => Promise<string> }, "generateJson")
    .mockResolvedValue(returnValue);
}

const ALL_INTENTS = [
  "create_campaign", "update_campaign", "start_campaign", "pause_campaign",
  "resume_campaign", "get_campaign_stats", "list_replies", "summarize_replies",
  "check_smtp", "update_smtp", "general_help",
] as const;

describe("GeminiService.classifyIntent (legacy — not active provider)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts campaignId from 'pause campaign test-123'", async () => {
    const service = new GeminiService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "pause_campaign",
        confidence: 0.97,
        arguments:  { campaignId: "test-123" },
      }),
    );

    const result = await service.classifyIntent("pause campaign test-123", ALL_INTENTS);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("pause_campaign");
    expect(parsed.arguments?.campaignId).toBe("test-123");
  });

  it("returns null when generateJson throws (SDK failure)", async () => {
    const service = new GeminiService("dummy-key");
    vi
      .spyOn(service as unknown as { generateJson: () => Promise<string> }, "generateJson")
      .mockRejectedValue(new Error("network error"));

    const result = await service.classifyIntent("pause campaign test-123", ALL_INTENTS);
    expect(result).toBeNull();
  });

  it("returns create_campaign fields in arguments.filters", async () => {
    const service = new GeminiService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "create_campaign",
        confidence: 0.97,
        arguments: {
          filters: {
            name:      "Summer Sale",
            subject:   "Big Deals Inside",
            fromName:  "John",
            fromEmail: "john@example.com",
            body:      "Check out our offers.",
          },
        },
      }),
    );

    const result = await service.classifyIntent(
      "Create a campaign called Summer Sale",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("create_campaign");
    expect(parsed.arguments?.filters?.name).toBe("Summer Sale");
  });
});
