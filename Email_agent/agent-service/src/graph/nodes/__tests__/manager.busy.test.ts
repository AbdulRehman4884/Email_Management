import { describe, expect, it } from "vitest";
import { managerNode, routeToAgent } from "../manager.node.js";
import { isStandaloneCommand } from "../../../lib/busyWorkflow.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

function state(overrides: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userMessage: "",
    sessionId: "s1",
    userId: "u1",
    messages: [],
    confidence: 1,
    toolArgs: {},
    requiresApproval: false,
    planIndex: 0,
    planResults: [],
    pendingPhase3ContinueExecute: false,
    ...overrides,
  } as AgentGraphStateType;
}

describe("manager busy guard", () => {
  it("does not let a chip command become the AI wizard's answer", async () => {
    const s = state({ intent: "list_campaigns", userMessage: "Show all campaigns", pendingAiCampaignStep: "name" as never });

    const patch = await managerNode(s);
    const body = JSON.parse(patch.formattedResponse!);

    expect(body.status).toBe("busy");
    expect(body.message).toContain("AI campaign setup");
    expect(body.message).toContain("cancel");
    // Flow state is left untouched and the reply goes straight to the user.
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(routeToAgent({ ...s, ...patch })).toBe("formatResponse");
  });

  it.each([
    ["campaign selection", { pendingCampaignAction: "pause_campaign" }, "Check SMTP configuration"],
    ["contact enrichment review", { pendingEnrichmentStep: "confirm" }, "show inbox replies"],
    ["bulk campaign workflow", { bulkWorkflow: { jobId: 1, currentStep: "x" } }, "Campaign stats"],
  ])("blocks other commands during %s", async (label, flow, message) => {
    const patch = await managerNode(state({ intent: "general_help", userMessage: message, ...(flow as object) }));
    expect(JSON.parse(patch.formattedResponse!).message).toContain(label);
  });

  it("still accepts real wizard answers", async () => {
    for (const answer of ["Summer Sale 2024", "Exclusive 30% off this weekend", "yes", "cancel"]) {
      const patch = await managerNode(state({ intent: "create_ai_campaign", userMessage: answer, pendingAiCampaignStep: "name" as never }));
      expect(patch.formattedResponse).toBeUndefined();
      expect(patch.agentDomain).toBe("campaign");
    }
  });

  it("does nothing when no flow is in progress", async () => {
    const patch = await managerNode(state({ intent: "list_campaigns", userMessage: "Show all campaigns" }));
    expect(patch.formattedResponse).toBeUndefined();
  });
});

describe("isStandaloneCommand", () => {
  it("matches whole command messages only", () => {
    expect(isStandaloneCommand("Show all campaigns")).toBe(true);
    expect(isStandaloneCommand("  check SMTP configuration! ")).toBe(true);
    expect(isStandaloneCommand("Show all campaigns from last summer sale")).toBe(false);
    expect(isStandaloneCommand("Summer campaign")).toBe(false);
  });
});
