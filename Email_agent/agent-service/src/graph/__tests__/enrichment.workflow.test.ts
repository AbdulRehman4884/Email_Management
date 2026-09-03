/**
 * src/graph/__tests__/enrichment.workflow.test.ts
 *
 * Regression tests for the enrichment UX bug fixes:
 *
 *   BUG 1: Raw JSON shown in chat when enrichment preview was set via state.error
 *   BUG 2: Enrichment responses routed through clarification ("needs_input") node
 *   BUG 3: "yes" after CSV parse classified as general_help (no enrichment context)
 *
 * Fixes verified:
 *   - formattedResponse field bypasses clarification → goes straight to finalResponse
 *   - EnrichmentAgent returns formattedResponse (not error) for all user-facing messages
 *   - detectIntent override maps keywords deterministically when pendingEnrichmentStep set
 *   - discard_enrichment intent cancels flow cleanly at any step
 *   - confirm_enrichment intent dispatches save_enriched_contacts with campaignId
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
import { routeFromValidation } from "../nodes/validation.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type GraphInput = Partial<AgentGraphStateType>;

async function run(userMessage: string, extra: GraphInput = {}) {
  return agentGraph.invoke({ userMessage, messages: [], ...extra });
}

const MOCK_CSV_DATA: AgentGraphStateType["pendingCsvData"] = {
  totalRows:   3,
  validRows:   3,
  invalidRows: 0,
  columns:     ["email", "name", "company"],
  preview:     [
    { email: "alice@techcorp.com", name: "Alice", company: "TechCorp" },
    { email: "bob@financebank.com", name: "Bob",   company: "FinanceBank" },
  ],
  rows: [
    { email: "alice@techcorp.com", name: "Alice", company: "TechCorp" },
    { email: "bob@financebank.com", name: "Bob",   company: "FinanceBank" },
    { email: "carol@healthco.com", name: "Carol",  company: "HealthCo" },
  ],
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockDetectPlan.mockResolvedValue(null);
  mockExecuteFromState.mockResolvedValue({
    toolResult: { data: { saved: 3, skipped: 0 }, isToolError: false, rawContent: [] },
  });
});

// ── TEST 1: Validation routing ────────────────────────────────────────────────

describe("routeFromValidation — formattedResponse bypass (BUG 2 fix)", () => {

  it("routes to formattedResponse when formattedResponse is set", () => {
    const state = {
      formattedResponse: JSON.stringify({ status: "success", intent: "enrich_contacts", message: "preview", data: {} }),
      toolName: undefined,
    } as unknown as AgentGraphStateType;
    expect(routeFromValidation(state)).toBe("formattedResponse");
  });

  it("routes to clarification when toolName absent and no formattedResponse", () => {
    const state = {
      formattedResponse: undefined,
      toolName: undefined,
    } as unknown as AgentGraphStateType;
    expect(routeFromValidation(state)).toBe("clarification");
  });

  it("routes to approval when toolName is set (regardless of formattedResponse)", () => {
    const state = {
      formattedResponse: undefined,
      toolName: "create_campaign",
    } as unknown as AgentGraphStateType;
    expect(routeFromValidation(state)).toBe("approval");
  });

  it("formattedResponse takes precedence over toolName being undefined", () => {
    // Even with no toolName, if formattedResponse is set we skip clarification
    const state = {
      formattedResponse: "some response",
      toolName: undefined,
      intent: "enrich_contacts",
    } as unknown as AgentGraphStateType;
    expect(routeFromValidation(state)).toBe("formattedResponse");
  });
});

// ── TEST 2: Enrichment preview bypasses clarification (BUG 2 fix) ─────────────

describe("enrichment workflow — preview bypasses clarification", () => {

  it("handleEnrich returns formattedResponse (not raw JSON in error)", async () => {
    const state = await run("enrich these contacts", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    // formattedResponse should be set (or finalResponse should contain the preview)
    expect(state.finalResponse).toBeDefined();

    // The finalResponse must be parseable JSON with status=success
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("enrich_contacts");
    expect(typeof parsed.message).toBe("string");

    // The message must be clean markdown, NOT a JSON string
    const message = parsed.message as string;
    expect(message).toContain("Enrichment complete");
    expect(message).not.toMatch(/^\s*\{/); // message must not itself be JSON
    expect(message).toContain("Hot leads");
    expect(message).toContain("yes");
    expect(message).toContain("discard");
  });

  it("enrichment preview must NOT contain status:needs_input (clarification hijack)", async () => {
    const state = await run("enrich", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    const finalResponse = state.finalResponse ?? "";
    expect(finalResponse).not.toContain('"needs_input"');
    expect(finalResponse).not.toContain("More information needed");
    expect(finalResponse).not.toContain('"required_fields"');
  });

  it("enrichment step advances to confirm after preview", async () => {
    const state = await run("enrich", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    // Step should advance to "confirm" so next turn can save
    expect(state.pendingEnrichmentStep).toBe("confirm");
    expect(state.activeWorkflowLock?.type).toBe("enrichment");
    expect(state.activeWorkflowLock?.interruptible).toBe(true);
  });
});

// ── TEST 3: detectIntent enrichment context override (BUG 3 fix) ──────────────

describe("detectIntent — enrichment context override", () => {

  it("maps 'yes' to confirm_enrichment when pendingEnrichmentStep=confirm", async () => {
    const state = await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: "42",
    });

    expect(state.intent).toBe("confirm_enrichment");
  });

  it("maps 'ok' to confirm_enrichment at confirm step", async () => {
    const state = await run("ok", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: "42",
    });

    expect(state.intent).toBe("confirm_enrichment");
  });

  it("maps 'discard' to discard_enrichment when pendingEnrichmentStep=confirm", async () => {
    const state = await run("discard", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    expect(state.intent).toBe("discard_enrichment");
  });

  it("maps 'no' to discard_enrichment at confirm step", async () => {
    const state = await run("no", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    expect(state.intent).toBe("discard_enrichment");
  });

  it("maps 'customize formal' to customize_outreach at confirm step", async () => {
    const state = await run("customize formal", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    expect(state.intent).toBe("customize_outreach");
  });

  it("maps 'yes' at enrich step to confirm_enrichment (triggers enrichment)", async () => {
    const state = await run("yes", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    // Intent should be confirm_enrichment (user said "yes"), but enrichment still
    // runs because pendingEnrichmentStep=enrich takes priority in the agent.
    expect(state.intent).toBe("confirm_enrichment");
    // Enrichment should have run and advanced to confirm step
    expect(state.pendingEnrichmentStep).toBe("confirm");
  });
});

// ── Mock campaign list helper ─────────────────────────────────────────────────

const MOCK_CAMPAIGN_LIST = [
  { id: "5", name: "Spring Sale", status: "draft" },
  { id: "8", name: "Summer Event", status: "draft" },
];

const MOCK_ENRICHMENT_DATA: NonNullable<AgentGraphStateType["pendingEnrichmentData"]> = {
  contacts:       MOCK_CSV_DATA!.rows,
  totalProcessed: 3,
  enrichedCount:  3,
  summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
};

// ── TEST 4: confirm_enrichment dispatches save tool (end-to-end) ──────────────

describe("confirm_enrichment — dispatches save_enriched_contacts", () => {

  it("dispatches save_enriched_contacts when user confirms with active campaignId", async () => {
    await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: "42",
    });

    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteFromState.mock.calls[0]![0] as AgentGraphStateType;
    expect(callArgs.toolName).toBe("save_enriched_contacts");
    expect((callArgs.toolArgs as Record<string, unknown>).campaignId).toBe("42");
    expect(Array.isArray((callArgs.toolArgs as Record<string, unknown>).contacts)).toBe(true);
  });

  it("fetches campaign list when confirming without activeCampaignId", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { data: MOCK_CAMPAIGN_LIST },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: undefined,
    });

    // Should dispatch get_all_campaigns (not save tool)
    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteFromState.mock.calls[0]![0] as AgentGraphStateType;
    expect(callArgs.toolName).toBe("get_all_campaigns");

    // pendingEnrichmentAction must be set so next turn routes here
    expect(state.pendingEnrichmentAction).toBe("save_enriched_contacts");
    expect(state.pendingEnrichmentStep).toBeUndefined();

    // Response should be a campaign selection prompt
    expect(state.finalResponse).toBeDefined();
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.message).toContain("campaign");
  });

  it("preserves pendingEnrichmentData while waiting for campaign selection", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { data: MOCK_CAMPAIGN_LIST },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: undefined,
    });

    // Enrichment data must survive the get_all_campaigns turn
    expect(state.pendingEnrichmentData).toBeDefined();
    expect(state.pendingEnrichmentData!.totalProcessed).toBe(3);
  });
});

// ── TEST 4b: campaign selection sub-flow ──────────────────────────────────────

describe("pendingEnrichmentAction — campaign selection sub-flow", () => {

  it("detectIntent maps replies to enrich_contacts while save_enriched_contacts is pending", async () => {
    const state = await run("yes", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });
    expect(state.intent).toBe("enrich_contacts");
  });

  it("resolves campaign by position number and dispatches save_enriched_contacts", async () => {
    await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteFromState.mock.calls[0]![0] as AgentGraphStateType;
    expect(callArgs.toolName).toBe("save_enriched_contacts");
    expect((callArgs.toolArgs as Record<string, unknown>).campaignId).toBe("5");
    expect(Array.isArray((callArgs.toolArgs as Record<string, unknown>).contacts)).toBe(true);
  });

  it("resolves campaign by name substring and dispatches save_enriched_contacts", async () => {
    await run("Summer", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteFromState.mock.calls[0]![0] as AgentGraphStateType;
    expect(callArgs.toolName).toBe("save_enriched_contacts");
    expect((callArgs.toolArgs as Record<string, unknown>).campaignId).toBe("8");
  });

  it("clears pendingEnrichmentAction after successful save", async () => {
    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    expect(state.pendingEnrichmentAction).toBeUndefined();
  });

  it("clears pendingEnrichmentData after successful save", async () => {
    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    // saveMemory clears enrichment state when toolName === save_enriched_contacts
    expect(state.pendingEnrichmentData).toBeUndefined();
  });

  it("save success message includes the campaign ID", async () => {
    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    // Campaign #5 is first in MOCK_CAMPAIGN_LIST
    expect(parsed.message).toContain("#5");
  });

  it("re-shows selection list when input cannot be resolved to a campaign", async () => {
    const state = await run("xyzzy gibberish", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    // Should NOT dispatch any tool
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    // pendingEnrichmentAction remains set so next turn still routes here
    expect(state.pendingEnrichmentAction).toBe("save_enriched_contacts");

    // Should re-show campaign selection, not clarification
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).not.toBe("collecting_input");
    expect(parsed.message).toContain("campaign");
  });

  it("affirmation alone asks for campaign pick without repeating the numbered list", async () => {
    const state = await run("yes", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    expect(mockExecuteFromState).not.toHaveBeenCalled();
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("needs_input");
    expect(String(parsed.message)).toMatch(/campaign number/i);
    expect(String(parsed.message)).toMatch(/campaign name/i);
    expect(String(parsed.message)).not.toContain("Spring Sale");
  });

  it("clears Phase 3 scratch state after save_enriched_contacts completes", async () => {
    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
      pendingPhase3Url:          "https://example.com",
      pendingPhase3ToolQueue:    ["extract_company_profile"],
      activeWorkflowLock: {
        workflowId: "w-enrich",
        type: "enrichment",
        startedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
        interruptible: true,
      },
    });

    expect(state.pendingPhase3Url).toBeUndefined();
    expect(state.pendingPhase3ToolQueue).toBeUndefined();
    expect(state.pendingEnrichmentAction).toBeUndefined();
    expect(state.activeWorkflowLock).toBeUndefined();
  });

  it("campaign selection response is not raw JSON in the message field", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { data: MOCK_CAMPAIGN_LIST },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      activeCampaignId: undefined,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    // message must be a plain markdown string, not double-serialized JSON
    expect(typeof parsed.message).toBe("string");
    expect(() => JSON.parse(parsed.message as string)).toThrow();
    expect(parsed.message as string).toMatch(/\*\*/); // has markdown
  });
});

describe("resume_workflow — restores previous workflow snapshot", () => {
  it("restores enrichment confirm state", async () => {
    const now = new Date().toISOString();
    const state = await run("resume", {
      workflowStack: [
        {
          workflowId: "wf-1",
          type: "enrichment",
          resumeIntent: "enrich_contacts",
          createdAtIso: now,
          snapshot: {
            pendingEnrichmentStep: "confirm",
            pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
            pendingOutreachDraft: { subject: "T", body: "b", variables: [], tone: "friendly" },
          },
        },
      ],
    });

    expect(state.pendingEnrichmentStep).toBe("confirm");
    expect(state.activeWorkflowLock?.type).toBe("enrichment");
    expect(state.workflowStack).toBeUndefined();
    expect(state.finalResponse ?? "").toMatch(/Back to your enrichment review/i);
  });

  it("restores enrichment campaign-selection state", async () => {
    const now = new Date().toISOString();
    const state = await run("continue previous", {
      workflowStack: [
        {
          workflowId: "wf-2",
          type: "enrichment",
          resumeIntent: "enrich_contacts",
          createdAtIso: now,
          snapshot: {
            pendingEnrichmentAction: "save_enriched_contacts",
            campaignSelectionList: MOCK_CAMPAIGN_LIST,
            pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
          },
        },
      ],
    });

    expect(state.pendingEnrichmentAction).toBe("save_enriched_contacts");
    expect(state.activeWorkflowLock?.type).toBe("enrichment");
    expect(state.finalResponse ?? "").toMatch(/Back to campaign selection/i);
  });
});

describe("workflow lock conflict handling", () => {
  it("blocks Phase 3 start when a non-interruptible campaign lock is active", async () => {
    const state = await run("Analyze company OpenAI using website https://openai.com", {
      activeWorkflowLock: {
        workflowId: "wf-camp",
        type: "campaign",
        startedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
        interruptible: false,
      },
    });

    expect(state.finalResponse ?? "").toMatch(/already working on/i);
    expect(state.finalResponse ?? "").toMatch(/discard/i);
  });
});

describe("discard clears lock and stack", () => {
  it("discard_enrichment clears enrichment lock and stack entries", async () => {
    const state = await run("discard", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "T", body: "b", variables: [], tone: "friendly" },
      activeWorkflowLock: {
        workflowId: "wf-enrich",
        type: "enrichment",
        startedAtIso: new Date().toISOString(),
        expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
        interruptible: true,
      },
      workflowStack: [
        {
          workflowId: "wf-old",
          type: "enrichment",
          resumeIntent: "enrich_contacts",
          createdAtIso: new Date().toISOString(),
          snapshot: { pendingEnrichmentStep: "confirm" },
        },
      ],
    });

    expect(state.activeWorkflowLock).toBeUndefined();
    expect(state.workflowStack).toBeUndefined();
  });
});

// ── Campaign selection vs confirm step (ordering + session) ──────────────────

describe("campaign selection priority and session handoff", () => {

  it("clears pendingEnrichmentStep when entering campaign list (get_all_campaigns path)", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { data: MOCK_CAMPAIGN_LIST },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("yes", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: undefined,
    });

    expect(state.pendingEnrichmentAction).toBe("save_enriched_contacts");
    expect(state.pendingEnrichmentStep).toBeUndefined();
  });

  it("selects campaign when both save action and stale confirm step are set (regression)", async () => {
    await run("2", {
      pendingEnrichmentAction: "save_enriched_contacts",
      pendingEnrichmentStep:   "confirm",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    expect(mockExecuteFromState).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteFromState.mock.calls[0]![0] as AgentGraphStateType;
    expect(callArgs.toolName).toBe("save_enriched_contacts");
    expect((callArgs.toolArgs as Record<string, unknown>).campaignId).toBe("8");
  });

  it("numeric pick uses enrich_contacts intent, not confirm_enrichment", async () => {
    const state = await run("2", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });
    expect(state.intent).toBe("enrich_contacts");
  });

  it("session restore: pick campaign on turn 2 without passing enrichment fields in invoke", async () => {
    mockExecuteFromState
      .mockResolvedValueOnce({
        toolResult: {
          data: { data: MOCK_CAMPAIGN_LIST },
          isToolError: false,
          rawContent: [],
        },
      })
      .mockResolvedValueOnce({
        toolResult: {
          data: { saved: 3, skipped: 0, rejected: [] },
          isToolError: false,
          rawContent: [],
        },
      });

    const userId = "user-enrich-session-handoff";
    const sessionId = "sess-enrich-session-handoff";

    await run("yes", {
      userId,
      sessionId,
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
      activeCampaignId: undefined,
    });

    const state2 = await run("2", { userId, sessionId });

    const saveCalls = mockExecuteFromState.mock.calls.filter(
      (c) => (c[0] as AgentGraphStateType).toolName === "save_enriched_contacts",
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    expect((saveCalls[0]![0] as AgentGraphStateType).toolArgs).toMatchObject({ campaignId: "8" });
    expect(state2.pendingEnrichmentAction).toBeUndefined();
  });

  it("Phase 3 phrase during CSV confirm abandons wizard — no Review loop", async () => {
    mockExecuteFromState.mockImplementation((s: AgentGraphStateType) => {
      const t = s.toolName;
      if (t === "fetch_website_content") {
        return Promise.resolve({
          toolResult: {
            isToolError: false,
            data: {
              url:           "https://acme.com",
              content:       "x".repeat(250),
              contentLength: 250,
              success:       true,
            },
            rawContent: [],
          },
        });
      }
      return Promise.resolve({
        toolResult: { isToolError: false, data: { companyName: "Acme" }, rawContent: [] },
      });
    });

    const state = await run("analyze company https://acme.com", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: MOCK_ENRICHMENT_DATA,
      pendingOutreachDraft: { subject: "T", body: "b", variables: [], tone: "friendly" },
    });

    const final = state.finalResponse ?? "";
    expect(final).not.toContain("### Review");
    expect(final).not.toContain("Reply **yes** or **save** to confirm");
    // Phase 3 lock is created at start and cleared on completion.
    expect(state.activeWorkflowLock).toBeUndefined();
    expect(Array.isArray(state.workflowStack)).toBe(true);
    expect(state.workflowStack?.[0]?.type).toBe("enrichment");
    expect(final).toMatch(/return to your previous enrichment workflow|say \*\*resume\*\*/i);
    const tools = mockExecuteFromState.mock.calls.map((c) => (c[0] as AgentGraphStateType).toolName);
    expect(tools).toContain("fetch_website_content");
  });
});

// ── TEST 5: discard_enrichment clears state ───────────────────────────────────

describe("discard_enrichment — clears enrichment state", () => {

  it("clears all enrichment state when user discards at confirm step", async () => {
    const state = await run("discard", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    // All enrichment state should be cleared
    expect(state.pendingEnrichmentStep).toBeUndefined();
    expect(state.pendingEnrichmentData).toBeUndefined();
    expect(state.pendingOutreachDraft).toBeUndefined();

    // No tool should have been called
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    // Cancellation message should be returned
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.intent).toBe("discard_enrichment");
    expect(parsed.message).toContain("cancelled");
  });

  it("clears enrichment state when user discards at enrich step", async () => {
    const state = await run("discard", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    expect(state.pendingEnrichmentStep).toBeUndefined();
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.intent).toBe("discard_enrichment");
    expect(typeof parsed.message).toBe("string");
  });
});

// ── TEST 6: customize_outreach regenerates template ───────────────────────────

describe("customize_outreach — regenerates outreach template", () => {

  it("re-shows preview with updated tone when user asks to customize", async () => {
    const state = await run("customize formal tone", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Original", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    // Should NOT dispatch any tool
    expect(mockExecuteFromState).not.toHaveBeenCalled();

    // Should still be at confirm step
    expect(state.pendingEnrichmentStep).toBe("confirm");

    // Final response should be the enrichment preview with updated draft
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("enrich_contacts");

    // New draft should have formal tone
    const data = parsed.data as Record<string, unknown>;
    const draft = data?.outreachDraft as Record<string, unknown>;
    expect(draft?.tone).toBe("formal");
  });
});

// ── TEST 7: enrichment_help bypasses clarification ────────────────────────────

describe("enrichment_help — bypasses clarification", () => {

  it("returns formattedResponse (not needs_input) for enrichment_help intent", async () => {
    // enrichment_help when no enrichment flow is active: this is routed to
    // "general" domain → formatResponse, not through enrichment agent.
    // When pendingEnrichmentStep IS set, the enrichmentActive flag routes to agent.
    const state = await run("how does enrichment work", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    // Should not return needs_input (that's the clarification node response)
    expect(state.finalResponse).not.toContain('"needs_input"');

    // Should return a valid success envelope or re-show preview
    expect(state.finalResponse).toBeDefined();
  });
});

// ── TEST 8: No double-serialization (BUG 1 fix) ───────────────────────────────

describe("enrichment preview — no double JSON serialization (BUG 1 fix)", () => {

  it("message field in envelope is plain markdown, not a nested JSON string", async () => {
    const state = await run("go ahead", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    const outer = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    const message = outer.message as string;

    // The message must be a plain string, NOT JSON
    expect(() => JSON.parse(message)).toThrow();
    // ...and it should contain markdown content
    expect(message).toMatch(/\*\*/); // has bold markdown
    expect(message).toContain("Enrichment complete");
  });

  it("finalResponse does not contain raw JSON blob as visible text", async () => {
    const state = await run("enrich now", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    // The finalResponse should be a single JSON envelope, not a string
    // that contains a JSON blob in its body/message
    const outer = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    const message = outer.message as string;

    // The message should NOT start with '{' (which would indicate raw JSON)
    expect(message.trim()).not.toMatch(/^\{/);
  });
});

// ── TEST 9b: finalResponse — save_enriched_contacts result formatting ─────────

describe("finalResponse — save_enriched_contacts result formatting", () => {

  it("saved > 0 shows success status with campaign ID", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { saved: 2, skipped: 0, rejected: [] },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("2");
    expect(parsed.message).toMatch(/#5|Spring Sale/);
  });

  it("saved = 0 with rejected array shows per-contact reasons", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: {
          saved:    0,
          skipped:  2,
          rejected: [
            { email: "alice@acme.com", reason: "duplicate" },
            { email: "bob@beta.io",    reason: "invalid_email" },
          ],
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    // Must list specific emails and reasons — not a generic message
    expect(parsed.message).toContain("alice@acme.com");
    expect(parsed.message).toContain("duplicate");
    expect(parsed.message).toContain("bob@beta.io");
    expect(parsed.message).toContain("invalid email");
  });

  it("saved = 0 with skips only — duplicate round-trip — friendly success copy", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { saved: 0, skipped: 3, rejected: [] },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message).toMatch(/3/);
    expect(parsed.message).toMatch(/already|No new|unchanged/i);
  });

  it("partial save: saved and skipped both > 0", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { saved: 1, skipped: 1, rejected: [] },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.message).toMatch(/Added \*\*1\*\*/);
    expect(parsed.message).toMatch(/skipped/i);
  });

  it("finalResponse message is never raw JSON", async () => {
    mockExecuteFromState.mockResolvedValueOnce({
      toolResult: {
        data: { saved: 1, skipped: 0, rejected: [] },
        isToolError: false,
        rawContent: [],
      },
    });

    const state = await run("1", {
      pendingEnrichmentAction: "save_enriched_contacts",
      campaignSelectionList:   MOCK_CAMPAIGN_LIST,
      pendingEnrichmentData:   MOCK_ENRICHMENT_DATA,
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    const message = parsed.message as string;
    expect(message.trim()).not.toMatch(/^\{/);
    expect(() => JSON.parse(message)).toThrow();
  });
});

// ── TEST 9: Clarification node is never called for enrichment responses ────────

describe("enrichment responses — clarification node never called", () => {

  it("enrichment preview does not produce needs_input status", async () => {
    const state = await run("proceed with enrichment", {
      pendingEnrichmentStep: "enrich",
      pendingCsvData:        MOCK_CSV_DATA,
    });

    // The response should be success, not needs_input
    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).not.toBe("needs_input");
    expect(parsed.status).not.toBe("collecting_input");
    expect(parsed.status).not.toBe("draft_ready");
  });

  it("cancellation message does not produce needs_input status", async () => {
    const state = await run("cancel enrichment", {
      pendingEnrichmentStep: "confirm",
      pendingEnrichmentData: {
        contacts:       MOCK_CSV_DATA!.rows,
        totalProcessed: 3,
        enrichedCount:  3,
        summary: { byIndustry: {}, hotLeads: 1, warmLeads: 1, coldLeads: 1, businessEmails: 3 },
      },
      pendingOutreachDraft: { subject: "Test", body: "Hi {{name}}", variables: ["name"], tone: "friendly" },
    });

    const parsed = JSON.parse(state.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).not.toBe("needs_input");
    expect(parsed.message).toContain("cancelled");
  });
});
