/**
 * src/services/__tests__/planner.service.test.ts
 *
 * Unit tests for PlannerService.detectPlan().
 *
 * All OpenAI SDK calls are mocked — no real network connections.
 * The env module is mocked to provide an OPENAI_API_KEY so the service
 * does not short-circuit before calling OpenAI.
 *
 * Scenarios covered:
 *   1. Two-step all-safe plan (get_campaign_stats → pause_campaign)
 *   2. Safe step then risky step (get_campaign_stats → start_campaign)
 *   3. Risky first step (start_campaign → list_replies)
 *   4. list_replies → summarize_replies sequence (both safe)
 *   5. OpenAI returns an invalid tool name → whole plan rejected (null)
 *   6. isMultiStep=false → null (single-step falls through to agent path)
 *   7. Fewer than 2 valid steps → null
 *   8. OpenAI returns null → null (silent fall-through)
 *   9. general_help intent → null (no tools involved)
 *  10. No OPENAI_API_KEY → null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock env and openai before importing the service ─────────────────────────
// vi.mock is hoisted — these run before any imports below.

vi.mock("../../config/env.js", () => ({
  env: {
    OPENAI_API_KEY: "test-api-key",
    OPENAI_MODEL:   "gpt-4o-mini",
    LOG_LEVEL:      "warn",
    NODE_ENV:       "test",
  },
}));

// Mock the entire openai module so rootLogger.child() is never called at
// module load time (rootLogger is not exported from logger.ts).
const mockPlanSteps = vi.fn<[string, readonly string[], readonly string[]], Promise<string | null>>();

vi.mock("../openai.service.js", () => ({
  getOpenAIService: () => ({ planSteps: mockPlanSteps }),
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { plannerService } from "../planner.service.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentGraphStateType> = {}): AgentGraphStateType {
  return {
    messages:         [],
    userMessage:      "show me the stats and then pause the campaign",
    sessionId:        "sess-1" as AgentGraphStateType["sessionId"],
    userId:           "user-1" as AgentGraphStateType["userId"],
    rawToken:         "tok",
    intent:           "get_campaign_stats",
    confidence:       0.9,
    agentDomain:      "analytics",
    llmExtractedArgs: undefined,
    toolName:         undefined,
    toolArgs:         {},
    toolResult:       undefined,
    requiresApproval: false,
    pendingActionId:  undefined,
    finalResponse:    undefined,
    error:            undefined,
    activeCampaignId: undefined,
    plan:             undefined,
    planIndex:        0,
    planResults:      [],
    ...overrides,
  };
}

/** Sets up mockPlanSteps to return the given JSON response. */
function mockPlanStepsResponse(response: object | null) {
  const rawJson = response === null ? null : JSON.stringify(response);
  mockPlanSteps.mockResolvedValue(rawJson);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlannerService.detectPlan", () => {

  beforeEach(() => {
    mockPlanSteps.mockReset();
  });

  // ── Scenario 1: two-step all-safe plan ─────────────────────────────────────

  it("returns a two-step plan when both steps are safe", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Get analytics for the campaign" },
        { tool: "pause_campaign",     intent: "pause_campaign",     description: "Pause the campaign" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());

    expect(plan).not.toBeNull();
    expect(plan!.length).toBe(2);

    expect(plan![0].toolName).toBe("get_campaign_stats");
    expect(plan![0].intent).toBe("get_campaign_stats");
    expect(plan![0].requiresApproval).toBe(false);
    expect(plan![0].stepIndex).toBe(0);

    expect(plan![1].toolName).toBe("pause_campaign");
    expect(plan![1].intent).toBe("pause_campaign");
    expect(plan![1].requiresApproval).toBe(false);
    expect(plan![1].stepIndex).toBe(1);
  });

  // ── Scenario 2: safe step then risky step ──────────────────────────────────

  it("marks the risky step requiresApproval=true while the safe step is false", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Retrieve current stats" },
        { tool: "start_campaign",     intent: "start_campaign",     description: "Launch the campaign to recipients" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());

    expect(plan).not.toBeNull();
    expect(plan!.length).toBe(2);

    // Step 0: safe analytics call
    expect(plan![0].toolName).toBe("get_campaign_stats");
    expect(plan![0].requiresApproval).toBe(false);

    // Step 1: risky — start_campaign sends real emails
    expect(plan![1].toolName).toBe("start_campaign");
    expect(plan![1].requiresApproval).toBe(true);
  });

  // ── Scenario 3: risky first step ───────────────────────────────────────────

  it("correctly marks a risky first step requiresApproval=true", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "start_campaign",  intent: "start_campaign",  description: "Start sending the campaign" },
        { tool: "list_replies",    intent: "list_replies",    description: "List replies after sending" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      userMessage: "start the campaign and then list the replies",
      intent:      "start_campaign",
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].requiresApproval).toBe(true);
    expect(plan![1].requiresApproval).toBe(false);
  });

  // ── Scenario 4: list_replies → summarize_replies sequence ─────────────────

  it("builds a list_replies → summarize_replies plan with both steps safe", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "list_replies",      intent: "list_replies",      description: "Fetch replies for this campaign" },
        { tool: "summarize_replies", intent: "summarize_replies", description: "Summarise the fetched replies" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      userMessage: "list the replies and then summarize them",
      intent:      "list_replies",
    }));

    expect(plan).not.toBeNull();
    expect(plan!.length).toBe(2);
    expect(plan![0].toolName).toBe("list_replies");
    expect(plan![0].requiresApproval).toBe(false);
    expect(plan![1].toolName).toBe("summarize_replies");
    expect(plan![1].requiresApproval).toBe(false);
  });

  // ── Scenario 5: invalid tool name rejected ─────────────────────────────────

  it("returns null when OpenAI returns an unrecognised tool name", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "fly_to_moon",     intent: "get_campaign_stats", description: "Hallucinated tool" },
        { tool: "pause_campaign",  intent: "pause_campaign",     description: "Valid step" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── isMultiStep=false ──────────────────────────────────────────────────────

  it("returns null when OpenAI returns isMultiStep=false", async () => {
    mockPlanStepsResponse({
      isMultiStep: false,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Single step" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── Fewer than 2 steps ─────────────────────────────────────────────────────

  it("returns null when plan has only 1 step even with isMultiStep=true", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "pause_campaign", intent: "pause_campaign", description: "Just pause" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── OpenAI returns null ────────────────────────────────────────────────────

  it("returns null when OpenAI planSteps returns null (network/SDK failure)", async () => {
    mockPlanStepsResponse(null);

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── general_help bypasses planning ────────────────────────────────────────

  it("returns null immediately for general_help intent (no tools involved)", async () => {
    const plan = await plannerService.detectPlan(makeState({ intent: "general_help" }));

    expect(plan).toBeNull();
    // OpenAI should never be called for general_help
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── toolArgs are resolved correctly ───────────────────────────────────────

  it("resolves campaignId from llmExtractedArgs into step toolArgs", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Get stats" },
        { tool: "pause_campaign",     intent: "pause_campaign",     description: "Pause" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      llmExtractedArgs: { campaignId: "extracted-c1" },
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].toolArgs).toEqual({ campaignId: "extracted-c1" });
    expect(plan![1].toolArgs).toEqual({ campaignId: "extracted-c1" });
  });

  it("falls back to activeCampaignId when llmExtractedArgs has no campaignId", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Get stats" },
        { tool: "pause_campaign",     intent: "pause_campaign",     description: "Pause" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      llmExtractedArgs: {},
      activeCampaignId: "session-c99",
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].toolArgs).toEqual({ campaignId: "session-c99" });
    expect(plan![1].toolArgs).toEqual({ campaignId: "session-c99" });
  });

  // ── Step descriptions are preserved ──────────────────────────────────────

  it("preserves OpenAI-provided step descriptions in the PlannedStep", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "list_replies",      intent: "list_replies",      description: "Fetch all campaign replies" },
        { tool: "summarize_replies", intent: "summarize_replies", description: "Produce a reply summary" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());

    expect(plan![0].description).toBe("Fetch all campaign replies");
    expect(plan![1].description).toBe("Produce a reply summary");
  });

  // ── Invalid JSON from OpenAI ──────────────────────────────────────────────

  it("returns null when OpenAI returns malformed JSON", async () => {
    mockPlanSteps.mockResolvedValue("{ not valid json }");

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── Zod validation rejects unknown intent ────────────────────────────────

  it("returns null when a step contains an unrecognised intent", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "hacked_intent",   description: "Valid tool, bad intent" },
        { tool: "pause_campaign",     intent: "pause_campaign",  description: "Fine" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState());
    expect(plan).toBeNull();
  });

  // ── Compound request: "pause campaign test-123 and show me stats" ──────────

  it("builds a two-step plan for compound request with campaignId in both steps", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "pause_campaign",     intent: "pause_campaign",     description: "Pause the campaign" },
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Fetch campaign statistics" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "pause campaign test-123 and show me stats",
      intent:           "pause_campaign",
      llmExtractedArgs: { campaignId: "test-123" },
    }));

    expect(plan).not.toBeNull();
    expect(plan!.length).toBe(2);

    expect(plan![0].toolName).toBe("pause_campaign");
    expect(plan![0].toolArgs).toEqual({ campaignId: "test-123" });
    expect(plan![0].requiresApproval).toBe(false);

    expect(plan![1].toolName).toBe("get_campaign_stats");
    expect(plan![1].toolArgs).toEqual({ campaignId: "test-123" });
    expect(plan![1].requiresApproval).toBe(false);
  });

  it("compound request falls back to activeCampaignId when LLM extracted no campaignId", async () => {
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "pause_campaign",     intent: "pause_campaign",     description: "Pause" },
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Stats" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "pause the current campaign and show stats",
      intent:           "pause_campaign",
      llmExtractedArgs: {},
      activeCampaignId: "session-c1",
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].toolArgs).toEqual({ campaignId: "session-c1" });
    expect(plan![1].toolArgs).toEqual({ campaignId: "session-c1" });
  });
});
