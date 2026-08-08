/**
 * src/graph/__tests__/finalResponse.node.test.ts
 *
 * Unit tests for finalResponse.node.ts covering the two weak-spots
 * identified in the validation phase:
 *
 *   1. Multi-step plan summaries must NOT embed raw JSON — each step's
 *      result is described via describeToolResult (human-readable labels).
 *
 *   2. OpenAI enhancement must preserve the structured `data` envelope —
 *      only the `message` field is rewritten.  For summarize_replies the
 *      prose summary is wrapped in a SuccessResult envelope.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted OpenAI mock controls ──────────────────────────────────────────────

const { mockEnhanceResponse, mockSummarizeReplies } = vi.hoisted(() => ({
  mockEnhanceResponse:  vi.fn<[string, string, string], Promise<string>>(),
  mockSummarizeReplies: vi.fn<[unknown], Promise<string>>(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () => ({
    enhanceResponse:  mockEnhanceResponse,
    summarizeReplies: mockSummarizeReplies,
  }),
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { finalResponseNode } from "../nodes/finalResponse.node.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { PlanStepResult } from "../../lib/planTypes.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(
  overrides: Partial<AgentGraphStateType> = {},
): AgentGraphStateType {
  return {
    messages:         [],
    userMessage:      "test message",
    sessionId:        "sess-test" as AgentGraphStateType["sessionId"],
    userId:           "user-test"  as AgentGraphStateType["userId"],
    rawToken:         undefined,
    intent:           undefined,
    confidence:       1.0,
    agentDomain:      undefined,
    llmExtractedArgs: undefined,
    toolName:         undefined,
    toolArgs:         undefined,
    toolResult:       undefined,
    requiresApproval: false,
    pendingActionId:  undefined,
    finalResponse:    undefined,
    error:            undefined,
    activeCampaignId: undefined,
    plan:             undefined,
    planIndex:        0,
    planResults:      [],
    ...overrides,
  };
}

function makePlanStep(
  overrides: Partial<PlanStepResult> & { toolName: string; data: unknown },
): PlanStepResult {
  return {
    stepIndex:   0,
    toolName:    overrides.toolName,
    toolArgs:    {},
    toolResult: {
      data:        overrides.data,
      isToolError: false,
      rawContent:  [],
    },
    executedAt:  "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Helper to parse the finalResponse string ──────────────────────────────────

function parseFR(patch: Partial<AgentGraphStateType>): Record<string, unknown> {
  if (!patch.finalResponse) throw new Error("finalResponse is undefined");
  return JSON.parse(patch.finalResponse) as Record<string, unknown>;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Multi-step plan summaries — no raw JSON ────────────────────────────────

describe("buildPlanResultsSummary — no raw JSON in plan step descriptions", () => {

  it("create_campaign step shows name and status (not raw object)", async () => {
    const state = makeState({
      intent:      "create_campaign",
      toolName:    "create_campaign",
      planResults: [makePlanStep({
        toolName: "create_campaign",
        data:     { id: "42", name: "Summer Sale", status: "draft" },
      })],
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    // Must contain human-readable name and status
    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toContain("draft");
    // Must NOT contain raw JSON keys
    expect(patch.finalResponse).not.toContain('"id"');
    expect(patch.finalResponse).not.toContain('"name"');
    expect(patch.finalResponse).not.toContain('"status"');
  });

  it("get_campaign_stats step shows sent count and open rate (not raw object)", async () => {
    const state = makeState({
      intent:      "get_campaign_stats",
      toolName:    "get_campaign_stats",
      planResults: [makePlanStep({
        stepIndex: 0,
        toolName:  "get_campaign_stats",
        data: {
          campaignId: "42",
          sent:       5000,
          opened:     2000,
          openRate:   0.4,
          clickRate:  0.1,
        },
      })],
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toContain("5,000");
    expect(patch.finalResponse).toContain("40%");
    // Raw JSON keys must be absent
    expect(patch.finalResponse).not.toContain('"openRate"');
    expect(patch.finalResponse).not.toContain('"campaignId"');
  });

  it("list_replies step shows reply count (not raw object)", async () => {
    const state = makeState({
      intent:      "list_replies",
      toolName:    "list_replies",
      planResults: [makePlanStep({
        toolName: "list_replies",
        data: { items: [{ id: "1" }, { id: "2" }], total: 85, hasNextPage: true },
      })],
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toContain("85");
    expect(patch.finalResponse).not.toContain('"fromEmail"');
    expect(patch.finalResponse).not.toContain('"hasNextPage"');
  });

  it("check_smtp step shows host and port (not raw object)", async () => {
    const state = makeState({
      intent:      "check_smtp",
      toolName:    "get_smtp_settings",
      planResults: [makePlanStep({
        toolName: "get_smtp_settings",
        data: { host: "smtp.sendgrid.net", port: 587, encryption: "tls", isVerified: true },
      })],
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toContain("smtp.sendgrid.net");
    expect(patch.finalResponse).toContain("587");
    expect(patch.finalResponse).not.toContain('"isVerified"');
    expect(patch.finalResponse).not.toContain('"encryption"');
  });

  it("multi-step plan (2 steps) shows both step labels without raw JSON", async () => {
    const state = makeState({
      // toolName must be set; buildResponse skips planResults when toolName is absent
      toolName: "get_campaign_stats",
      planResults: [
        makePlanStep({
          stepIndex: 0,
          toolName:  "create_campaign",
          data:      { name: "Q4 Launch", status: "draft" },
        }),
        {
          stepIndex:  1,
          toolName:   "get_campaign_stats",
          toolArgs:   {},
          toolResult: {
            data:        { sent: 1000, openRate: 0.3 },
            isToolError: false,
            rawContent:  [],
          },
          executedAt: "2026-01-01T00:01:00Z",
        },
      ],
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toContain("Step 1");
    expect(patch.finalResponse).toContain("Step 2");
    // Human-readable content from step 1
    expect(patch.finalResponse).toContain("Q4 Launch");
    // No raw JSON keys anywhere
    expect(patch.finalResponse).not.toContain('"name"');
    expect(patch.finalResponse).not.toContain('"openRate"');
  });

  it("step with tool error shows error prefix without raw JSON", async () => {
    const errStep: PlanStepResult = {
      stepIndex:  0,
      toolName:   "create_campaign",
      toolArgs:   {},
      toolResult: {
        data:        { code: "CONFLICT", message: "name already exists" },
        isToolError: true,
        rawContent:  [],
      },
      executedAt: "2026-01-01T00:00:00Z",
    };

    const state = makeState({ toolName: "create_campaign", planResults: [errStep] });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toContain("Error");
    // Raw JSON keys must not appear
    expect(patch.finalResponse).not.toContain('"code"');
    expect(patch.finalResponse).not.toContain('"message":');
  });

  it("step with string data passes through directly (no double-encoding)", async () => {
    const step = makePlanStep({
      toolName: "create_campaign",
      data:     "Campaign 'Autumn' created.",
    });

    const state = makeState({ toolName: "create_campaign", planResults: [step] });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("Autumn");
    // The string data appears literally — not JSON-encoded
    expect(patch.finalResponse).not.toContain('\\"Autumn\\"');
  });
});

// ── 2. OpenAI enhancement — structured envelope preserved ─────────────────────

describe("OpenAI enhancement — structured data preserved", () => {

  it("get_campaign_stats: enhanced message replaces message field but data is intact", async () => {
    mockEnhanceResponse.mockResolvedValue(
      "Great news! Your campaign reached 5,000 people with a 40% open rate.",
    );

    const statsData = { sent: 5000, openRate: 0.4, clickRate: 0.1, replied: 85 };

    const state = makeState({
      intent:      "get_campaign_stats",
      toolName:    "get_campaign_stats",
      userMessage: "Show me stats for campaign 42",
      toolResult:  { data: statsData, isToolError: false, rawContent: [] },
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    const parsed = parseFR(patch);

    // Structure must be preserved
    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("get_campaign_stats");

    // Message must be the OpenAI-enhanced version
    expect(parsed.message).toBe(
      "Great news! Your campaign reached 5,000 people with a 40% open rate.",
    );

    // Data field must be unchanged — structured card still renderable
    expect(parsed.data).toEqual(statsData);

    // enhanceResponse must have been called with just the message, not the full JSON
    expect(mockEnhanceResponse).toHaveBeenCalledOnce();
    const [, , originalMessage] = mockEnhanceResponse.mock.calls[0]!;
    // The message passed to OpenAI must be a plain string (the deterministic label),
    // not the full JSON envelope
    expect(originalMessage).not.toContain('"status"');
    expect(originalMessage).not.toContain('"data"');
  });

  it("list_replies: enhanced message does not clobber the data array", async () => {
    mockEnhanceResponse.mockResolvedValue(
      "You received 85 replies. Here are the most recent ones.",
    );

    const repliesData = {
      items:       [{ id: "1", fromName: "Alice" }],
      total:       85,
      hasNextPage: true,
    };

    const state = makeState({
      intent:      "list_replies",
      toolName:    "list_replies",
      userMessage: "Show inbox replies",
      toolResult:  { data: repliesData, isToolError: false, rawContent: [] },
    });

    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("list_replies");
    expect(parsed.message).toBe(
      "You received 85 replies. Here are the most recent ones.",
    );
    // Original data must survive — frontend needs it for RepliesCard
    expect(parsed.data).toEqual(repliesData);
  });

  it("OpenAI enhance failure falls back to deterministic JSON (data still present)", async () => {
    mockEnhanceResponse.mockRejectedValue(new Error("OpenAI timeout"));

    const statsData = { sent: 5000, openRate: 0.4 };

    const state = makeState({
      intent:      "get_campaign_stats",
      toolName:    "get_campaign_stats",
      userMessage: "Show stats",
      toolResult:  { data: statsData, isToolError: false, rawContent: [] },
    });

    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    // Still a structured success result
    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("get_campaign_stats");
    // Data must still be present despite OpenAI failure
    expect(parsed.data).toEqual(statsData);
  });

  it("summarize_replies: OpenAI prose is wrapped in a SuccessResult envelope", async () => {
    mockSummarizeReplies.mockResolvedValue(
      "Recipients were mostly positive. 60% expressed interest in buying.",
    );

    const summaryData = { totalReplies: 85, sampleSize: 20, topKeywords: ["great", "sale"] };

    const state = makeState({
      intent:      "summarize_replies",
      toolName:    "summarize_replies",
      userMessage: "Summarise replies",
      toolResult:  { data: summaryData, isToolError: false, rawContent: [] },
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();

    // Must be parseable JSON (not raw prose)
    expect(() => JSON.parse(patch.finalResponse!)).not.toThrow();

    const parsed = parseFR(patch);

    // Structured envelope
    expect(parsed.status).toBe("success");
    expect(parsed.intent).toBe("summarize_replies");

    // Prose appears as the message
    expect(parsed.message).toContain("mostly positive");

    // Original data preserved for any card that wants it
    expect(parsed.data).toEqual(summaryData);
  });

  it("summarize_replies: OpenAI failure falls back to deterministic response without crashing", async () => {
    mockSummarizeReplies.mockRejectedValue(new Error("OpenAI timeout"));

    const state = makeState({
      intent:      "summarize_replies",
      toolName:    "summarize_replies",
      userMessage: "Summarise replies",
      toolResult:  {
        data:        { totalReplies: 10, sampleSize: 5, topKeywords: [] },
        isToolError: false,
        rawContent:  [],
      },
    });

    const patch = await finalResponseNode(state);
    expect(patch.finalResponse).toBeDefined();
    // Falls back to deterministic — still a parseable JSON SuccessResult
    const parsed = parseFR(patch);
    expect(parsed.status).toBe("success");
  });

  it("error state is never enhanced by OpenAI", async () => {
    const state = makeState({
      intent: "create_campaign",
      error:  "Campaign name already exists.",
      toolName: "create_campaign",
    });

    const patch = await finalResponseNode(state);

    expect(mockEnhanceResponse).not.toHaveBeenCalled();
    expect(mockSummarizeReplies).not.toHaveBeenCalled();
    expect(patch.finalResponse).toContain("already exists");
  });

  it("general_help response is never enhanced by OpenAI", async () => {
    const state = makeState({ intent: "general_help" });
    const patch = await finalResponseNode(state);

    expect(mockEnhanceResponse).not.toHaveBeenCalled();
    expect(mockSummarizeReplies).not.toHaveBeenCalled();
    // Capabilities text is returned as-is
    expect(patch.finalResponse).toContain("Campaigns");
  });
});
