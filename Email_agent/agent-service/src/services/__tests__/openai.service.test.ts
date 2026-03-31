/**
 * src/services/__tests__/openai.service.test.ts
 *
 * Tests for OpenAIService.classifyIntent() argument extraction.
 *
 * Strategy: mock `generateJson` (the private SDK call) to return controlled
 * JSON strings, then assert that classifyIntent() parses and validates them
 * correctly.  No real OpenAI API calls are made.
 *
 * The tests focus on the two properties most critical for smoke-test parity:
 *   1. campaignId is extracted when the user names a campaign
 *   2. Low-confidence or malformed responses fall back gracefully
 */

import { vi, describe, it, expect, afterEach } from "vitest";
import { OpenAIService } from "../openai.service.js";
import { IntentDetectionService } from "../intentDetection.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Spies on the private `generateJson` method of an OpenAIService instance so
 * tests can inject controlled responses without importing openai.
 */
function spyOnGenerateJson(
  service: OpenAIService,
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

// ── OpenAIService.classifyIntent ──────────────────────────────────────────────

describe("OpenAIService.classifyIntent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts campaignId from 'pause campaign test-123'", async () => {
    const service = new OpenAIService("dummy-key");
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
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.7);
    expect(parsed.arguments?.campaignId).toBe("test-123");
  });

  it("extracts campaignId from 'stop the Black Friday campaign'", async () => {
    const service = new OpenAIService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "pause_campaign",
        confidence: 0.95,
        arguments:  { campaignId: "Black Friday" },
      }),
    );

    const result = await service.classifyIntent(
      "stop the Black Friday campaign",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.arguments?.campaignId).toBe("Black Friday");
  });

  it("extracts campaignId from 'show stats for summer-sale-2024'", async () => {
    const service = new OpenAIService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "get_campaign_stats",
        confidence: 0.96,
        arguments:  { campaignId: "summer-sale-2024" },
      }),
    );

    const result = await service.classifyIntent(
      "show stats for summer-sale-2024",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("get_campaign_stats");
    expect(parsed.arguments?.campaignId).toBe("summer-sale-2024");
  });

  it("returns null when generateJson throws (SDK failure)", async () => {
    const service = new OpenAIService("dummy-key");
    vi
      .spyOn(service as unknown as { generateJson: () => Promise<string> }, "generateJson")
      .mockRejectedValue(new Error("network error"));

    const result = await service.classifyIntent("pause campaign test-123", ALL_INTENTS);
    expect(result).toBeNull();
  });

  it("returns JSON with no arguments when no campaign is mentioned", async () => {
    const service = new OpenAIService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "get_campaign_stats",
        confidence: 0.88,
      }),
    );

    const result = await service.classifyIntent(
      "how are all my campaigns doing",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("get_campaign_stats");
    expect(parsed.arguments).toBeUndefined();
  });

  it("handles arguments with multiple fields correctly", async () => {
    const service = new OpenAIService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "list_replies",
        confidence: 0.93,
        arguments:  { campaignId: "Black Friday", limit: 5 },
      }),
    );

    const result = await service.classifyIntent(
      "show me the last 5 replies for Black Friday",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.arguments?.campaignId).toBe("Black Friday");
    expect(parsed.arguments?.limit).toBe(5);
  });

  it("returns create_campaign fields in arguments.filters (primary OpenAI path)", async () => {
    const service = new OpenAIService("dummy-key");
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
      "Create a campaign called Summer Sale, subject: Big Deals Inside, from John at john@example.com, body: Check out our offers.",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("create_campaign");
    expect(parsed.arguments?.filters?.name).toBe("Summer Sale");
    expect(parsed.arguments?.filters?.subject).toBe("Big Deals Inside");
    expect(parsed.arguments?.filters?.fromName).toBe("John");
    expect(parsed.arguments?.filters?.fromEmail).toBe("john@example.com");
    expect(parsed.arguments?.filters?.body).toBe("Check out our offers.");
  });

  it("returns create_campaign fields at top level of arguments (fallback OpenAI path)", async () => {
    const service = new OpenAIService("dummy-key");
    spyOnGenerateJson(
      service,
      JSON.stringify({
        intent:     "create_campaign",
        confidence: 0.95,
        arguments: {
          name:      "Winter Sale",
          subject:   "Holiday Deals",
          fromName:  "Marketing",
          fromEmail: "mkt@example.com",
          body:      "Season greetings!",
        },
      }),
    );

    const result = await service.classifyIntent(
      "Create a campaign called Winter Sale, subject Holiday Deals, from Marketing at mkt@example.com, body Season greetings!",
      ALL_INTENTS,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.intent).toBe("create_campaign");
    expect(parsed.arguments?.name).toBe("Winter Sale");
    expect(parsed.arguments?.subject).toBe("Holiday Deals");
  });
});

// ── IntentDetectionService.detectWithLLM (integration with OpenAI) ────────────

describe("IntentDetectionService.detectWithLLM — LLM argument propagation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("propagates create_campaign filters fields through extractedArgs", async () => {
    const service = new IntentDetectionService();
    const openaiSpy = vi.spyOn(
      await import("../openai.service.js"),
      "getOpenAIService",
    ).mockReturnValue(
      Object.assign(Object.create(null), {
        classifyIntent: vi.fn().mockResolvedValue(
          JSON.stringify({
            intent:     "create_campaign",
            confidence: 0.97,
            arguments: {
              filters: {
                name:      "Summer Sale",
                subject:   "Big Deals",
                fromName:  "John",
                fromEmail: "john@example.com",
                body:      "Check out our offers.",
              },
            },
          }),
        ),
      }) as unknown as import("../openai.service.js").OpenAIService,
    );

    const result = await service.detectWithLLM(
      "Create a campaign called Summer Sale, subject Big Deals, from John at john@example.com, body Check out our offers.",
    );

    expect(result.intent).toBe("create_campaign");
    expect(result.extractedArgs?.filters?.name).toBe("Summer Sale");
    expect(result.extractedArgs?.filters?.subject).toBe("Big Deals");
    expect(result.extractedArgs?.filters?.fromName).toBe("John");
    expect(result.extractedArgs?.filters?.fromEmail).toBe("john@example.com");
    expect(result.extractedArgs?.filters?.body).toBe("Check out our offers.");

    openaiSpy.mockRestore();
  });

  it("propagates create_campaign top-level fields through extractedArgs", async () => {
    const service = new IntentDetectionService();
    const openaiSpy = vi.spyOn(
      await import("../openai.service.js"),
      "getOpenAIService",
    ).mockReturnValue(
      Object.assign(Object.create(null), {
        classifyIntent: vi.fn().mockResolvedValue(
          JSON.stringify({
            intent:     "create_campaign",
            confidence: 0.95,
            arguments: {
              name:      "Winter Sale",
              subject:   "Holiday Deals",
              fromName:  "Marketing",
              fromEmail: "mkt@example.com",
              body:      "Season greetings!",
            },
          }),
        ),
      }) as unknown as import("../openai.service.js").OpenAIService,
    );

    const result = await service.detectWithLLM(
      "Create a campaign called Winter Sale, subject Holiday Deals, from Marketing at mkt@example.com, body Season greetings!",
    );

    expect(result.intent).toBe("create_campaign");
    expect(result.extractedArgs?.name).toBe("Winter Sale");
    expect(result.extractedArgs?.subject).toBe("Holiday Deals");
    expect(result.extractedArgs?.fromName).toBe("Marketing");
    expect(result.extractedArgs?.fromEmail).toBe("mkt@example.com");
    expect(result.extractedArgs?.body).toBe("Season greetings!");

    openaiSpy.mockRestore();
  });

  it("populates extractedArgs.campaignId when OpenAI returns it", async () => {
    const service = new IntentDetectionService();
    const openaiSpy = vi.spyOn(
      await import("../openai.service.js"),
      "getOpenAIService",
    ).mockReturnValue(
      Object.assign(Object.create(null), {
        classifyIntent: vi.fn().mockResolvedValue(
          JSON.stringify({
            intent:     "pause_campaign",
            confidence: 0.97,
            arguments:  { campaignId: "test-123" },
          }),
        ),
      }) as unknown as import("../openai.service.js").OpenAIService,
    );

    const result = await service.detectWithLLM("pause campaign test-123");

    expect(result.intent).toBe("pause_campaign");
    expect(result.extractedArgs?.campaignId).toBe("test-123");

    openaiSpy.mockRestore();
  });

  it("falls back to deterministic when OpenAI confidence is below threshold", async () => {
    const service = new IntentDetectionService();
    const openaiSpy = vi.spyOn(
      await import("../openai.service.js"),
      "getOpenAIService",
    ).mockReturnValue(
      Object.assign(Object.create(null), {
        classifyIntent: vi.fn().mockResolvedValue(
          JSON.stringify({
            intent:     "pause_campaign",
            confidence: 0.5,          // below LLM_CONFIDENCE_THRESHOLD = 0.7
            arguments:  { campaignId: "test-123" },
          }),
        ),
      }) as unknown as import("../openai.service.js").OpenAIService,
    );

    const result = await service.detectWithLLM("pause campaign test-123");

    // deterministic path still detects pause_campaign for this input
    expect(result.intent).toBe("pause_campaign");
    // extractedArgs undefined because deterministic path ran
    expect(result.extractedArgs).toBeUndefined();

    openaiSpy.mockRestore();
  });

  it("falls back to deterministic when OpenAI returns null (SDK failure)", async () => {
    const service = new IntentDetectionService();
    const openaiSpy = vi.spyOn(
      await import("../openai.service.js"),
      "getOpenAIService",
    ).mockReturnValue(
      Object.assign(Object.create(null), {
        classifyIntent: vi.fn().mockResolvedValue(null),
      }) as unknown as import("../openai.service.js").OpenAIService,
    );

    const result = await service.detectWithLLM("pause campaign test-123");

    expect(result.intent).toBe("pause_campaign");
    expect(result.extractedArgs).toBeUndefined();

    openaiSpy.mockRestore();
  });
});
