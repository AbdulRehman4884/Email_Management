/**
 * src/graph/__tests__/crmContext.workflow.test.ts
 *
 * Multi-turn CRM conversations through the full graph (agent phase 3), with the real
 * in-memory session store: "which lead?" → "2", "show … " → "tag them …", "him".
 * OpenAI off; MCP calls mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockDetectPlan, mockExecuteFromState, mockDispatch } = vi.hoisted(() => ({
  mockDetectPlan:       vi.fn(),
  mockExecuteFromState: vi.fn(),
  mockDispatch:         vi.fn(),
}));

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));
vi.mock("../../services/planner.service.js", () => ({ plannerService: { detectPlan: mockDetectPlan } }));
vi.mock("../../services/toolExecution.service.js", () => ({ toolExecutionService: { executeFromState: mockExecuteFromState } }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));

import { agentGraph } from "../workflow/agent.workflow.js";
import { CRM_CANCELLED } from "../../agents/CrmAgent.js";

let session = 0;
function conversation() {
  const sessionId = `crm-ctx-${++session}` as never;
  return (userMessage: string) =>
    agentGraph.invoke({ userMessage, messages: [], rawToken: "tok", userId: "u1" as never, sessionId });
}

const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });
const message = (finalResponse: unknown) => {
  const text = String(finalResponse);
  try {
    return (JSON.parse(text) as { message: string }).message;
  } catch {
    return text;
  }
};

const matches = [
  { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied" },
  { id: 8, email: "ali.raza@x.com", name: "Ali Raza", stageName: "Contacted" },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
});

describe("which lead? → pick one", () => {
  it("a number continues the same action with that exact lead", async () => {
    const say = conversation();
    mockDispatch.mockResolvedValueOnce(ok({ leadQuery: "ali", leadMatches: matches, tags: [{ id: 5, name: "VIP" }] }));

    const first = await say("tag ali with VIP");
    expect(message(first.finalResponse)).toContain("Reply with the number (1–2)");
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    mockDispatch.mockResolvedValueOnce(ok({ lead: { ...matches[1], stageType: "normal", pipelineId: 1 }, tags: [{ id: 5, name: "VIP" }] }));
    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ ok: true, removed: false, lead: "Ali Raza", tag: "VIP" }) });

    const second = await say("2");
    expect(mockDispatch).toHaveBeenLastCalledWith("prepare_crm_action", { leadId: 8, tags: ["VIP"] }, expect.anything());
    expect(second.toolName).toBe("tag_crm_lead");
    expect(second.toolArgs).toMatchObject({ contactId: 8, tagId: 5 });
    expect(message(second.finalResponse)).toBe("Added tag **VIP** to **Ali Raza**.");
  });

  it("cancel ends the choice without any change", async () => {
    const say = conversation();
    mockDispatch.mockResolvedValueOnce(ok({ leadQuery: "ali", leadMatches: matches, stage: { id: 9, name: "Won", type: "won" } }));
    await say("move ali to Won");

    const second = await say("cancel");
    expect(message(second.finalResponse)).toBe(CRM_CANCELLED);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockExecuteFromState).not.toHaveBeenCalled();
  });

  it("an unrelated message drops the choice", async () => {
    const say = conversation();
    mockDispatch.mockResolvedValueOnce(ok({ leadQuery: "ali", leadMatches: matches, tags: [{ id: 5, name: "VIP" }] }));
    await say("tag ali with VIP");

    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ tags: [] }) });
    const second = await say("show my tags");
    expect(second.intent).toBe("crm_list_tags");

    const third = await say("2");
    expect(third.intent).not.toBe("crm_tag_lead");
  });

  it("details search with several matches → '1' opens that lead", async () => {
    const say = conversation();
    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ detail: null, matches, query: "ali" }) });
    await say("details of ali");

    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ detail: { contact: { ...matches[0], tags: [] } }, matches: [] }) });
    const second = await say("1");
    expect(second.intent).toBe("crm_lead_details");
    expect(second.toolArgs).toEqual({ contactId: 7 });
  });
});

describe("them / him", () => {
  it("'tag them' after a list acts on that list's filter, with approval", async () => {
    const say = conversation();
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: ok({ contacts: [{ id: 1, email: "a@x.com", name: "A", tags: [] }], total: 1, appliedFilters: {} }),
    });
    const list = await say("interested wale leads dikhao");
    expect(list.toolArgs).toEqual({ labels: ["interested"] });

    mockDispatch.mockResolvedValueOnce(ok({
      targets: { total: 1, ids: [1], sample: [{ name: "A" }], truncated: false, appliedFilters: {} },
      tags: [{ id: 5, name: "VIP" }],
    }));
    const second = await say("inko VIP tag laga do");
    expect(mockDispatch).toHaveBeenLastCalledWith("prepare_crm_action", { targets: { labels: ["interested"] }, tags: ["VIP"] }, expect.anything());
    expect(second.intent).toBe("crm_bulk_update");
    expect(second.requiresApproval).toBe(true);
  });

  it("'tag them' after 'show hot leads' acts on the hot leads", async () => {
    const say = conversation();
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: ok({ contacts: [{ id: 1, email: "a@x.com", name: "A", tags: [] }], total: 1, appliedFilters: {} }),
    });
    await say("show hot leads");

    mockDispatch.mockResolvedValueOnce(ok({
      targets: { total: 1, ids: [1], sample: [{ name: "A" }], truncated: false, appliedFilters: {} },
      tags: [{ id: 5, name: "VIP" }],
    }));
    await say("tag them with VIP");
    expect(mockDispatch).toHaveBeenLastCalledWith("prepare_crm_action", { targets: { hotOnly: true }, tags: ["VIP"] }, expect.anything());
  });

  it("'them' with no list before asks which leads", async () => {
    const say = conversation();
    const state = await say("tag them with VIP");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(message(state.finalResponse)).toContain("Which leads?");
  });

  it("'move him to Won' after a lead's details", async () => {
    const say = conversation();
    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ detail: { contact: { ...matches[0], tags: [] } }, matches: [] }) });
    await say("details of ali@shop.com");

    mockDispatch.mockResolvedValueOnce(ok({ lead: { ...matches[0], stageType: "normal", pipelineId: 1 }, stage: { id: 9, name: "Won", type: "won" } }));
    const second = await say("move him to Won");
    expect(mockDispatch).toHaveBeenLastCalledWith("prepare_crm_action", { leadId: 7, toStage: "Won" }, expect.anything());
    expect(second.requiresApproval).toBe(true);
  });

  it("'show X and tag them' in one message", async () => {
    const say = conversation();
    mockDispatch.mockResolvedValueOnce(ok({
      targets: { total: 2, ids: [1, 2], sample: [{ name: "A" }, { name: "B" }], truncated: false, appliedFilters: {} },
      tags: [{ id: 5, name: "VIP" }],
    }));
    const state = await say("hot leads dikhao aur unko VIP tag laga do");
    expect(mockDispatch).toHaveBeenCalledWith("prepare_crm_action", { targets: { scoreTiers: ["hot"] }, tags: ["VIP"] }, expect.anything());
    expect(String(state.finalResponse)).toContain("This will change **2 leads** (hot): add tag **VIP**.");
    expect(String(state.finalResponse)).toContain("For example: A, B");
  });
});
