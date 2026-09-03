/**
 * src/graph/__tests__/recipientExtraction.workflow.test.ts
 *
 * Tests that inline email addresses extracted from the user prompt are
 * saved as recipients before start_campaign executes in a multi-step plan.
 *
 * The bug (campaign #32): user's prompt contained an email address but
 * totalRecipients was 0 because no add_recipients step ran.
 *
 * What these tests verify:
 *  1. Email addresses are extracted from the user message in detectIntent
 *  2. create_campaign → add_recipients auto-injected → start_campaign pending
 *  3. Multiple emails extracted and all passed to add_recipients
 *  4. No email in prompt → no add_recipients step (existing CSV flow unaffected)
 *  5. add_recipients is called with the newly created campaign ID (not a stale one)
 *  6. No hardcoded email addresses in the implementation
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
import type { PlannedStep } from "../../lib/planTypes.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function run(userMessage: string, extra: Partial<AgentGraphStateType> = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

/** Build a create_campaign → start_campaign plan */
function makePlan(campaignId = ""): PlannedStep[] {
  return [
    {
      stepIndex:        0,
      toolName:         "create_campaign",
      toolArgs:         { name: "Test Campaign", subject: "Hello", body: "Body text" },
      intent:           "create_campaign",
      description:      "Create the campaign",
      requiresApproval: false,
    },
    {
      stepIndex:        1,
      toolName:         "start_campaign",
      toolArgs:         campaignId ? { campaignId } : {},
      intent:           "start_campaign",
      description:      "Start the campaign",
      requiresApproval: true,
    },
  ];
}

/** Mock response for a successful create_campaign call */
function createCampaignSuccess(id = "31") {
  return {
    toolResult: {
      isToolError: false,
      rawContent:  [],
      data: { success: true, data: { id, name: "Test Campaign", status: "draft" } },
    },
  };
}

/** Mock response for a successful add_recipients call */
function addRecipientsSuccess(saved = 1) {
  return {
    toolResult: {
      isToolError: false,
      rawContent:  [],
      data: { saved, skipped: 0, rejected: [] },
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockResolvedValue({
    toolResult: { data: { status: "ok" }, isToolError: false, rawContent: [] },
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recipient extraction — create_campaign → add_recipients → start_campaign", () => {

  it("prompt with one email: add_recipients is called with the new campaignId", async () => {
    mockDetectPlan.mockResolvedValueOnce(makePlan());

    // Step 0: create_campaign succeeds and returns id=31
    // Step add_recipients: auto-injected, succeeds
    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("31"))
      .mockResolvedValueOnce(addRecipientsSuccess(1));

    const state = await run(
      "Create a campaign called Test Campaign and send it to recipient@example.com",
      {
        userId:    "user-1" as AgentGraphStateType["userId"],
        sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      },
    );

    // Email extracted and stored in state
    expect(state.extractedRecipients).toContain("recipient@example.com");

    // Plan paused at risky start_campaign
    expect(state.requiresApproval).toBe(true);
    expect(state.pendingActionId).toBeDefined();

    // add_recipients was auto-executed before the pause
    const calls = mockExecuteFromState.mock.calls;
    const addRecipientsCalls = calls.filter(
      ([s]: [AgentGraphStateType]) => s.toolName === "add_recipients",
    );
    expect(addRecipientsCalls).toHaveLength(1);

    // The campaignId passed to add_recipients must be the new campaign's id
    const addState = addRecipientsCalls[0][0] as AgentGraphStateType;
    const addArgs = addState.toolArgs as { campaignId: string; recipients: Array<{ email: string }> };
    expect(addArgs.campaignId).toBe("31");
    expect(addArgs.recipients).toContainEqual({ email: "recipient@example.com" });
  });

  it("prompt with multiple emails: all are extracted and passed to add_recipients", async () => {
    mockDetectPlan.mockResolvedValueOnce(makePlan());

    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("42"))
      .mockResolvedValueOnce(addRecipientsSuccess(3));

    const state = await run(
      "Create a campaign and send to alice@example.com, bob@example.com and carol@example.com",
      {
        userId:    "user-1" as AgentGraphStateType["userId"],
        sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      },
    );

    expect(state.extractedRecipients).toHaveLength(3);
    expect(state.extractedRecipients).toContain("alice@example.com");
    expect(state.extractedRecipients).toContain("bob@example.com");
    expect(state.extractedRecipients).toContain("carol@example.com");

    const calls = mockExecuteFromState.mock.calls;
    const addCall = calls.find(
      ([s]: [AgentGraphStateType]) => s.toolName === "add_recipients",
    );
    expect(addCall).toBeDefined();
    const addArgs = addCall![0].toolArgs as { recipients: Array<{ email: string }> };
    expect(addArgs.recipients).toHaveLength(3);
  });

  it("prompt with no email: add_recipients is NOT called (CSV flow unaffected)", async () => {
    mockDetectPlan.mockResolvedValueOnce(makePlan());

    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("10"));

    const state = await run(
      "Create a campaign called Test and start it",
      {
        userId:    "user-1" as AgentGraphStateType["userId"],
        sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      },
    );

    expect(state.extractedRecipients).toBeUndefined();

    const addCalls = mockExecuteFromState.mock.calls.filter(
      ([s]: [AgentGraphStateType]) => s.toolName === "add_recipients",
    );
    expect(addCalls).toHaveLength(0);
  });

  it("add_recipients uses the newly created campaign ID, not session activeCampaignId", async () => {
    mockDetectPlan.mockResolvedValueOnce(makePlan());

    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("99"))
      .mockResolvedValueOnce(addRecipientsSuccess(1));

    // Session has a stale activeCampaignId=5 — must NOT be used
    await run(
      "Create a campaign and send to test@example.com",
      {
        userId:           "user-1" as AgentGraphStateType["userId"],
        sessionId:        "sess-1" as AgentGraphStateType["sessionId"],
        activeCampaignId: "5",
      },
    );

    const calls = mockExecuteFromState.mock.calls;
    const addCall = calls.find(
      ([s]: [AgentGraphStateType]) => s.toolName === "add_recipients",
    );
    const addArgs = addCall![0].toolArgs as { campaignId: string };
    expect(addArgs.campaignId).toBe("99");  // newly created, not session's "5"
  });

  it("add_recipients result appears in planResults before start_campaign pause", async () => {
    mockDetectPlan.mockResolvedValueOnce(makePlan());

    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("31"))
      .mockResolvedValueOnce(addRecipientsSuccess(2));

    const state = await run(
      "Create campaign and send to a@example.com and b@example.com",
      {
        userId:    "user-1" as AgentGraphStateType["userId"],
        sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      },
    );

    // planResults carries both create_campaign and add_recipients before the pause
    expect(state.planResults).toBeDefined();
    const toolNames = state.planResults!.map((r) => r.toolName);
    expect(toolNames).toContain("create_campaign");
    expect(toolNames).toContain("add_recipients");
  });

  it("does not hardcode saadhaider228@gmail.com or any specific email", async () => {
    // Verify no hardcoded email in the source by running the test with a random domain
    mockDetectPlan.mockResolvedValueOnce(makePlan());
    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("7"))
      .mockResolvedValueOnce(addRecipientsSuccess(1));

    const state = await run(
      "Create a campaign and send it to completely_unique_test_addr_xqz9@randomdomain.io",
      {
        userId:    "user-1" as AgentGraphStateType["userId"],
        sessionId: "sess-1" as AgentGraphStateType["sessionId"],
      },
    );

    // The extracted email must be exactly what was in the message — no substitution
    expect(state.extractedRecipients).toContain("completely_unique_test_addr_xqz9@randomdomain.io");

    const addCall = mockExecuteFromState.mock.calls.find(
      ([s]: [AgentGraphStateType]) => s.toolName === "add_recipients",
    );
    const addArgs = addCall![0].toolArgs as { recipients: Array<{ email: string }> };
    expect(addArgs.recipients[0].email).toBe("completely_unique_test_addr_xqz9@randomdomain.io");
  });
});

// ── Wizard multi-turn tests ───────────────────────────────────────────────────
//
// The campaign creation wizard is a multi-turn flow:
//   Turn 1 — user provides campaign details and an inline recipient email
//           → CampaignAgent enters wizard, state stores pendingCampaignDraft
//             and extractedRecipients
//   Turn 2 — user confirms ("yes")
//           → detectIntentNode must NOT clear extractedRecipients (wizard active)
//           → CampaignAgent dispatches create_campaign
//           → executeToolNode auto-injects add_recipients with the preserved email
//
// The original bug: detectIntentNode always returned extractedRecipients (even
// undefined), which triggered the replace reducer and cleared the email on turn 2.
// The fix: omit extractedRecipients from the return when no email is in the
// current message AND a wizard draft is pending.

describe("recipient extraction — wizard multi-turn (confirm path)", () => {

  it("extractedRecipients from turn 1 survives into turn 2 confirmation", async () => {
    // Turn 2 of the wizard: user has already provided all campaign fields.
    // State carries the draft + the email from turn 1.
    // IMPORTANT: use a session ID that no previous test has written to, so that
    // loadMemory returns {} (no snapshot) and does not overwrite the initial
    // pendingCampaignDraft with undefined (which would break wizardActive detection).
    mockExecuteFromState
      .mockResolvedValueOnce(createCampaignSuccess("55"))
      .mockResolvedValueOnce(addRecipientsSuccess(1));

    await run("yes", {
      userId:    "wizard-user-1" as AgentGraphStateType["userId"],
      sessionId: "wizard-sess-confirm" as AgentGraphStateType["sessionId"],
      // Wizard state from turn 1
      pendingCampaignDraft: {
        name:    "Wizard Campaign",
        subject: "Wizard Subject",
        body:    "Wizard Body",
      } as AgentGraphStateType["pendingCampaignDraft"],
      pendingCampaignStep: "confirm" as AgentGraphStateType["pendingCampaignStep"],
      // Email extracted on turn 1 — must survive into turn 2
      extractedRecipients: ["wizard@example.com"],
    });

    // add_recipients must have been called with the campaign created on this turn
    const calls = mockExecuteFromState.mock.calls;
    const addCall = calls.find(
      (callArgs: any[]) => (callArgs[0] as AgentGraphStateType).toolName === "add_recipients",
    );
    expect(addCall).toBeDefined();

    const addArgs = (addCall![0] as AgentGraphStateType).toolArgs as { campaignId: string; recipients: Array<{ email: string }> };
    expect(addArgs.campaignId).toBe("55");
    expect(addArgs.recipients).toContainEqual({ email: "wizard@example.com" });
  });

  it("extractedRecipients does not bleed across unrelated turns (no wizard active)", async () => {
    // With no pendingCampaignDraft, "yes" on its own should NOT preserve
    // a stale extractedRecipients value from a previous session.
    mockExecuteFromState.mockResolvedValue({
      toolResult: { data: { status: "ok" }, isToolError: false, rawContent: [] },
    });

    const state = await run("yes", {
      userId:             "user-1" as AgentGraphStateType["userId"],
      sessionId:          "sess-1" as AgentGraphStateType["sessionId"],
      extractedRecipients: ["stale@example.com"],
      // No pendingCampaignDraft — wizard is NOT active
    });

    // State.extractedRecipients must be cleared (no email in current message)
    expect(state.extractedRecipients).toBeUndefined();
  });
});
