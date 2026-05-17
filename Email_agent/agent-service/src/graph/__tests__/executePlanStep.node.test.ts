/**
 * src/graph/__tests__/executePlanStep.node.test.ts
 *
 * Unit tests for executePlanStepNode — specifically the arg injection fix that
 * ensures a create_campaign → start_campaign multi-step plan passes the new
 * campaignId into the pending action's toolArgs and into planContext.plan so
 * planExecution.service.resumePlan() can read it on confirmation.
 *
 * Mocked:
 *   toolExecution.service  — controls what each safe step returns
 *   pendingAction.service  — captures the payload passed to create()
 *
 * Not mocked:
 *   executePlanStepNode itself (the subject under test)
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mock functions ────────────────────────────────────────────────────

const { mockExecuteFromState, mockPendingActionCreate } = vi.hoisted(() => ({
  mockExecuteFromState:    vi.fn(),
  mockPendingActionCreate: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../services/toolExecution.service.js", () => ({
  toolExecutionService: { executeFromState: mockExecuteFromState },
}));

vi.mock("../../services/pendingAction.service.js", () => ({
  pendingActionService: { create: mockPendingActionCreate },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { executePlanStepNode } from "../nodes/executePlanStep.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlannedStep } from "../../lib/planTypes.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(
  plan: PlannedStep[],
  extra: Partial<AgentGraphStateType> = {},
): AgentGraphStateType {
  return {
    messages:         [],
    userMessage:      "create a campaign and start it",
    sessionId:        "sess-test" as AgentGraphStateType["sessionId"],
    userId:           "user-1"   as AgentGraphStateType["userId"],
    rawToken:         undefined,
    intent:           "create_campaign",
    confidence:       1,
    agentDomain:      "campaign",
    llmExtractedArgs: undefined,
    toolName:         undefined,
    toolArgs:         undefined,
    toolResult:       undefined,
    requiresApproval: false,
    pendingActionId:  undefined,
    finalResponse:    undefined,
    error:            undefined,
    activeCampaignId: undefined,
    senderDefaults:        undefined,
    pendingCampaignDraft:  undefined,
    pendingCampaignStep:   undefined,
    pendingCampaignAction: undefined,
    campaignSelectionList: undefined,
    pendingScheduledAt:    undefined,
    plan,
    planIndex:        0,
    planResults:      [],
    pendingAiCampaignStep:         undefined,
    pendingAiCampaignData:         undefined,
    pendingCsvFile:                undefined,
    pendingCsvData:                undefined,
    pendingEnrichmentStep:         undefined,
    pendingEnrichmentData:         undefined,
    pendingOutreachDraft:          undefined,
    pendingEnrichmentAction:       undefined,
    pendingPhase3EnrichmentAction: undefined,
    pendingPhase3CompanyName:      undefined,
    pendingPhase3Url:              undefined,
    pendingPhase3WebsiteContent:   undefined,
    pendingPhase3ToolQueue:        undefined,
    pendingPhase3Scratch:          undefined,
    pendingPhase3ContinueExecute:  false,
    pendingWorkflowDeadlineIso:    undefined,
    workflowExpiredNotice:         undefined,
    sessionSchemaVersion:          undefined,
    activeWorkflowLock:            undefined,
    workflowStack:                 undefined,
    formattedResponse:             undefined,
    pendingSmtpSelectionAction:    undefined,
    smtpProfileChoices:            undefined,
    extractedRecipients:           undefined,
    ...extra,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

// Canonical stub responses re-used across tests
const STUB_CREATE_CAMPAIGN_RESULT = {
  toolResult: {
    isToolError: false,
    rawContent:  [],
    data: { success: true, data: { id: 31, name: "Q3 Outreach", status: "draft" } },
  },
};

// get_recipient_count response that passes the pre-check (totalCount > 0)
const STUB_COUNT_RESULT = {
  toolResult: {
    isToolError: false,
    rawContent:  [],
    data: { success: true, data: { totalCount: 1, pendingCount: 1 } },
  },
};

beforeEach(() => {
  vi.resetAllMocks();

  // Default stub for any call not explicitly enqueued — returns a passing count
  // so get_recipient_count pre-checks don't throw on unset mocks.
  mockExecuteFromState.mockResolvedValue(STUB_COUNT_RESULT);

  // Default pending action stub
  mockPendingActionCreate.mockResolvedValue({ id: "pending-uuid-001" });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executePlanStepNode — create_campaign → start_campaign arg injection", () => {

  it("injects new campaignId into start_campaign toolArgs when create_campaign runs first", async () => {
    // create_campaign returns id=31 (nested under data.data); count check uses default mock
    mockExecuteFromState.mockResolvedValueOnce(STUB_CREATE_CAMPAIGN_RESULT);

    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "create_campaign",
        toolArgs:         { name: "Q3 Outreach", subject: "Hello", body: "..." },
        intent:           "create_campaign",
        description:      "Create the campaign",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "start_campaign",
        toolArgs:         {},         // planner had no campaignId at plan-build time
        intent:           "start_campaign",
        description:      "Start the campaign",
        requiresApproval: true,
      },
    ];

    const result = await executePlanStepNode(makeState(plan));

    // Node paused at risky step
    expect(result.requiresApproval).toBe(true);
    expect(result.pendingActionId).toBe("pending-uuid-001");

    // pendingActionService.create was called once
    expect(mockPendingActionCreate).toHaveBeenCalledTimes(1);
    const createPayload = mockPendingActionCreate.mock.calls[0][0];

    // toolArgs in the pending action must contain the runtime campaignId
    expect(createPayload.toolArgs).toEqual({ campaignId: "31" });

    // planContext.plan[1].toolArgs must also carry the resolved campaignId
    // so planExecution.service can read step.toolArgs on resume
    expect(createPayload.planContext.plan[1].toolArgs).toEqual({ campaignId: "31" });
    expect(createPayload.planContext.pausedStepIndex).toBe(1);

    // create_campaign result was captured before the pause
    expect(result.planResults).toHaveLength(1);
    expect(result.planResults![0].toolName).toBe("create_campaign");
  });

  it("uses string campaignId when create_campaign returns id as string", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { isToolError: false, rawContent: [], data: { success: true, data: { id: "42", name: "Sale" } } },
    });

    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "create_campaign",
        toolArgs:         { name: "Sale" },
        intent:           "create_campaign",
        description:      "Create",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "start_campaign",
        toolArgs:         {},
        intent:           "start_campaign",
        description:      "Start",
        requiresApproval: true,
      },
    ];

    await executePlanStepNode(makeState(plan));

    const createPayload = mockPendingActionCreate.mock.calls[0][0];
    expect(createPayload.toolArgs.campaignId).toBe("42");
  });

  it("does not overwrite an existing campaignId already present in start_campaign args", async () => {
    // Planner already resolved a valid campaignId — should not be replaced
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { isToolError: false, rawContent: [], data: { success: true, data: { id: 99 } } },
    });

    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "create_campaign",
        toolArgs:         { name: "X" },
        intent:           "create_campaign",
        description:      "Create",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "start_campaign",
        toolArgs:         { campaignId: "7" },  // already present
        intent:           "start_campaign",
        description:      "Start",
        requiresApproval: true,
      },
    ];

    await executePlanStepNode(makeState(plan));

    const createPayload = mockPendingActionCreate.mock.calls[0][0];
    // Must keep the existing "7", not overwrite with "99"
    expect(createPayload.toolArgs.campaignId).toBe("7");
  });

  it("uses session activeCampaignId when no create_campaign step runs first", async () => {
    // No safe steps before the risky one — activeCampaignId comes from session state
    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "start_campaign",
        toolArgs:         {},
        intent:           "start_campaign",
        description:      "Start",
        requiresApproval: true,
      },
    ];

    await executePlanStepNode(makeState(plan, { activeCampaignId: "55" }));

    const createPayload = mockPendingActionCreate.mock.calls[0][0];
    expect(createPayload.toolArgs.campaignId).toBe("55");
    expect(createPayload.planContext.plan[0].toolArgs.campaignId).toBe("55");
  });

  it("returns an error when start_campaign has no campaignId and none is available", async () => {
    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "start_campaign",
        toolArgs:         {},
        intent:           "start_campaign",
        description:      "Start",
        requiresApproval: true,
      },
    ];

    // No activeCampaignId in session, no create_campaign step ran
    const result = await executePlanStepNode(makeState(plan, { activeCampaignId: undefined }));

    expect(result.error).toMatch(/cannot queue start_campaign/i);
    expect(result.requiresApproval).toBeUndefined();
    expect(mockPendingActionCreate).not.toHaveBeenCalled();
  });

  it("does not inject campaignId for tools not in TOOLS_NEEDING_CAMPAIGN_ID", async () => {
    // summarize_replies does not require a campaignId — args should be untouched
    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "summarize_replies",
        toolArgs:         { limit: 10 },
        intent:           "summarize_replies",
        description:      "Summarize",
        requiresApproval: true,
      },
    ];

    await executePlanStepNode(
      makeState(plan, { activeCampaignId: "99", userId: "u1" as AgentGraphStateType["userId"] }),
    );

    const createPayload = mockPendingActionCreate.mock.calls[0][0];
    expect(createPayload.toolArgs).toEqual({ limit: 10 });
    expect(createPayload.toolArgs.campaignId).toBeUndefined();
  });

  it("planContext.completedResults captures safe steps before the pause", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: { isToolError: false, rawContent: [], data: { success: true, data: { id: 31 } } },
    });

    const plan: PlannedStep[] = [
      {
        stepIndex:        0,
        toolName:         "create_campaign",
        toolArgs:         { name: "Test" },
        intent:           "create_campaign",
        description:      "Create",
        requiresApproval: false,
      },
      {
        stepIndex:        1,
        toolName:         "start_campaign",
        toolArgs:         {},
        intent:           "start_campaign",
        description:      "Start",
        requiresApproval: true,
      },
    ];

    await executePlanStepNode(makeState(plan));

    const createPayload = mockPendingActionCreate.mock.calls[0][0];
    // completedResults should contain the create_campaign result
    expect(createPayload.planContext.completedResults).toHaveLength(1);
    expect(createPayload.planContext.completedResults[0].toolName).toBe("create_campaign");
  });
});
