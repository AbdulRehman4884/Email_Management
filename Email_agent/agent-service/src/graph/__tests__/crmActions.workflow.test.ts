/**
 * src/graph/__tests__/crmActions.workflow.test.ts
 *
 * Full-graph tests for the CRM write actions (agent phase 2).
 * OpenAI off (rules only). prepare_crm_action (mcpClientService) and the write tool
 * (toolExecutionService) are mocked; the approval store is the real in-memory one.
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
import { intentDetectionService } from "../../services/intentDetection.service.js";
import { CRM_PLAN_MESSAGE, formatWriteResult } from "../../lib/crmFormatters.js";

const run = (userMessage: string) =>
  agentGraph.invoke({ userMessage, messages: [], rawToken: "tok", userId: "1" as never, sessionId: "s1" as never });

const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });
const message = (finalResponse: unknown) => {
  const text = String(finalResponse);
  try {
    return (JSON.parse(text) as { message: string }).message;
  } catch {
    return text;
  }
};

const ali = { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied", stageType: "normal", pipelineId: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
});

describe("CRM write intents — deterministic detection", () => {
  it.each([
    ["move Ali to Meeting Booked", "crm_move_lead"],
    ["Ali ko Interested mein daal do", "crm_move_lead"],
    ["mark ali@shop.com as won", "crm_move_lead"],
    ["tag Ali with VIP", "crm_tag_lead"],
    ["Ali ko VIP tag laga do", "crm_tag_lead"],
    ["remove tag VIP from Ali", "crm_tag_lead"],
    ["create tag Real Estate", "crm_create_tag"],
    ["naya tag VIP banao", "crm_create_tag"],
    ["snooze Ali for 3 days", "crm_snooze_lead"],
    ["mark Ali as done", "crm_mark_done"],
    ["change the label of Ali's reply to question", "crm_change_label"],
    ["move all hot leads to Engaged", "crm_bulk_update"],
    ["saare leads jo hot hain unko VIP tag laga do", "crm_bulk_update"],
  ])("%s → %s", (text, intent) => {
    expect(intentDetectionService.detect(text).intent).toBe(intent);
  });

  it("read-only phrases still go to the read intents", () => {
    expect(intentDetectionService.detect("show my tags").intent).toBe("crm_list_tags");
    expect(intentDetectionService.detect("show interested leads").intent).toBe("crm_list_leads");
  });
});

describe("CRM write actions — through the graph", () => {
  it("move to a normal stage runs at once and says what happened", async () => {
    mockDispatch.mockResolvedValueOnce(ok({ lead: ali, stage: { id: 3, name: "Engaged", type: "normal", stopFollowUps: false } }));
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: ok({ ok: true, moved: true, stage: { id: 3, name: "Engaged", type: "normal" }, lead: "Ali Khan" }),
    });

    const state = await run("move Ali to Engaged");

    expect(mockDispatch).toHaveBeenCalledWith("prepare_crm_action", { lead: "Ali", toStage: "Engaged" }, { userId: "1", rawToken: "tok" });
    expect(state.toolName).toBe("move_crm_lead");
    expect(state.toolArgs).toEqual({ contactId: 7, stageId: 3, leadName: "Ali Khan" });
    expect(state.requiresApproval).toBe(false);
    expect(message(state.finalResponse)).toBe("Moved **Ali Khan** to **Engaged**. The stage's rules and score update run now.");
  });

  it("move to Won waits for approval with a clear prompt, and runs nothing yet", async () => {
    mockDispatch.mockResolvedValueOnce(ok({ lead: ali, stage: { id: 9, name: "Won", type: "won", stopFollowUps: true } }));

    const state = await run("mark Ali as won");

    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeTruthy();
    expect(mockExecuteFromState).not.toHaveBeenCalled();
    const text = String(state.finalResponse);
    expect(text).toContain("Move **Ali Khan** (ali@shop.com) from **Replied** to **Won**?");
    expect(text).toContain("Press **Confirm**");
  });

  it("an unclear name lists the leads and changes nothing", async () => {
    mockDispatch.mockResolvedValueOnce(ok({
      leadQuery: "ali",
      leadMatches: [{ id: 7, email: "ali@shop.com", name: "Ali Khan" }, { id: 8, email: "ali@x.com", name: "Ali Raza" }],
    }));

    const state = await run("tag ali with VIP");

    expect(state.toolName).toBeUndefined();
    expect(mockExecuteFromState).not.toHaveBeenCalled();
    expect(message(state.finalResponse)).toContain("I found 2 leads matching **ali**");
  });

  it("a missing stage is asked for without calling the CRM", async () => {
    const state = await run("move Ali");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(message(state.finalResponse)).toContain("Which lead?");
  });

  it("bulk: approval with the lead count", async () => {
    mockDispatch.mockResolvedValueOnce(ok({
      targets: { total: 2, ids: [7, 8], sample: [{ name: "Ali Khan" }, { email: "b@x.com" }], truncated: false, appliedFilters: {} },
      stage: { id: 3, name: "Engaged", type: "normal", stopFollowUps: false },
    }));

    const state = await run("move all hot leads to Engaged");

    expect(state.intent).toBe("crm_bulk_update");
    expect(state.toolName).toBe("bulk_update_crm_leads");
    expect(state.toolArgs).toEqual({ contactIds: [7, 8], moveToStageId: 3 });
    expect(state.requiresApproval).toBe(true);
    expect(String(state.finalResponse)).toContain("This will change **2 leads** (hot): move them to **Engaged**.");
  });

  it("no CRM in the plan: prepare fails with the upgrade message", async () => {
    mockDispatch.mockResolvedValueOnce({
      data: { success: false, error: { code: "MAILFLOW_API_ERROR", details: { code: "PLAN_FEATURE_REQUIRED" } } },
      isToolError: false,
      rawContent: [],
    });
    const state = await run("tag Ali with VIP");
    expect(message(state.finalResponse)).toBe(CRM_PLAN_MESSAGE);
    expect(mockExecuteFromState).not.toHaveBeenCalled();
  });

  it("create tag needs no lookup", async () => {
    mockExecuteFromState.mockResolvedValueOnce({ toolResult: ok({ ok: true, tag: { id: 9, name: "Real Estate" } }) });
    const state = await run("create tag Real Estate");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(state.toolArgs).toEqual({ name: "Real Estate" });
    expect(message(state.finalResponse)).toContain("Created tag **Real Estate**");
  });
});

describe("formatWriteResult", () => {
  it("bulk counts and snooze time", () => {
    expect(formatWriteResult("bulk_update_crm_leads", { matched: 3, moved: 3, tagsAdded: 0, skipped: 0 })).toBe("Updated **3 leads**: moved **3**.");
    expect(formatWriteResult("snooze_crm_lead", { lead: "Ali", snoozedUntil: "2026-10-21T09:00:00" })).toBe(
      "Snoozed **Ali** until **2026-10-21 09:00**. No reminder for this lead until then.",
    );
    expect(formatWriteResult("move_crm_lead", { lead: "Ali", moved: false, stage: { name: "Won" } })).toContain("already in **Won**");
  });
});
