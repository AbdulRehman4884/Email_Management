import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { finalResponseNode } from "../nodes/finalResponse.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });

describe("multi-step plan summary with CRM steps", () => {
  it("shows each CRM step with its normal chat message", async () => {
    const state = {
      userMessage: "crm summary and who needs a reply",
      intent: "crm_summary",
      planResults: [
        {
          stepIndex: 0, toolName: "get_crm_summary", toolArgs: {}, executedAt: "",
          toolResult: ok({ pipeline: { id: 1, name: "Sales" }, kpis: { total: 3 }, stages: [], labels: {}, funnel: [] }),
        },
        {
          stepIndex: 1, toolName: "list_crm_needs_reply", toolArgs: {}, executedAt: "",
          toolResult: ok({ leads: [], counts: { waiting: 0, overdue: 0, snoozed: 0 } }),
        },
      ],
    } as unknown as AgentGraphStateType;

    const out = String((await finalResponseNode(state)).finalResponse);
    expect(out).toContain("Completed 2 steps:");
    expect(out).toContain("**Step 1 — get crm summary**\n**CRM overview — Sales**");
    expect(out).toContain("**Step 2 — list crm needs reply**\nNobody is waiting for your reply right now.");
  });
});
