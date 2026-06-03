import { describe, expect, it } from "vitest";
import { detectIntentNode } from "../detectIntent.node.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

function state(overrides: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userMessage: "",
    sessionId: "s1" as never,
    userId: "u1" as never,
    messages: [],
    confidence: 0,
    agentDomain: undefined,
    toolArgs: {},
    requiresApproval: false,
    planIndex: 0,
    planResults: [],
    pendingPhase3ContinueExecute: false,
    sessionSchemaVersion: 2,
    ...overrides,
  } as AgentGraphStateType;
}

describe("detectIntentNode bulk workflow reset and fresh row routing", () => {
  it("routes fresh manual rows to a new bulk job even when campaign 36 and old bulk workflow are active", async () => {
    const patch = await detectIntentNode(state({
      activeCampaignId: "36",
      bulkWorkflow: {
        jobId: 11,
        campaignDraftId: 36,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
      },
      userMessage: [
        "Create a fresh bulk job with these rows:",
        "1. Systems Limited / https://www.systemsltd.com / test1@example.com",
        "2. NETSOL Technologies / https://www.netsoltech.com / test2@example.com",
      ].join("\n"),
    }));

    expect(patch.intent).toBe("bulk_manual_rows_intake");
    expect(patch.bulkWorkflow).toBeUndefined();
    expect(patch.activeCampaignId).toBeUndefined();
    expect(patch.pendingCampaignAction).toBeUndefined();
    expect(patch.campaignSelectionList).toBeUndefined();
  });

  it("clears previous bulk workflow on explicit fresh job request without rows", async () => {
    const patch = await detectIntentNode(state({
      activeCampaignId: "36",
      bulkWorkflow: {
        jobId: 11,
        campaignDraftId: 36,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
      },
      userMessage: "reset bulk workflow and create a fresh bulk job",
    }));

    expect(patch.intent).toBe("start_bulk_template_workflow");
    expect(patch.bulkWorkflow).toBeUndefined();
    expect(patch.activeCampaignId).toBeUndefined();
  });
});
