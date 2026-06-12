/**
 * src/graph/__tests__/update_campaign.workflow.test.ts
 *
 * QA regression tests for the update_campaign intent fix.
 *
 * Covers the three test cases identified by QA:
 *
 *   Test 1 — "Update an existing campaign"
 *     No campaignId, no update fields → structured needs_input JSON
 *
 *   Test 2 — "Update campaign Summer Sale"
 *     campaignId extracted but no update fields → structured needs_input JSON
 *     (asking what to change on that specific campaign)
 *
 *   Test 3 — "Update campaign ID 123 subject to 'New Offer'"
 *     campaignId + subject extracted → tool executes → structured success JSON
 *
 * OpenAI is mocked (no real API calls).
 * toolExecutionService is mocked (no real MCP calls).
 * The compiled graph, CampaignAgent, validationNode, and clarificationNode are real.
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

async function run(userMessage: string, extra: Partial<AgentGraphStateType> = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

function parseResponse(finalResponse: string | undefined): Record<string, unknown> {
  if (!finalResponse) throw new Error("finalResponse is undefined");
  return JSON.parse(finalResponse) as Record<string, unknown>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockResolvedValue({
    toolResult: { data: { id: "123", status: "updated" }, isToolError: false, rawContent: [] },
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("update_campaign — QA regression tests", () => {

  // ── Test 1: vague request (no campaignId, no fields) ─────────────────────────

  it("Test 1: 'Update an existing campaign' → structured needs_input response", async () => {
    const state = await run("Update an existing campaign");

    // Intent must be detected correctly — the key fix for this bug
    expect(state.intent).toBe("update_campaign");
    expect(state.agentDomain).toBe("campaign");

    // Validation must block dispatch — no tool should execute
    expect(state.toolName).toBeUndefined();
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    // Response must be structured JSON
    expect(state.finalResponse).toBeDefined();
    const response = parseResponse(state.finalResponse);

    expect(response.status).toBe("needs_input");
    expect(response.intent).toBe("update_campaign");
    expect(typeof response.message).toBe("string");
    expect((response.message as string).length).toBeGreaterThan(0);

    // Required fields must be communicated to the caller
    expect(Array.isArray(response.required_fields)).toBe(true);
    const requiredFields = response.required_fields as string[];
    expect(requiredFields.length).toBeGreaterThan(0);
    // campaign_id is the key required field for update
    expect(requiredFields.some((f) => f.toLowerCase().includes("campaign_id"))).toBe(true);
  });

  it("'edit campaign' → same needs_input response (synonym)", async () => {
    const state = await run("Edit campaign");
    expect(state.intent).toBe("update_campaign");
    const response = parseResponse(state.finalResponse);
    expect(response.status).toBe("needs_input");
  });

  it("'modify campaign' → same needs_input response (synonym)", async () => {
    const state = await run("Modify campaign");
    expect(state.intent).toBe("update_campaign");
    const response = parseResponse(state.finalResponse);
    expect(response.status).toBe("needs_input");
  });

  // ── Test 2: campaignId present, no update fields ──────────────────────────────

  it("Test 2: 'Update campaign Summer Sale' → needs_input asking what to change", async () => {
    const state = await run("Update campaign Summer Sale");

    expect(state.intent).toBe("update_campaign");

    // Still missing fields — tool must not execute
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    // Response must be structured JSON
    const response = parseResponse(state.finalResponse);
    expect(response.status).toBe("needs_input");
    expect(response.intent).toBe("update_campaign");

    // Message should guide the user to provide update fields
    expect(typeof response.message).toBe("string");
    expect((response.message as string).length).toBeGreaterThan(0);

    // Optional fields must be listed so the caller knows what can be collected
    expect(Array.isArray(response.optional_fields)).toBe(true);
    const optionalFields = response.optional_fields as string[];
    expect(optionalFields.length).toBeGreaterThan(0);
  });

  // ── Test 3: campaignId + field present → execute tool ─────────────────────────

  it("Test 3: 'Update campaign ID 123 subject to New Offer' → success + tool execution", async () => {
    const state = await run("Update campaign ID 123 subject to New Offer");

    expect(state.intent).toBe("update_campaign");

    // Tool must have been dispatched
    expect(mockExecuteFromState).toHaveBeenCalledOnce();

    // Response must be structured success JSON
    expect(state.finalResponse).toBeDefined();
    const response = parseResponse(state.finalResponse);

    expect(response.status).toBe("success");
    expect(response.intent).toBe("update_campaign");
    expect(typeof response.message).toBe("string");
    expect(response.data).toBeDefined();
  });

  it("Test 3 (with campaignId in state): proceeds to tool execution", async () => {
    // Include "campaign" so deterministic detection resolves update_campaign, not update_smtp
    const state = await run("Update campaign subject to Summer Deals", {
      activeCampaignId: "camp-abc" as AgentGraphStateType["activeCampaignId"],
    });

    expect(state.intent).toBe("update_campaign");
    expect(mockExecuteFromState).toHaveBeenCalledOnce();

    const response = parseResponse(state.finalResponse);
    expect(response.status).toBe("success");
  });

  // ── Tool-call safety ───────────────────────────────────────────────────────────

  it("never calls the MCP tool when parameters are missing", async () => {
    await run("Update an existing campaign");
    await run("Update campaign");
    await run("Modify the campaign");
    expect(mockExecuteFromState).not.toHaveBeenCalled();
  });

  // ── Response format consistency ────────────────────────────────────────────────

  it("always returns valid JSON for update_campaign regardless of param completeness", async () => {
    const inputs = [
      "Update an existing campaign",
      "Update campaign Summer Sale",
      "Update campaign test-123 subject to New Offer",
    ];

    for (const input of inputs) {
      // Reset mock for each call
      mockExecuteFromState.mockResolvedValue({
        toolResult: { data: { id: "test", status: "updated" }, isToolError: false, rawContent: [] },
      });

      const state = await run(input);
      expect(state.finalResponse).toBeDefined();

      // Must parse as valid JSON
      expect(() => JSON.parse(state.finalResponse!)).not.toThrow();

      const response = parseResponse(state.finalResponse);
      expect(["needs_input", "success", "error"]).toContain(response.status);
      expect(response.intent).toBe("update_campaign");
    }
  });
});
