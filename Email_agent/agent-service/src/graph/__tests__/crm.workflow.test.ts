/**
 * src/graph/__tests__/crm.workflow.test.ts
 *
 * Full-graph tests for the read-only CRM intents (agent phase 1).
 * OpenAI is off (deterministic detection + message parsing); MCP calls are mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockDetectPlan, mockExecuteFromState } = vi.hoisted(() => ({
  mockDetectPlan:       vi.fn(),
  mockExecuteFromState: vi.fn(),
}));

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

import { agentGraph } from "../workflow/agent.workflow.js";
import { intentDetectionService } from "../../services/intentDetection.service.js";
import { CRM_PLAN_MESSAGE } from "../../lib/crmFormatters.js";
import { CRM_LEAD_QUESTION } from "../../agents/CrmAgent.js";

async function run(userMessage: string) {
  return agentGraph.invoke({ userMessage, messages: [] });
}

const ok = (data: unknown) => ({ toolResult: { data: { success: true, data }, isToolError: false, rawContent: [] } });
const message = (finalResponse: unknown) => {
  const text = String(finalResponse);
  try {
    return (JSON.parse(text) as { message: string }).message;
  } catch {
    return text;
  }
};

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockResolvedValue(ok({ contacts: [], total: 0, appliedFilters: {} }));
});

describe("CRM intents — deterministic detection", () => {
  it.each([
    ["CRM summary", "crm_summary"],
    ["crm ka haal batao", "crm_summary"],
    ["show interested leads", "crm_list_leads"],
    ["interested wale leads dikhao", "crm_list_leads"],
    ["which leads need reply", "crm_needs_reply"],
    ["kis ko jawab dena hai", "crm_needs_reply"],
    ["lead details of ali@shop.com", "crm_lead_details"],
    ["Ali Khan ki detail", "crm_lead_details"],
    ["show pipeline stages", "crm_list_pipelines"],
    ["show my tags", "crm_list_tags"],
  ])("%s → %s", (text, intent) => {
    expect(intentDetectionService.detect(text).intent).toBe(intent);
  });

  it("'show hot leads' still goes to the reply-intelligence hot leads", () => {
    expect(intentDetectionService.detect("show hot leads").intent).toBe("show_hot_leads");
  });
});

describe("CRM intents — through the graph", () => {
  it("lists interested leads with the label filter", async () => {
    mockExecuteFromState.mockResolvedValueOnce(ok({
      contacts: [{ id: 1, email: "ali@shop.com", name: "Ali", stageName: "Interested", score: 75, scoreTier: "hot", lastReplyLabel: "interested", tags: [] }],
      total: 1, appliedFilters: {},
    }));
    const state = await run("interested wale leads dikhao");
    expect(state.intent).toBe("crm_list_leads");
    expect(state.toolName).toBe("list_crm_contacts");
    expect(state.toolArgs).toEqual({ labels: ["interested"] });
    expect(state.requiresApproval).toBe(false);
    expect(message(state.finalResponse)).toContain("1. **Ali** — ali@shop.com");
  });

  it("needs reply runs list_crm_needs_reply", async () => {
    mockExecuteFromState.mockResolvedValueOnce(ok({ leads: [], counts: { waiting: 0, overdue: 0, snoozed: 0 } }));
    const state = await run("kis ko jawab dena hai");
    expect(state.toolName).toBe("list_crm_needs_reply");
    expect(message(state.finalResponse)).toBe("Nobody is waiting for your reply right now.");
  });

  it("lead details by email", async () => {
    mockExecuteFromState.mockResolvedValueOnce(ok({ detail: null, matches: [], query: "ali@shop.com" }));
    const state = await run("lead details of ali@shop.com");
    expect(state.toolName).toBe("get_crm_contact");
    expect(state.toolArgs).toEqual({ query: "ali@shop.com" });
    expect(message(state.finalResponse)).toContain("couldn't find a lead matching **ali@shop.com**");
  });

  it("lead details without a person asks for one and calls no tool", async () => {
    const state = await run("show lead details");
    expect(state.intent).toBe("crm_lead_details");
    expect(mockExecuteFromState).not.toHaveBeenCalled();
    expect(message(state.finalResponse)).toBe(CRM_LEAD_QUESTION);
  });

  it("'show hot leads' lists CRM leads that are Interested or hot, hottest first", async () => {
    mockExecuteFromState.mockResolvedValueOnce(ok({
      contacts: [{ id: 1, email: "ali@shop.com", name: "Ali", stageName: "Interested", score: 80, scoreTier: "hot", lastReplyLabel: "interested", tags: [] }],
      total: 1, appliedFilters: {},
    }));
    const state = await run("show hot leads");
    expect(state.intent).toBe("show_hot_leads");
    expect(state.toolName).toBe("list_crm_contacts");
    expect(state.toolArgs).toEqual({ hotOnly: true, sort: "hot" });
    expect(message(state.finalResponse)).toContain("**🔥 1 hot lead** (Interested or hot score, hottest first)");
    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
  });

  it("'show hot leads' without CRM in the plan falls back to reply intelligence", async () => {
    mockExecuteFromState
      .mockResolvedValueOnce({
        toolResult: {
          data: { success: false, error: { code: "MAILFLOW_API_ERROR", details: { code: "PLAN_FEATURE_REQUIRED" } } },
          isToolError: false,
          rawContent: [],
        },
      })
      .mockResolvedValueOnce(ok({ leads: [], total: 0 }));

    const state = await run("show hot leads");

    expect(mockExecuteFromState).toHaveBeenCalledTimes(2);
    expect(mockExecuteFromState.mock.calls[1]![0]).toMatchObject({ toolName: "show_hot_leads" });
    expect(state.toolName).toBe("show_hot_leads");
    expect(message(state.finalResponse)).not.toBe(CRM_PLAN_MESSAGE);
  });

  it("a plan without CRM gets the upgrade message", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { success: false, error: { code: "MAILFLOW_API_ERROR", httpStatus: 403, details: { code: "PLAN_FEATURE_REQUIRED" } } },
        isToolError: false,
        rawContent: [],
      },
    });
    const state = await run("CRM summary");
    expect(state.toolName).toBe("get_crm_summary");
    expect(message(state.finalResponse)).toBe(CRM_PLAN_MESSAGE);
  });
});
