/**
 * src/agents/__tests__/CampaignAgent.test.ts
 *
 * Unit tests for CampaignAgent.handle().
 *
 * Covers:
 *   1. Vague create_campaign requests return a clarification prompt
 *   2. Detailed create_campaign requests with all required fields resolve to
 *      a valid MCP dispatch (toolName set, toolArgs populated)
 *   3. MCP tool is NOT dispatched when required fields are missing
 *      (toolName is undefined in the returned patch)
 *   4. All other campaign intents still resolve correctly
 */

import { describe, it, expect } from "vitest";
import { campaignAgent } from "../CampaignAgent.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";
import type { LLMIntentArguments } from "../../schemas/llmIntent.schema.js";

// ── State builder ─────────────────────────────────────────────────────────────

function makeState(
  partial: Partial<AgentGraphStateType>,
): AgentGraphStateType {
  return {
    messages:         [],
    userMessage:      "",
    sessionId:        undefined,
    userId:           undefined,
    rawToken:         undefined,
    intent:           undefined,
    confidence:       0,
    llmExtractedArgs: undefined,
    agentDomain:      undefined,
    toolName:         undefined,
    toolArgs:         {},
    toolResult:       undefined,
    requiresApproval: false,
    pendingActionId:  undefined,
    finalResponse:    undefined,
    activeCampaignId: undefined,
    plan:             undefined,
    planIndex:        0,
    planResults:      [],
    error:            undefined,
    ...partial,
  } as AgentGraphStateType;
}

// ── create_campaign — clarification (missing fields) ─────────────────────────

describe("create_campaign — missing required fields → clarification", () => {
  it("vague input returns clarification prompt and clears toolName", async () => {
    const state = makeState({ intent: "create_campaign", userMessage: "create a new campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeDefined();
    expect(patch.error).toContain("name");
    expect(patch.error).toContain("subject");
    expect(patch.error).toContain("fromName");
    expect(patch.error).toContain("fromEmail");
    expect(patch.error).toContain("body");
  });

  it("'create new email campaign' — no filters — returns clarification", async () => {
    const state = makeState({ intent: "create_campaign", userMessage: "create new email campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
  });

  it("partial filters (only name + subject) still returns clarification", async () => {
    const llmExtractedArgs: LLMIntentArguments = {
      filters: { name: "Summer Sale", subject: "Big Deals" },
    };
    const state = makeState({ intent: "create_campaign", llmExtractedArgs });
    const patch = await campaignAgent.handle(state);

    // fromName, fromEmail, body are still missing
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
  });

  it("clarification message does not contain raw error stack or code", async () => {
    const state = makeState({ intent: "create_campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).not.toMatch(/Error:/);
    expect(patch.error).not.toMatch(/stack/i);
    expect(patch.error).not.toMatch(/-32602/);
  });
});

// ── create_campaign — valid dispatch (all required fields present) ─────────────

describe("create_campaign — all required fields present → valid dispatch", () => {
  const fullFilters: LLMIntentArguments = {
    filters: {
      name:      "Summer Sale",
      subject:   "Big Deals Inside",
      fromName:  "Marketing Team",
      fromEmail: "marketing@example.com",
      body:      "Check out our latest offers.",
    },
  };

  it("sets toolName to create_campaign when all fields are present", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.error).toBeUndefined();
  });

  it("populates all five required fields in toolArgs", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolArgs).toMatchObject({
      name:      "Summer Sale",
      subject:   "Big Deals Inside",
      fromName:  "Marketing Team",
      fromEmail: "marketing@example.com",
      body:      "Check out our latest offers.",
    });
  });

  it("does not set error when dispatch is allowed", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).toBeUndefined();
  });
});

// ── create_campaign — deterministic fallback extraction ───────────────────────

describe("create_campaign — deterministic extraction from userMessage (Gemini unavailable)", () => {
  it("extracts all five fields from a detailed natural-language message", async () => {
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Test Campaign, subject Welcome Offer, " +
        "from Saad at saad@example.com, body: Hello everyone",
      llmExtractedArgs: undefined, // Gemini unavailable
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.error).toBeUndefined();
    expect(patch.toolArgs).toMatchObject({
      name:      "Test Campaign",
      subject:   "Welcome Offer",
      fromName:  "Saad",
      fromEmail: "saad@example.com",
      body:      "Hello everyone",
    });
  });

  it("stops body extraction at 'and then' for multi-step messages", async () => {
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Test Campaign, subject Welcome Offer, " +
        "from Saad at saad@example.com, body: Hello everyone and then start it",
      llmExtractedArgs: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.body).toBe("Hello everyone");
  });

  it("LLM-extracted fields override deterministic extraction when both present", async () => {
    // Gemini extracted a different name via filters
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Regex Name, subject Regex Subject, " +
        "from Regex at regex@example.com, body: Regex body",
      llmExtractedArgs: {
        filters: {
          name:      "LLM Name",      // LLM wins
          subject:   "LLM Subject",   // LLM wins
          fromName:  "LLM Sender",
          fromEmail: "llm@example.com",
          body:      "LLM body",
        },
      },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.name).toBe("LLM Name");
    expect((patch.toolArgs as Record<string, unknown>)?.fromEmail).toBe("llm@example.com");
  });

  it("returns clarification when message has some but not all fields", async () => {
    const state = makeState({
      intent: "create_campaign",
      // Has name but missing subject, fromName, fromEmail, body
      userMessage: "Create a campaign called My Campaign",
      llmExtractedArgs: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
});

// ── MCP not called gate (toolName check) ──────────────────────────────────────

describe("MCP dispatch gate — toolName is undefined when required fields missing", () => {
  it("toolName is undefined for vague create request", async () => {
    const state = makeState({ intent: "create_campaign" });
    const patch = await campaignAgent.handle(state);
    // executeToolNode checks toolName before calling MCP; undefined means no call
    expect(patch.toolName).toBeUndefined();
  });

  it("toolName is set only when all five fields are provided", async () => {
    const withAllFields = makeState({
      intent: "create_campaign",
      llmExtractedArgs: {
        filters: {
          name: "X", subject: "Y", fromName: "Z",
          fromEmail: "a@b.com", body: "Hello",
        },
      },
    });
    const withMissingField = makeState({
      intent: "create_campaign",
      llmExtractedArgs: {
        filters: {
          name: "X", subject: "Y", fromName: "Z",
          fromEmail: "a@b.com",
          // body missing
        },
      },
    });

    const patchFull    = await campaignAgent.handle(withAllFields);
    const patchPartial = await campaignAgent.handle(withMissingField);

    expect(patchFull.toolName).toBe("create_campaign");
    expect(patchPartial.toolName).toBeUndefined();
  });
});

// ── Other campaign intents unaffected ─────────────────────────────────────────

describe("other campaign intents are unaffected", () => {
  it("start_campaign resolves campaignId from LLM extraction", async () => {
    const state = makeState({
      intent: "start_campaign",
      llmExtractedArgs: { campaignId: "camp-123" },
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "camp-123" });
    expect(patch.error).toBeUndefined();
  });

  it("start_campaign resolves campaignId from session fallback", async () => {
    const state = makeState({
      intent:           "start_campaign",
      activeCampaignId: "session-camp-99",
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "session-camp-99" });
  });

  it("pause_campaign with no campaignId still sets toolName (MCP validates)", async () => {
    const state = makeState({ intent: "pause_campaign" });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("pause_campaign");
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeUndefined();
  });

  it("check_smtp maps to get_smtp_settings with empty args", async () => {
    const state = makeState({ intent: "check_smtp" });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_smtp_settings");
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeUndefined();
  });

  it("unknown intent returns error without setting toolName", async () => {
    const state = makeState({ intent: "general_help" as never });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
});
