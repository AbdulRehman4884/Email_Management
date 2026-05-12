import { describe, it, expect, vi } from "vitest";
import { WORKFLOW_PENDING_TTL_MS } from "../../lib/mcpErrorMapping.js";

const mockGet = vi.fn();

vi.mock("../../services/sessionMemory.service.js", () => ({
  sessionMemoryService: {
    get: (...args: unknown[]) => mockGet(...args),
  },
}));

import { loadMemoryNode } from "../nodes/loadMemory.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

describe("loadMemoryNode — workflow lock/stack cleanup", () => {
  function makeState(): AgentGraphStateType {
    return {
      messages: [],
      userMessage: "test",
      sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      userId: "user-1" as AgentGraphStateType["userId"],
      rawToken: undefined,
      intent: undefined,
      confidence: 1,
      agentDomain: undefined,
      llmExtractedArgs: undefined,
      toolName: undefined,
      toolArgs: undefined,
      toolResult: undefined,
      requiresApproval: false,
      pendingActionId: undefined,
      finalResponse: undefined,
      error: undefined,
      activeCampaignId: undefined,
      senderDefaults: undefined,
      pendingCampaignDraft: undefined,
      pendingCampaignStep: undefined,
      pendingCampaignAction: undefined,
      campaignSelectionList: undefined,
      pendingScheduledAt: undefined,
      plan: undefined,
      planIndex: 0,
      planResults: [],
      pendingAiCampaignStep: undefined,
      pendingAiCampaignData: undefined,
      pendingCsvFile: undefined,
      pendingCsvData: undefined,
      pendingEnrichmentStep: undefined,
      pendingEnrichmentData: undefined,
      pendingOutreachDraft: undefined,
      pendingEnrichmentAction: undefined,
      pendingWorkflowDeadlineIso: undefined,
      workflowExpiredNotice: undefined,
      sessionSchemaVersion: undefined,
      activeWorkflowLock: undefined,
      workflowStack: undefined,
      formattedResponse: undefined,
      pendingPhase3EnrichmentAction: undefined,
      pendingPhase3CompanyName: undefined,
      pendingPhase3Url: undefined,
      pendingPhase3WebsiteContent: undefined,
      pendingPhase3ToolQueue: undefined,
      pendingPhase3Scratch: undefined,
      pendingPhase3ContinueExecute: false,
    };
  }

  it("clears expired activeWorkflowLock and removes expired workflowStack items", async () => {
    const past = new Date(Date.now() - WORKFLOW_PENDING_TTL_MS - 60_000).toISOString();
    mockGet.mockResolvedValueOnce({
      sessionId: "sess-1",
      userId: "user-1",
      messages: [],
      messageCount: 0,
      recentToolCalls: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionSchemaVersion: 2,
      activeWorkflowLock: {
        workflowId: "wf-1",
        type: "enrichment",
        startedAtIso: past,
        expiresAtIso: new Date(Date.now() - 10_000).toISOString(),
        interruptible: true,
      },
      workflowStack: [
        { workflowId: "wf-old", type: "enrichment", snapshot: {}, createdAtIso: past },
      ],
    });

    const patch = await loadMemoryNode(makeState());
    expect(patch.activeWorkflowLock).toBeUndefined();
    expect(patch.workflowStack).toBeUndefined();
  });
});

