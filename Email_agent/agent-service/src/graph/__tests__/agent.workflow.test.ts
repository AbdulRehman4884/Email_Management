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

  it("routes start_campaign and flags approval required", async () => {
    const state = await run("Start the campaign now");
    expect(state.intent).toBe("start_campaign");
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
    expect(typeof state.pendingActionId).toBe("string");
  });

  it("routes pause_campaign without requiring approval", async () => {
    const state = await run("Pause the campaign");
    expect(state.intent).toBe("pause_campaign");
    expect(state.requiresApproval).toBe(false);
    expect(state.toolName).toBe("pause_campaign");
  });

  it("routes resume_campaign and flags approval required", async () => {
    const state = await run("Resume the campaign");
    expect(state.intent).toBe("resume_campaign");
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
  });

  it("routes update_campaign without requiring approval", async () => {
    const state = await run("Update the campaign subject line");
    expect(state.intent).toBe("update_campaign");
    expect(state.requiresApproval).toBe(false);
  });

  it("routes get_campaign_stats to analytics agent", async () => {
    const state = await run("Show me the campaign stats");
    expect(state.intent).toBe("get_campaign_stats");
    expect(state.agentDomain).toBe("analytics");
    expect(state.toolName).toBe("get_campaign_stats");
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

  it("routes update_smtp and flags approval required", async () => {
    const state = await run("Update smtp settings");
    expect(state.intent).toBe("update_smtp");
    expect(state.toolName).toBe("update_smtp_settings");
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();
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
    const state = await run("Launch the campaign");
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
    const a = await run("Start the campaign");
    const b = await run("Start the campaign");
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

    expect(state.intent).toBe("pause_campaign");
    // Single-step path: planResults stays empty, agentDomain is set by manager
    expect(state.planResults).toEqual([]);
    expect(state.agentDomain).toBe("campaign");
  });
});
