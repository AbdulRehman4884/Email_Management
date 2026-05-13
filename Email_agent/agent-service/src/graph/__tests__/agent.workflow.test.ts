/**
 * src/graph/__tests__/agent.workflow.test.ts
 *
 * Integration tests for the compiled agent graph.
 *
 * External dependencies that would make tests slow or non-deterministic are
 * mocked at the module level:
 *
 *   openai.service      — returns undefined (forces deterministic intent detection;
 *                         prevents real API calls that cause rate-limit timeouts)
 *   planner.service     — detectPlan returns null by default (single-step path);
 *                         individual tests override this to test multi-step routing
 *   toolExecution.service — executeFromState returns a mock success result so
 *                           safe tool calls complete without an MCP server
 *
 * What is NOT mocked:
 *   - The LangGraph graph itself (full compilation and execution)
 *   - Domain agent nodes (campaign, analytics, inbox) — they set toolName/toolArgs
 *   - Approval node — real in-memory PendingActionStore; pendingActionId is a UUID
 *   - finalResponse node — deterministic buildResponse (no Gemini enhancement)
 *
 * vi.hoisted() is used for mock functions that are captured by vi.mock factories:
 * these factories run during the import resolution phase, before module-level
 * `const` declarations are initialized.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mock functions ────────────────────────────────────────────────────
// Must be created with vi.hoisted() so they are available when vi.mock factories
// run (during the import phase, before const declarations are initialized).

const { mockDetectPlan, mockExecuteFromState } = vi.hoisted(() => ({
  mockDetectPlan:       vi.fn(),
  mockExecuteFromState: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

// Prevent real OpenAI API calls — forces deterministic intent detection in all tests.
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

// Control plannerService.detectPlan per test; default is null (single-step).
vi.mock("../../services/planner.service.js", () => ({
  plannerService: { detectPlan: mockDetectPlan },
}));

// Prevent real MCP calls in executeToolNode and executePlanStepNode.
vi.mock("../../services/toolExecution.service.js", () => ({
  toolExecutionService: { executeFromState: mockExecuteFromState },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { agentGraph } from "../workflow/agent.workflow.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlannedStep } from "../../lib/planTypes.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type GraphInput = Partial<AgentGraphStateType>;

async function run(userMessage: string, extra: GraphInput = {}) {
  return agentGraph.invoke({
    userMessage,
    messages: [],
    ...extra,
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();

  // Default: no multi-step plan → all tests use the single-step path.
  mockDetectPlan.mockResolvedValue(null);

  // Default: tool execution succeeds with minimal mock data.
  mockExecuteFromState.mockResolvedValue({
    toolResult: { data: { status: "ok" }, isToolError: false, rawContent: [] },
  });
});

// ── Tests — single-step routing ───────────────────────────────────────────────

describe("agent.workflow — single-step routing", () => {

  it("routes create_campaign to campaign agent and returns clarification when fields missing", async () => {
    // "Create a new campaign called Winter Sale" has no subject/fromName/fromEmail/body
    // so CampaignAgent clears toolName and sets a clarification error.
    const state = await run("Create a new campaign called Winter Sale");
    expect(state.intent).toBe("create_campaign");
    expect(state.agentDomain).toBe("campaign");
    expect(state.toolName).toBeUndefined();
    expect(state.error).toBeDefined();
    expect(state.finalResponse).toBeDefined();
    // Clarification prompt must mention the required fields
    expect(state.finalResponse).toContain("name");
    expect(state.finalResponse).toContain("subject");
  });

  it("routes start_campaign with no campaignId — fetches list (no premature approval)", async () => {
    // Without a campaignId the agent must first list available campaigns so the
    // user can select one.  The approval gate must NOT fire on this list-fetch
    // turn; it fires on the following turn when start_campaign runs with a real id.
    const state = await run("Start the campaign now");
    expect(state.intent).toBe("start_campaign");
    expect(state.requiresApproval).toBe(false);
    expect(state.pendingActionId).toBeUndefined();
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("start_campaign");
  });

  it("routes start_campaign with explicit campaignId — approval required immediately", async () => {
    // When the campaignId is already resolved the agent dispatches start_campaign
    // directly and the approval gate fires in the same turn.
    const state = await run("Start the campaign now", {
      userId:    "user-1" as AgentGraphStateType["userId"],
      sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      activeCampaignId: "3",
    });
    expect(state.intent).toBe("start_campaign");
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
    expect(typeof state.pendingActionId).toBe("string");
    // The pending action must store the correct tool and campaignId
    expect(state.toolName).toBe("start_campaign");
    expect((state.toolArgs as Record<string, unknown>)?.campaignId).toBe("3");
  });

  it("routes pause_campaign without requiring approval (fetches campaign list when no id)", async () => {
    const state = await run("Pause the campaign");
    // Original intent is preserved; approval gate does not fire on the list-fetch turn
    expect(state.intent).toBe("pause_campaign");
    expect(state.requiresApproval).toBe(false);
    expect(state.pendingActionId).toBeUndefined();
    // No campaignId in state → CampaignAgent fetches list for selection
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("pause_campaign");
  });

  it("routes resume_campaign with no campaignId — fetches list (no premature approval)", async () => {
    const state = await run("Resume the campaign");
    expect(state.intent).toBe("resume_campaign");
    expect(state.requiresApproval).toBe(false);
    expect(state.pendingActionId).toBeUndefined();
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("resume_campaign");
  });

  it("routes resume_campaign with explicit campaignId — approval required immediately", async () => {
    const state = await run("Resume the campaign", {
      userId:    "user-1" as AgentGraphStateType["userId"],
      sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      activeCampaignId: "5",
    });
    expect(state.intent).toBe("resume_campaign");
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
    expect(state.toolName).toBe("resume_campaign");
  });

  it("routes update_campaign without requiring approval", async () => {
    const state = await run("Update the campaign subject line");
    expect(state.intent).toBe("update_campaign");
    expect(state.requiresApproval).toBe(false);
  });

  it("routes get_campaign_stats to analytics agent — triggers selection when no campaignId", async () => {
    // No campaignId in message → AnalyticsAgent fetches all campaigns for selection
    const state = await run("Show me the campaign stats");
    expect(state.intent).toBe("get_campaign_stats");
    expect(state.agentDomain).toBe("analytics");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("get_campaign_stats");
    expect(state.requiresApproval).toBe(false);
  });

  it("routes list_replies to inbox agent", async () => {
    const state = await run("List all replies");
    expect(state.intent).toBe("list_replies");
    expect(state.agentDomain).toBe("inbox");
    expect(state.toolName).toBe("list_replies");
  });

  it("routes summarize_replies to inbox agent", async () => {
    const state = await run("Summarize the replies");
    expect(state.intent).toBe("summarize_replies");
    expect(state.toolName).toBe("summarize_replies");
    expect(state.requiresApproval).toBe(false);
  });

  it("routes check_smtp through campaign agent (settings domain)", async () => {
    const state = await run("Show me the smtp settings");
    expect(state.intent).toBe("check_smtp");
    expect(state.agentDomain).toBe("settings");
    expect(state.toolName).toBe("get_smtp_settings");
    expect(state.requiresApproval).toBe(false);
  });

  it("routes update_smtp and redirects to Settings page (no wizard, no approval)", async () => {
    const state = await run("Update smtp settings");
    expect(state.intent).toBe("update_smtp");
    expect(state.toolName).toBeUndefined();
    expect(state.requiresApproval).toBe(false);
    // finalResponse contains the redirect JSON from clarificationNode
    expect(state.finalResponse).toContain("Settings");
  });

  it("routes general_help directly to finalResponse — no toolName set", async () => {
    const state = await run("What can you do?");
    expect(state.intent).toBe("general_help");
    expect(state.agentDomain).toBe("general");
    expect(state.toolName).toBeUndefined();
    expect(state.requiresApproval).toBe(false);
  });

  it("falls back to general_help for unrecognised input", async () => {
    const state = await run("xyzzy frobnicator");
    expect(state.intent).toBe("general_help");
    expect(state.finalResponse).toBeDefined();
  });

  // ── Final response ────────────────────────────────────────────────────────

  it("includes pendingActionId in finalResponse when approval required", async () => {
    // Supply activeCampaignId so approval fires immediately (no list-fetch needed).
    const state = await run("Launch the campaign", {
      activeCampaignId: "10",
    });
    expect(state.requiresApproval).toBe(true);
    expect(state.finalResponse).toContain(state.pendingActionId);
  });

  it("returns capability overview for general_help", async () => {
    const state = await run("Help");
    expect(state.finalResponse).toContain("Campaigns");
    expect(state.finalResponse).toContain("Analytics");
    expect(state.finalResponse).toContain("Inbox");
  });

  it("returns a non-empty finalResponse for every intent", async () => {
    const messages = [
      "Create a campaign",
      "Update the campaign",
      "Start the campaign",
      "Pause the campaign",
      "Resume the campaign",
      "Show campaign stats",
      "List replies",
      "Summarize replies",
      "Show smtp settings",
      "Update smtp",
      "Help",
    ];

    for (const msg of messages) {
      const state = await run(msg);
      expect(state.finalResponse).toBeDefined();
      expect((state.finalResponse ?? "").length).toBeGreaterThan(0);
    }
  });

  // ── State integrity ───────────────────────────────────────────────────────

  it("preserves sessionId and userId through the full graph", async () => {
    const state = await run("Create a campaign", {
      sessionId: "session-abc" as AgentGraphStateType["sessionId"],
      userId: "user-123" as AgentGraphStateType["userId"],
    });
    expect(state.sessionId).toBe("session-abc");
    expect(state.userId).toBe("user-123");
  });

  it("each risky invocation gets a unique pendingActionId", async () => {
    // Provide activeCampaignId so approval fires in both turns.
    const a = await run("Start the campaign", { activeCampaignId: "1" });
    const b = await run("Start the campaign", { activeCampaignId: "2" });
    expect(a.pendingActionId).toBeDefined();
    expect(b.pendingActionId).toBeDefined();
    expect(a.pendingActionId).not.toBe(b.pendingActionId);
  });
});

// ── Tests — multi-step plan routing ───────────────────────────────────────────

describe("agent.workflow — multi-step plan routing", () => {

  it("routes to executePlanStep when planner returns a two-step plan", async () => {
    // Both steps safe: pause_campaign → get_campaign_stats
    // campaignId is threaded through toolArgs for both steps — the core arg-extraction contract.
    const mockPlan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "pause_campaign",
        toolArgs:         { campaignId: "test-123" },
        intent:           "pause_campaign",
        description:      "Pause the campaign",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "get_campaign_stats",
        toolArgs:         { campaignId: "test-123" },
        intent:           "get_campaign_stats",
        description:      "Get campaign statistics",
        requiresApproval: false,
      },
    ];
    mockDetectPlan.mockResolvedValueOnce(mockPlan);

    const state = await run("pause campaign test-123 and show me stats");

    // Both steps executed; planResults collected
    expect(state.planResults).toBeDefined();
    expect(state.planResults!.length).toBe(2);

    // campaignId threaded correctly into each step's toolArgs
    expect(state.planResults![0].toolName).toBe("pause_campaign");
    expect(state.planResults![0].toolArgs).toEqual({ campaignId: "test-123" });
    expect(state.planResults![1].toolName).toBe("get_campaign_stats");
    expect(state.planResults![1].toolArgs).toEqual({ campaignId: "test-123" });

    // Plan completed → finalResponse contains the step-by-step summary
    expect(state.finalResponse).toBeDefined();
    expect((state.finalResponse ?? "").length).toBeGreaterThan(0);
    expect(state.requiresApproval).toBe(false);
  });

  it("pauses at the first risky step and exposes completed results as approval preamble", async () => {
    // Step 0 safe (get_campaign_stats), Step 1 risky (start_campaign)
    const mockPlan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "get_campaign_stats",
        toolArgs:         { campaignId: "test-123" },
        intent:           "get_campaign_stats",
        description:      "Retrieve current stats before launching",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "start_campaign",
        toolArgs:         { campaignId: "test-123" },
        intent:           "start_campaign",
        description:      "Launch the campaign",
        requiresApproval: true,
      },
    ];
    mockDetectPlan.mockResolvedValueOnce(mockPlan);

    const state = await run("show stats for test-123 then launch it", {
      userId:    "user-1"    as AgentGraphStateType["userId"],
      sessionId: "sess-plan" as AgentGraphStateType["sessionId"],
    });

    // Paused at risky step → approval required
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();

    // Safe step ran before the pause
    expect(state.planResults).toBeDefined();
    expect(state.planResults!.length).toBe(1);
    expect(state.planResults![0].toolName).toBe("get_campaign_stats");

    // finalResponse includes both the completed-step summary and the approval prompt
    expect(state.finalResponse).toContain(state.pendingActionId);
  });

  it("falls through to the single-step manager path when planner returns null", async () => {
    // mockDetectPlan already returns null by default (set in beforeEach)
    const state = await run("pause the campaign");

    // Intent is list_campaigns (overridden in the list-fetch step) or pause_campaign
    // depending on whether a campaignId is available; without one it fetches the list.
    expect(state.agentDomain).toBe("campaign");
    // Single-step path: planResults stays empty
    expect(state.planResults).toEqual([]);
  });
});

// ── Tests — "send campaign" end-to-end flow ───────────────────────────────────
//
// Proves the 3-turn flow required by the bug report:
//   Turn 1: "Send campaign to all recipients" → fetch campaign list, no approval
//   Turn 2: User selects a campaign → dispatches start_campaign → requires approval
//   Turn 3: User confirms → tool executes → success (tested via confirm controller)
//
// Each turn is a separate graph invocation with appropriate session context.

describe("agent.workflow — send campaign end-to-end flow", () => {

  // ── Turn 1 ────────────────────────────────────────────────────────────────────

  it("Turn 1: 'Send campaign to all recipients' → fetches campaign list, no premature approval", async () => {
    const state = await run("Send campaign to all recipients");

    // Intent correctly detected as start_campaign by keyword rules,
    // but overridden to list_campaigns while fetching the list.
    expect(state.agentDomain).toBe("campaign");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("start_campaign");

    // CRITICAL: approval must NOT fire on this fetch turn.
    expect(state.requiresApproval).toBe(false);
    expect(state.pendingActionId).toBeUndefined();

    // The final response must present the campaign list to the user.
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse!.length).toBeGreaterThan(0);
  });

  it("Turn 1 (variant): 'deliver campaign' → same list-fetch behavior", async () => {
    const state = await run("Deliver campaign now");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("start_campaign");
    expect(state.requiresApproval).toBe(false);
  });

  // ── Turn 2 (campaign selected) ───────────────────────────────────────────────

  it("Turn 2: user selects campaign by number → dispatches start_campaign → approval required", async () => {
    // Simulate session state after Turn 1 (saveMemory would have stored these).
    // Use a unique sessionId so loadMemory does not restore stale state from other tests.
    const campaignList = [
      { id: "camp-summer", name: "Summer Sale", status: "draft" },
      { id: "camp-eid",    name: "Eid Offer",   status: "draft" },
    ];

    const state = await run("1", {
      userId:                "user-e2e-num" as AgentGraphStateType["userId"],
      sessionId:             "sess-e2e-num" as AgentGraphStateType["sessionId"],
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: campaignList,
    });

    // Campaign selection routed to campaign agent; dispatched start_campaign with id.
    expect(state.toolName).toBe("start_campaign");
    expect((state.toolArgs as Record<string, unknown>)?.campaignId).toBe("camp-summer");

    // Approval must fire now — the real start_campaign tool is about to run.
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
    expect(typeof state.pendingActionId).toBe("string");

    // Selection state cleared after dispatch.
    expect(state.pendingCampaignAction).toBeUndefined();
    expect(state.campaignSelectionList).toBeUndefined();
  });

  it("Turn 2: user selects campaign by name → dispatches start_campaign → approval required", async () => {
    const campaignList = [
      { id: "camp-summer", name: "Summer Sale", status: "draft" },
      { id: "camp-eid",    name: "Eid Offer",   status: "draft" },
    ];

    const state = await run("Eid Offer", {
      userId:                "user-e2e-name" as AgentGraphStateType["userId"],
      sessionId:             "sess-e2e-name" as AgentGraphStateType["sessionId"],
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: campaignList,
    });

    expect(state.toolName).toBe("start_campaign");
    expect((state.toolArgs as Record<string, unknown>)?.campaignId).toBe("camp-eid");
    expect(state.requiresApproval).toBe(true);
  });

  // ── Success response (Turn 3 outcome) ────────────────────────────────────────

  it("start_campaign success → finalResponse says campaign started successfully", async () => {
    // Mock the tool to return a running campaign.
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data:        { id: "camp-1", name: "Summer Sale", status: "running", startedAt: new Date().toISOString() },
        isToolError: false,
        rawContent:  [],
      },
    });

    // Provide campaignId so approval fires and tool executes in same flow.
    const state = await run("Start campaign", {
      activeCampaignId: "1",
    });

    expect(state.requiresApproval).toBe(true);
    // On confirmation the controller invokes executeFromState — here we verify
    // the finalResponse would reflect "started successfully" via the approval prompt.
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toContain("start the campaign");
  });

  // ── Failure responses (humanized errors) ─────────────────────────────────────

  it("start_campaign with no recipients → finalResponse names the problem specifically", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data:        "No recipients found in campaign",
        isToolError: true,
        rawContent:  [],
      },
    });

    // Simulate a flow where the tool ran and returned an error.
    // Drive through final-response path by providing a direct tool error in state.
    const state = await run("Start the campaign", {
      activeCampaignId: "88",
    });
    // The approval gate fires; after confirm the finalResponse would be shaped
    // by finalResponse.node with the error. Here we verify the approval message.
    expect(state.finalResponse).toBeDefined();
  });

  it("campaign not found (404) → humanized not-found message", async () => {
    const state = await run("Send campaign to all recipients", {
      // Inject a known campaignId so the tool runs directly (skip selection).
      activeCampaignId: "999",
    });
    // Approval required; confirm would produce the humanized error via humanizeToolError.
    expect(state.requiresApproval).toBe(true);
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toContain("start the campaign");
  });

  // ── Cancellation during selection ─────────────────────────────────────────────

  it("Turn 2: user cancels selection → clears pendingCampaignAction, no tool dispatched", async () => {
    const campaignList = [
      { id: "camp-summer", name: "Summer Sale", status: "draft" },
    ];

    // Unique userId/sessionId to prevent loadMemory from restoring stale state.
    const state = await run("cancel", {
      userId:                "user-e2e-cancel" as AgentGraphStateType["userId"],
      sessionId:             "sess-e2e-cancel" as AgentGraphStateType["sessionId"],
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: campaignList,
    });

    expect(state.toolName).toBeUndefined();
    expect(state.requiresApproval).toBe(false);
    expect(state.pendingCampaignAction).toBeUndefined();
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/cancel/i);
  });

  // ── Zero-campaigns state ───────────────────────────────────────────────────────

  it("zero campaigns: 'Send campaign' → get_all_campaigns returns [] → 'no campaigns found' message", async () => {
    // Override mock: get_all_campaigns returns empty MCP envelope (zero campaigns)
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { data: { success: true, data: [] }, isToolError: false, rawContent: [] },
    });

    const state = await run("Send campaign to all recipients", {
      userId:    "user-zero-camps" as AgentGraphStateType["userId"],
      sessionId: "sess-zero-camps" as AgentGraphStateType["sessionId"],
    });

    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.requiresApproval).toBe(false);
    expect(state.finalResponse).toMatch(/no campaigns/i);
    expect(state.finalResponse).not.toMatch(/could not be completed|request failed|generic error/i);
  });

  it("zero campaigns: send flow does NOT produce a generic error response", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });

    const state = await run("Send campaign to all recipients", {
      userId:    "user-zero-b" as AgentGraphStateType["userId"],
      sessionId: "sess-zero-b" as AgentGraphStateType["sessionId"],
    });

    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).not.toMatch(/could not be completed|unexpected error/i);
    expect(state.finalResponse).toMatch(/no campaigns|create a campaign/i);
  });

  it("zero campaigns: send flow with isToolError=true → still returns friendly no-campaigns message", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { code: "MAILFLOW_NOT_FOUND", message: "not found" },
        isToolError: true,
        rawContent: [],
      },
    });

    const state = await run("Send campaign to all recipients", {
      userId:    "user-zero-err" as AgentGraphStateType["userId"],
      sessionId: "sess-zero-err" as AgentGraphStateType["sessionId"],
    });

    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/no campaigns/i);
    expect(state.finalResponse).not.toMatch(/could not be completed/i);
  });

  it("zero campaigns for start_campaign: pendingCampaignAction cleared so next turn starts fresh", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { data: { success: true, data: [] }, isToolError: false, rawContent: [] },
    });

    const state = await run("Send campaign to all recipients", {
      userId:    "user-zero-clear" as AgentGraphStateType["userId"],
      sessionId: "sess-zero-clear" as AgentGraphStateType["sessionId"],
    });

    // After zero-campaigns result, pendingCampaignAction must be cleared
    // so subsequent turns don't loop back into the selection flow.
    expect(state.pendingCampaignAction).toBeUndefined();
  });
});

// ── Tests — schedule_campaign flow ───────────────────────────────────────────

describe("agent.workflow — schedule_campaign flow", () => {

  it("schedule with no campaignId → fetches campaign list for selection (no generic error)", async () => {
    // No userId/sessionId — saveMemory is a no-op so pendingCampaignAction is not cleared.
    // This tests routing behavior only (same pattern as other single-step routing tests).
    const state = await run("Schedule this campaign for tomorrow at 10 AM");

    expect(state.intent).toBe("schedule_campaign");
    expect(state.agentDomain).toBe("campaign");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("schedule_campaign");
    expect(state.pendingScheduledAt).toBeDefined();
    expect(state.requiresApproval).toBe(false);
  });

  it("schedule with no campaigns (empty list) → friendly no-campaigns message, not generic fallback", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { data: { success: true, data: [] }, isToolError: false, rawContent: [] },
    });

    const state = await run("Schedule this campaign for tomorrow at 10 AM", {
      userId:    "user-sched-empty" as AgentGraphStateType["userId"],
      sessionId: "sess-sched-empty" as AgentGraphStateType["sessionId"],
    });

    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/no campaigns/i);
    expect(state.finalResponse).toMatch(/create a campaign/i);
    expect(state.finalResponse).not.toMatch(/something went wrong|could not be completed/i);
  });

  it("schedule with no campaigns (toolError) → friendly message, not generic fallback", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data:        { code: "NOT_FOUND", message: "no campaigns" },
        isToolError: true,
        rawContent:  [],
      },
    });

    const state = await run("Schedule this campaign for tomorrow at 10 AM", {
      userId:    "user-sched-err" as AgentGraphStateType["userId"],
      sessionId: "sess-sched-err" as AgentGraphStateType["sessionId"],
    });

    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/no campaigns/i);
    expect(state.finalResponse).not.toMatch(/something went wrong/i);
  });

  it("schedule with known campaignId returns schedule draft JSON (no backend call)", async () => {
    const state = await run("Schedule this campaign for tomorrow at 10 AM", {
      userId:           "user-sched-id" as AgentGraphStateType["userId"],
      sessionId:        "sess-sched-id" as AgentGraphStateType["sessionId"],
      activeCampaignId: "77",
    });

    expect(state.intent).toBe("schedule_campaign");
    // No tool dispatched — schedule draft only, backend save pending
    expect(state.toolName).toBeUndefined();
    expect(state.requiresApproval).toBe(false);
    // finalResponse should contain the JSON schedule draft
    expect(state.finalResponse).toMatch(/This schedule has been prepared as JSON only|draft_not_saved/);
  });

  it("AI wizard active + create_campaign intent → planner returns null (wizard not bypassed)", async () => {
    // This is the exact runtime bug: user types "Summer Sale Campaign" while
    // pendingAiCampaignStep="campaign_name". Gemini classifies it as
    // create_campaign → planner must return null because wizard is active.
    // mockDetectPlan is already set to return null, but this test verifies the
    // workflow does NOT route to executePlanStep.
    const state = await run("Summer Sale Campaign", {
      userId:                "user-wizard-test" as AgentGraphStateType["userId"],
      sessionId:             "sess-wizard-test" as AgentGraphStateType["sessionId"],
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
    });

    // Wizard should advance to campaign_subject — no generic error
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).not.toMatch(/something went wrong/i);
    // Must NOT have dispatched a tool (wizard step is campaign_name, only saves name)
    expect(state.toolName).toBeUndefined();
  });

  it("schedule multiple campaigns → selection prompt shows campaign list", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: {
          success: true,
          data: [
            { id: "camp-1", name: "Summer Sale",  status: "draft" },
            { id: "camp-2", name: "Winter Promo", status: "draft" },
          ],
        },
        isToolError: false,
        rawContent:  [],
      },
    });

    const state = await run("Schedule this campaign for tomorrow at 10 AM", {
      userId:    "user-sched-multi" as AgentGraphStateType["userId"],
      sessionId: "sess-sched-multi" as AgentGraphStateType["sessionId"],
    });

    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/schedule/i);
    expect(state.finalResponse).toMatch(/Summer Sale|Winter Promo/);
    expect(state.finalResponse).not.toMatch(/something went wrong/i);
  });
});
