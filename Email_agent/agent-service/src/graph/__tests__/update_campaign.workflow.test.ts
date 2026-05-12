/**
 * src/graph/__tests__/update_campaign.workflow.test.ts
 *
 * Regression tests for the update_campaign intent.
 *
 * New behavior (bug fix):
 *   - No campaignId → triggers campaign selection flow (get_all_campaigns)
 *   - campaignId present + update field → executes update_campaign tool directly
 *   - campaignId present, no field → enters wizard to collect the field
 *
 * OpenAI is mocked (no real API calls).
 * toolExecutionService is mocked (no real MCP calls).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mock functions ────────────────────────────────────────────────────

const { mockDetectPlan, mockExecuteFromState } = vi.hoisted(() => ({
  mockDetectPlan:       vi.fn(),
  mockExecuteFromState: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

vi.mock("../../services/planner.service.js", () => ({
  plannerService: { detectPlan: mockDetectPlan },
}));

vi.mock("../../services/toolExecution.service.js", () => ({
  toolExecutionService: { executeFromState: mockExecuteFromState },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { agentGraph } from "../workflow/agent.workflow.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_CAMPAIGNS = [
  { id: "1", name: "Summer Sale",  status: "draft" },
  { id: "2", name: "Eid Offer",    status: "paused" },
  { id: "3", name: "Black Friday", status: "draft" },
];

async function run(userMessage: string, extra: Partial<AgentGraphStateType> = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  // Default mock: campaign list result for get_all_campaigns calls
  mockExecuteFromState.mockResolvedValue({
    toolResult: { data: MOCK_CAMPAIGNS, isToolError: false, rawContent: [] },
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("update_campaign — QA regression tests", () => {

  // ── No campaignId: triggers campaign selection flow ───────────────────────────

  it("'Update an existing campaign' → triggers campaign selection (no campaignId)", async () => {
    const state = await run("Update an existing campaign");

    expect(state.intent).toBe("update_campaign");
    expect(state.agentDomain).toBe("campaign");

    // Enters selection flow — fetches campaign list
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("update_campaign");

    // Response is a plain-text campaign selection prompt
    expect(state.finalResponse).toBeDefined();
    expect(state.finalResponse).toMatch(/which campaign/i);
    expect(state.finalResponse).toContain("Summer Sale");
  });

  it("'edit campaign' → same campaign selection flow (synonym)", async () => {
    const state = await run("Edit campaign");
    expect(state.intent).toBe("update_campaign");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("update_campaign");
    expect(state.finalResponse).toMatch(/which campaign/i);
  });

  it("'modify campaign' → same campaign selection flow (synonym)", async () => {
    const state = await run("Modify campaign");
    expect(state.intent).toBe("update_campaign");
    expect(state.toolName).toBe("get_all_campaigns");
    expect(state.pendingCampaignAction).toBe("update_campaign");
  });

  // ── campaignId via activeCampaignId + field present → executes tool ───────────

  it("with activeCampaignId + subject → executes update_campaign", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: { data: { id: "1", name: "Summer Sale", status: "updated" }, isToolError: false, rawContent: [] },
    });

    // Include "campaign" so keyword detector picks update_campaign
    const state = await run("Update campaign subject to New Offer", {
      activeCampaignId: "1" as AgentGraphStateType["activeCampaignId"],
    });

    expect(state.intent).toBe("update_campaign");
    expect(mockExecuteFromState).toHaveBeenCalledOnce();

    const response = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(response.status).toBe("success");
    expect(response.intent).toBe("update_campaign");
  });

  it("with activeCampaignId + name → executes update_campaign and returns success JSON", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: { data: { id: "1", name: "Summer Sale 2", status: "draft" }, isToolError: false, rawContent: [] },
    });

    const state = await run("Update campaign name to Summer Sale 2", {
      activeCampaignId: "2" as AgentGraphStateType["activeCampaignId"],
    });

    expect(state.intent).toBe("update_campaign");
    expect(mockExecuteFromState).toHaveBeenCalledOnce();

    const response = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(response.status).toBe("success");
    expect(response.data).toBeDefined();
  });

  // ── campaignId via activeCampaignId, no field → wizard ───────────────────────

  it("with activeCampaignId but no update field → enters update field wizard", async () => {
    // Include "campaign" so keyword detector picks update_campaign (not update_smtp)
    const state = await run("Update campaign", {
      activeCampaignId: "2" as AgentGraphStateType["activeCampaignId"],
    });

    expect(state.intent).toBe("update_campaign");

    // Wizard mode: no tool executed, asks what to update
    expect(mockExecuteFromState).not.toHaveBeenCalled();
    expect(state.pendingCampaignDraft).toBeDefined();
    expect(state.pendingCampaignStep).toBe("update_select_field");
    expect(state.finalResponse).toMatch(/name|subject|body|sender/i);
  });

  // ── No campaigns case ─────────────────────────────────────────────────────────

  it("no campaigns found → shows 'no campaigns' message", async () => {
    mockExecuteFromState.mockResolvedValue({
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });

    const state = await run("Update an existing campaign");
    expect(state.intent).toBe("update_campaign");
    expect(state.finalResponse).toMatch(/no campaigns/i);
  });

  // ── Tool safety: get_all_campaigns is called for selection, not update_campaign ─

  it("never calls update_campaign tool without a campaignId", async () => {
    await run("Update an existing campaign");
    await run("Edit campaign");

    // get_all_campaigns was called (for selection), NOT update_campaign
    const calls = mockExecuteFromState.mock.calls;
    for (const [stateArg] of calls) {
      expect((stateArg as AgentGraphStateType).toolName).not.toBe("update_campaign");
    }
  });
});
