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
const mockPlanSteps = vi.fn<(a: string, b: readonly string[], c: readonly string[]) => Promise<string | null>>();

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
    activeCampaignId:      undefined,
    senderDefaults:        undefined,
    pendingCampaignDraft:  undefined,
    pendingCampaignStep:   undefined,
    pendingCampaignAction: undefined,
    pendingScheduledAt:    undefined,
    campaignSelectionList: undefined,
    plan:                    undefined,
    planIndex:               0,
    planResults:             [],
    pendingAiCampaignStep:   undefined,
    pendingAiCampaignData:   undefined,
    pendingCsvFile:          undefined,
    pendingCsvData:          undefined,
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

  // ── Scenario 3: risky step inside a safe outer intent ───────────────────────

  it("marks start_campaign requiresApproval=true when it appears as a plan step under a safe intent", async () => {
    // The outer intent is get_campaign_stats (not in CAMPAIGN_ACTION_INTENTS),
    // so the planner runs. It returns start_campaign as a step — approval is set.
    mockPlanStepsResponse({
      isMultiStep: true,
      steps: [
        { tool: "get_campaign_stats", intent: "get_campaign_stats", description: "Check stats first" },
        { tool: "start_campaign",     intent: "start_campaign",     description: "Start if stats look good" },
      ],
    });

    const plan = await plannerService.detectPlan(makeState({
      userMessage: "check stats and then start the campaign",
      intent:      "get_campaign_stats",
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].requiresApproval).toBe(false);
    expect(plan![1].requiresApproval).toBe(true);
  });

  it("returns null for start_campaign as the root intent — always bypasses planner", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "start the campaign and then list the replies",
      intent:           "start_campaign",
      llmExtractedArgs: { campaignId: "camp-abc" },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── Guard: campaign action without campaignId skips planning ───────────────

  it("returns null for start_campaign without a campaignId — routes to CampaignAgent", async () => {
    // planSteps should never be called — guard fires before the OpenAI call.
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "send campaign to all recipients",
      intent:           "start_campaign",
      llmExtractedArgs: undefined,
      activeCampaignId: undefined,
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for pause_campaign without a campaignId — routes to CampaignAgent", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "pause my campaign",
      intent:           "pause_campaign",
      llmExtractedArgs: undefined,
      activeCampaignId: undefined,
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for resume_campaign without a campaignId — routes to CampaignAgent", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "resume the campaign",
      intent:           "resume_campaign",
      llmExtractedArgs: undefined,
      activeCampaignId: undefined,
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for start_campaign even when activeCampaignId is known — always bypasses planner", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "start it and then show replies",
      intent:           "start_campaign",
      activeCampaignId: "session-camp-01",
    }));

    // CAMPAIGN_ACTION_INTENTS always bypass the planner regardless of campaignId,
    // to prevent hallucinated create_campaign → start_campaign plan chains.
    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for generate_personalized_emails — always bypasses planner", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "generate personalized emails for campaign 5",
      intent:           "generate_personalized_emails",
      activeCampaignId: "5",
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
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
      llmExtractedArgs: { campaignId: "42" },
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].toolArgs).toEqual({ campaignId: "42" });
    expect(plan![1].toolArgs).toEqual({ campaignId: "42" });
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
      activeCampaignId: "99",
    }));

    expect(plan).not.toBeNull();
    expect(plan![0].toolArgs).toEqual({ campaignId: "99" });
    expect(plan![1].toolArgs).toEqual({ campaignId: "99" });
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

  it("returns null for pause_campaign with campaignId — always bypasses planner", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "pause campaign 123 and show me stats",
      intent:           "pause_campaign",
      llmExtractedArgs: { campaignId: "123" },
    }));

    // pause_campaign is in CAMPAIGN_ACTION_INTENTS — always bypasses, never plans.
    // "Pause + show stats" compound requests are handled by CampaignAgent then
    // a follow-up analytics call, not by a single multi-step plan.
    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for pause_campaign even when activeCampaignId is set — always bypasses", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "pause the current campaign and show stats",
      intent:           "pause_campaign",
      llmExtractedArgs: {},
      activeCampaignId: "1",
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── schedule_campaign bypass (no campaignId → CampaignAgent handles it) ────

  it("returns null for schedule_campaign without a campaignId — routes to CampaignAgent", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "Schedule this campaign for tomorrow at 10 AM",
      intent:           "schedule_campaign",
      llmExtractedArgs: undefined,
      activeCampaignId: undefined,
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for schedule_campaign even when activeCampaignId is known — always bypasses planner", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "schedule it for tomorrow and then list replies",
      intent:           "schedule_campaign",
      activeCampaignId: "camp-known-01",
    }));

    // schedule_campaign is in CAMPAIGN_ACTION_INTENTS — always bypasses planner.
    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for update_campaign without a campaignId — routes to CampaignAgent wizard", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:      "Update the campaign subject to 'New Offer'",
      intent:           "update_campaign",
      llmExtractedArgs: undefined,
      activeCampaignId: undefined,
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── Active AI wizard: planner must always return null ────────────────────
  // When pendingAiCampaignStep is set, every user reply is a wizard turn.
  // The planner must never intercept it — CampaignAgent owns the state machine.

  it("returns null when AI wizard is active (pendingAiCampaignStep set), regardless of intent", async () => {
    // This is the exact scenario that caused the runtime bug:
    // user typed "Summer Sale Campaign" while wizard awaited a campaign name,
    // Gemini classified it as create_campaign, and the planner generated a plan.
    const plan = await plannerService.detectPlan(makeState({
      userMessage:          "Summer Sale Campaign",
      intent:               "create_campaign",
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null when AI wizard is at campaign_subject step", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:           "Exclusive 50% Off",
      intent:                "create_campaign",
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Summer Sale" },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null when AI wizard is at template_selection step", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:           "1",
      intent:                "template_help",
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: { campaignName: "Summer Sale", subject: "Exclusive 50% Off" },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null when AI wizard is at campaign_body step", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:           "confirm",
      intent:                "create_campaign",
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: { campaignName: "Summer Sale", subject: "Exclusive 50% Off", body: "Hi!" },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── pendingCampaignAction: planner must always return null ───────────────
  // When a campaign action selection is in progress ("1", "Summer Sale", etc.),
  // CampaignAgent owns the turn.  The planner must not intercept terse replies.

  it("returns null when pendingCampaignAction is set — selection reply must reach CampaignAgent", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:           "1",
      intent:                "general_help",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: [{ id: "10", name: "Summer Sale", status: "draft" }],
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null for pendingCampaignAction regardless of intent classification", async () => {
    const plan = await plannerService.detectPlan(makeState({
      userMessage:           "Summer Sale",
      intent:                "create_campaign",  // LLM might mis-classify a campaign name
      pendingCampaignAction: "pause_campaign",
      campaignSelectionList: [{ id: "5", name: "Summer Sale", status: "running" }],
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  // ── Response-only intents: planner must never call OpenAI ─────────────────

  const RESPONSE_ONLY_CASES = [
    { intent: "template_help",           msg: "i want templates" },
    { intent: "upload_recipients_help",  msg: "how do I upload recipients" },
    { intent: "next_step_help",          msg: "what should I do next" },
    { intent: "ai_campaign_help",        msg: "how does ai campaign work" },
    { intent: "recipient_status_help",   msg: "how many recipients do I have" },
    { intent: "out_of_domain",           msg: "what is the capital of France" },
    // Wizard-start intent — must never reach OpenAI; CampaignAgent owns the flow.
    { intent: "create_ai_campaign",      msg: "create an AI campaign" },
    // CSV upload — CampaignAgent owns parse→confirm flow; planner can't supply file args.
    { intent: "upload_csv",              msg: "upload this csv" },
  ] as const;

  for (const { intent, msg } of RESPONSE_ONLY_CASES) {
    it(`returns null for ${intent} without calling OpenAI`, async () => {
      const plan = await plannerService.detectPlan(makeState({
        userMessage: msg,
        intent:      intent as AgentGraphStateType["intent"],
      }));

      expect(plan).toBeNull();
      expect(mockPlanSteps).not.toHaveBeenCalled();
    });
  }

  // ── pendingCsvFile guard ──────────────────────────────────────────────────

  it("returns null without calling OpenAI when pendingCsvFile is present", async () => {
    // The planner must never generate parse_csv_file → save_csv_recipients plans
    // because it cannot populate fileContent/filename from session context.
    const plan = await plannerService.detectPlan(makeState({
      intent:      "get_campaign_stats",
      userMessage: "show stats",
      pendingCsvFile: { filename: "contacts.csv", fileContent: "base64data" },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });

  it("returns null without calling OpenAI when both pendingCsvFile and pendingCsvData are present", async () => {
    const plan = await plannerService.detectPlan(makeState({
      intent:      "upload_csv",
      userMessage: "yes save them",
      pendingCsvFile: { filename: "list.csv", fileContent: "base64data" },
      pendingCsvData: {
        totalRows: 5, validRows: 5, invalidRows: 0,
        columns: ["email", "name"], preview: [], rows: [],
      },
    }));

    expect(plan).toBeNull();
    expect(mockPlanSteps).not.toHaveBeenCalled();
  });
});
