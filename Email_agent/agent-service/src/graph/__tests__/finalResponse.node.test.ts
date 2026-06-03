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

const { mockEnhanceResponse, mockSummarizeReplies, mockSummarizeWebsiteContent } = vi.hoisted(() => ({
  mockEnhanceResponse:          vi.fn<[string, string, string], Promise<string>>(),
  mockSummarizeReplies:         vi.fn<[unknown], Promise<string>>(),
  mockSummarizeWebsiteContent:  vi.fn<[string | undefined, string, string], Promise<string>>(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () => ({
    enhanceResponse:         mockEnhanceResponse,
    summarizeReplies:        mockSummarizeReplies,
    summarizeWebsiteContent: mockSummarizeWebsiteContent,
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
    activeCampaignId:      undefined,
    senderDefaults:        undefined,
    pendingCampaignDraft:  undefined,
    pendingCampaignStep:   undefined,
    pendingCampaignAction: undefined,
    campaignSelectionList: undefined,
    pendingScheduledAt:    undefined,
    plan:                    undefined,
    planIndex:               0,
    planResults:             [],
    pendingAiCampaignStep:   undefined,
    pendingAiCampaignData:   undefined,
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

describe("sequence progress responses", () => {
  it("formats show_sequence_progress results", async () => {
    const state = makeState({
      intent: "show_sequence_progress",
      toolName: "get_sequence_progress",
      toolResult: {
        data: {
          success: true,
          data: {
            activeRecipients: 5,
            pendingFollowUps: 4,
            dueFollowUps: 1,
            completedRecipients: 2,
            repliedRecipients: 1,
            bouncedRecipients: 0,
            unsubscribedRecipients: 0,
            touchPerformance: [{ touchNumber: 1, planned: 8, sent: 8, replied: 1, bounced: 0, unsubscribed: 0 }],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });
    const patch = await finalResponseNode(state);
    expect(patch.finalResponse).toContain("Recipient Progress");
    expect(patch.finalResponse).toContain("Pending follow-ups");
    expect(patch.finalResponse).toContain("Touch 1");
  });

  it("formats recipient touch history", async () => {
    const state = makeState({
      intent: "show_recipient_touch_history",
      toolName: "get_recipient_touch_history",
      toolResult: {
        data: {
          success: true,
          data: {
            recipientEmail: "sam@example.com",
            touches: [
              { touchNumber: 1, executionStatus: "sent", sentAt: "2026-05-11T10:00:00.000Z", personalizedSubject: "Quick question" },
              { touchNumber: 2, executionStatus: "pending", personalizedSubject: "Following up" },
            ],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });
    const patch = await finalResponseNode(state);
    expect(patch.finalResponse).toContain("sam@example.com");
    expect(patch.finalResponse).toContain("Touch 1");
    expect(patch.finalResponse).toContain("Following up");
  });
});

describe("autonomous SDR responses", () => {
  it("formats campaign autonomous summaries without raw JSON", async () => {
    const state = makeState({
      intent: "show_autonomous_recommendations",
      toolName: "get_campaign_autonomous_summary",
      toolResult: {
        data: {
          success: true,
          data: {
            urgentLeads: 2,
            meetingReadyLeads: 1,
            humanReviewNeeded: 3,
            safetyBlockedLeads: 0,
            recommendedCampaignAction: "Review meeting-ready leads first.",
            topPriorities: [
              { recipientId: 7, leadEmail: "sara@example.com", recommendedAction: "escalate_to_human", priority: { priorityLevel: "meeting_ready" } },
            ],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const parsed = parseFR(await finalResponseNode(state));
    const message = String(parsed.message);

    expect(message).toContain("Autonomous SDR Summary");
    expect(message).toContain("Urgent leads: 2");
    expect(message).toContain("sara@example.com");
    expect(message).not.toContain("{");
  });

  it("formats safety-blocked lead recommendation clearly", async () => {
    const state = makeState({
      intent: "show_next_best_action",
      toolName: "get_autonomous_recommendation",
      toolResult: {
        data: {
          success: true,
          data: {
            recipientId: 7,
            safety: { allowed: false, status: "blocked", reason: "Autonomy blocked for spam_warning." },
            priority: { priorityLevel: "low" },
            recommendedAction: "stop_sequence",
            humanEscalation: { escalate: true },
            reasons: [],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const parsed = parseFR(await finalResponseNode(state));

    expect(String(parsed.message)).toBe("Automation is blocked for this lead because Autonomy blocked for spam_warning.");
  });

  it("formats sequence adaptation previews without raw JSON", async () => {
    const state = makeState({
      intent: "preview_sequence_adaptation",
      toolName: "preview_sequence_adaptation",
      toolResult: {
        data: {
          success: true,
          data: {
            recommendedAction: "switch_to_value_cta",
            safety: { allowed: true, status: "allowed" },
            adaptationPreview: {
              changedTouchNumbers: [2],
              requiresHumanReview: false,
              adaptationSummary: "Adapted future touch 2 using switch_to_value_cta.",
            },
            nextBestAction: "Review the adapted future-touch preview before applying any sequence changes.",
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const parsed = parseFR(await finalResponseNode(state));
    const message = String(parsed.message);

    expect(message).toContain("Sequence adaptation preview");
    expect(message).toContain("Changed future touches: 2");
    expect(message).not.toContain("{");
  });
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
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(mockEnhanceResponse).not.toHaveBeenCalled();
    expect(mockSummarizeReplies).not.toHaveBeenCalled();
    // Capabilities card is returned as-is for broad help questions
    expect(patch.finalResponse).toContain("Campaigns");
  });
});

// ── 3. Out-of-domain refusal ──────────────────────────────────────────────────

describe("out_of_domain — strict domain refusal", () => {
  const OUT_OF_DOMAIN_CASES = [
    { label: "geography",  userMessage: "What is the capital of Pakistan?" },
    { label: "joke",       userMessage: "Tell me a joke" },
    { label: "weather",    userMessage: "What is the weather today?" },
    { label: "math",       userMessage: "Solve 42 * 17" },
    { label: "generic AI", userMessage: "Who are you?" },
  ];

  for (const { label, userMessage } of OUT_OF_DOMAIN_CASES) {
    it(`returns polite refusal for ${label} question`, async () => {
      const state = makeState({ intent: "out_of_domain", userMessage });
      const patch = await finalResponseNode(state);

      expect(patch.finalResponse).toBeDefined();
      // Refusal message must mention MailFlow/campaigns/email so the user
      // understands what the agent is for.
      expect(patch.finalResponse).toMatch(/MailFlow|campaign|email/i);
      // Must not be empty or generic acknowledgement
      expect(patch.finalResponse!.length).toBeGreaterThan(20);
      // Raw JSON should NOT be returned — it's a plain prose refusal
      expect(() => JSON.parse(patch.finalResponse!)).toThrow();
    });
  }

  it("out_of_domain is never enhanced by OpenAI", async () => {
    const state = makeState({
      intent:      "out_of_domain",
      userMessage: "What is the capital of France?",
      toolResult:  { data: {}, isToolError: false, rawContent: [] },
    });

    await finalResponseNode(state);

    expect(mockEnhanceResponse).not.toHaveBeenCalled();
    expect(mockSummarizeReplies).not.toHaveBeenCalled();
  });

  it("out_of_domain takes priority over toolResult", async () => {
    // Even if a toolResult exists, out_of_domain should return the refusal,
    // not a success message. (Should not happen in practice, but defensive.)
    const state = makeState({
      intent:     "out_of_domain",
      toolName:   "create_campaign",
      toolResult: { data: { id: "1", name: "X" }, isToolError: false, rawContent: [] },
    });

    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/MailFlow|campaign|email/i);
    expect(patch.finalResponse).not.toContain('"status"');
  });
});

describe("workflowExpiredNotice — loadMemory recovery copy", () => {
  it("surfaces expiry notice ahead of formattedResponse", async () => {
    const notice =
      "Your previous MailFlow assistant step expired after inactivity. Upload your CSV again or run your request once more to continue.";
    const patch = await finalResponseNode(
      makeState({
        workflowExpiredNotice: notice,
        formattedResponse:     '{"status":"success","intent":"enrich_contacts","message":"would be ignored"}',
        intent:                "enrich_contacts",
      }),
    );
    expect(patch.finalResponse).toBe(notice);
  });
});

// ── 4. humanizeToolError — specific error patterns ────────────────────────────

describe("humanizeToolError — maps specific errors to friendly messages", () => {
  function makeErrorState(intent: string, errorData: unknown) {
    return makeState({
      intent:   intent as AgentGraphStateType["intent"],
      toolName: "start_campaign",
      toolResult: { data: errorData, isToolError: true, rawContent: [] },
    });
  }

  it("campaignId required → asks user to specify campaign", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "campaignId is required"),
    );
    expect(patch.finalResponse).toBeDefined();
    expect(patch.finalResponse).toMatch(/which campaign|campaign name|list my campaigns/i);
    expect(patch.finalResponse).not.toContain("campaignId is required");
  });

  it("campaign not found (string message) → clear not-found message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "Campaign not found"),
    );
    expect(patch.finalResponse).toMatch(/not found/i);
    expect(patch.finalResponse).not.toContain('"isToolError"');
  });

  it("campaign not found (404 string) → clear not-found message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "404: resource does not exist"),
    );
    expect(patch.finalResponse).toMatch(/not found/i);
  });

  it("invalid status / already running → status-conflict message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "Campaign is already running"),
    );
    expect(patch.finalResponse).toMatch(/already|current state|status/i);
    expect(patch.finalResponse).not.toContain("already running");
  });

  it("invalid status (object payload) → status-conflict message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", { message: "invalid status transition", code: "INVALID_STATUS" }),
    );
    expect(patch.finalResponse).toMatch(/cannot be started|current state|status/i);
  });

  it("no recipients → prompts user to add recipients", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "No recipients found in campaign"),
    );
    expect(patch.finalResponse).toMatch(/recipient|list/i);
    expect(patch.finalResponse).not.toContain("No recipients found");
  });

  it("SMTP error → points user to Settings", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "smtp connection refused"),
    );
    expect(patch.finalResponse).toMatch(/smtp|settings/i);
  });

  it("rate limit → upgrade prompt", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "sending quota exceeded"),
    );
    expect(patch.finalResponse).toMatch(/limit|quota|plan/i);
  });

  it("401 unauthorized → permissions message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "401 unauthorized"),
    );
    expect(patch.finalResponse).toMatch(/not authorized|permission/i);
  });

  it("timeout error → retry message", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", "request timeout"),
    );
    expect(patch.finalResponse).toMatch(/timed? out|connection/i);
  });

  it("transport failure does not leak host/port or ECONNREFUSED", async () => {
    const patch = await finalResponseNode(
      makeErrorState(
        "start_campaign",
        "connect ECONNREFUSED 127.0.0.1:4000",
      ),
    );
    expect(patch.finalResponse).not.toMatch(/127\.0\.0\.1|:4000|ECONNREFUSED/i);
    expect(patch.finalResponse).toMatch(/MailFlow|unavailable|connection/i);
  });

  it("JSON error body with 'message' field → uses that message", async () => {
    const payload = { message: "Something specific went wrong", code: "ERR_SPECIFIC" };
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", JSON.stringify(payload)),
    );
    expect(patch.finalResponse).toContain("Something specific went wrong");
  });

  it("never returns raw JSON with isToolError key", async () => {
    const patch = await finalResponseNode(
      makeErrorState("start_campaign", { campaignId: "", error: "Validation failed" }),
    );
    expect(patch.finalResponse).not.toContain('"isToolError"');
    expect(patch.finalResponse).not.toContain('"rawContent"');
  });
});

// ── 5. formatCampaignList / get_all_campaigns success path ───────────────────

describe("get_all_campaigns success — formatCampaignList", () => {
  const CAMPAIGNS = [
    { id: "camp-1", name: "Summer Sale", status: "draft" },
    { id: "camp-2", name: "Eid Offer",   status: "draft" },
    { id: "camp-3", name: "Black Friday", status: "paused" },
  ];

  it("shows a numbered list with campaign names and statuses", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("1.");
    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toContain("Eid Offer");
    expect(patch.finalResponse).toContain("Black Friday");
  });

  it("uses 'start' verb when pendingCampaignAction is start_campaign", async () => {
    const state = makeState({
      intent:                "start_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/\bstart\b/i);
  });

  it("uses 'pause' verb when pendingCampaignAction is pause_campaign", async () => {
    const state = makeState({
      intent:                "pause_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "pause_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/\bpause\b/i);
  });

  it("uses 'resume' verb when pendingCampaignAction is resume_campaign", async () => {
    const state = makeState({
      intent:                "resume_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "resume_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/\bresume\b/i);
  });

  it("empty campaign list (list_campaigns) → exact 'create a campaign first' message", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBe(
      "No campaigns found. Please create a campaign first.",
    );
  });

  it("response instructs user to reply with number or name", async () => {
    const state = makeState({
      intent:                "start_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/number|campaign name/i);
  });

  it("never returns JSON for the campaign list — always plain text", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(() => JSON.parse(patch.finalResponse!)).toThrow();
  });

  // ── MCP envelope unwrapping ────────────────────────────────────────────────

  it("unwraps MCP envelope { success, data: Campaign[] } and shows campaigns", async () => {
    const envelope = { success: true, data: CAMPAIGNS };
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: envelope, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toContain("Eid Offer");
    expect(patch.finalResponse).toContain("1.");
  });

  it("MCP envelope with empty data array → no campaigns message", async () => {
    const envelope = { success: true, data: [] };
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: envelope, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
  });
});

// ── 6. Zero-campaigns state for send campaign flow ────────────────────────────

describe("get_all_campaigns — zero-campaigns state for send/pause/resume flow", () => {
  it("send flow with empty campaigns → exact 'before sending' message", async () => {
    const state = makeState({
      intent:                "start_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBe(
      "No campaigns found. Please create a campaign first before sending.",
    );
  });

  it("send flow with empty campaigns → not a generic error message", async () => {
    const state = makeState({
      intent:                "start_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toMatch(/could not be completed|request failed|error/i);
  });

  it("send flow with MCP envelope returning empty array → no campaigns message", async () => {
    const envelope = { success: true, data: [] };
    const state = makeState({
      intent:                "list_campaigns",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: envelope, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).toMatch(/create a campaign/i);
    expect(patch.finalResponse).not.toMatch(/could not be completed|error/i);
  });

  it("send flow with isToolError=true → no campaigns message (not generic error)", async () => {
    const state = makeState({
      intent:                "list_campaigns",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: {
        data: { success: false, error: { code: "MAILFLOW_NOT_FOUND", message: "not found" } },
        isToolError: true,
        rawContent: [],
      },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).not.toMatch(/could not be completed|generic/i);
  });

  it("pause flow with empty campaigns → no campaigns message with create hint", async () => {
    const state = makeState({
      intent:                "list_campaigns",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "pause_campaign",
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).toMatch(/create a campaign/i);
  });

  it("send flow with campaigns present → shows campaign selection list, not no-campaigns", async () => {
    const CAMPAIGNS = [
      { id: "c1", name: "Summer Sale", status: "draft" },
      { id: "c2", name: "Eid Offer",   status: "draft" },
    ];
    const state = makeState({
      intent:                "list_campaigns",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toMatch(/no campaigns/i);
    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toMatch(/\bstart\b/i);
  });

  it("send flow with MCP envelope containing campaigns → selection list shown", async () => {
    const CAMPAIGNS = [{ id: "c1", name: "Summer Sale", status: "draft" }];
    const envelope = { success: true, data: CAMPAIGNS };
    const state = makeState({
      intent:                "list_campaigns",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      toolResult: { data: envelope, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toMatch(/\bstart\b/i);
    expect(patch.finalResponse).not.toMatch(/no campaigns/i);
  });

  it("list flow with isToolError=true and no pendingAction → humanized error (not no-campaigns)", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: {
        data: { code: "MAILFLOW_UNAVAILABLE", message: "Service down" },
        isToolError: true,
        rawContent: [],
      },
    });
    const patch = await finalResponseNode(state);

    // Without pendingCampaignAction, a tool error on get_all_campaigns goes
    // through humanizeToolError, not the "no campaigns" path.
    expect(patch.finalResponse).not.toMatch(/no campaigns/i);
  });

  it("send flow: state.error set (MCP transport threw, toolResult=undefined) → friendly no-campaigns message", async () => {
    // This covers the path where mcpClientService.dispatch() throws (e.g. ECONNREFUSED)
    // and executeFromState returns { error } instead of { toolResult }.
    // toolResult is undefined; the fix must intercept state.error before the generic wrapper.
    const state = makeState({
      intent:                "start_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "start_campaign",
      error:                 "The request could not be completed. Please check your input and try again.",
      // toolResult is intentionally absent (undefined in makeState default)
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBe(
      "No campaigns found. Please create a campaign first before sending.",
    );
  });

  it("list flow: state.error set with no pendingAction → generic error wrapper (not no-campaigns)", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      error:    "The request could not be completed. Please check your input and try again.",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toMatch(/no campaigns/i);
    expect(patch.finalResponse).toMatch(/something went wrong/i);
  });
});

// ── 7. Bug #4 — list_campaigns shows plain list (not selection prompt) ─────────

describe("list_campaigns — plain readable list without selection prompt", () => {
  const CAMPAIGNS = [
    { id: "c1", name: "Summer Sale",  status: "draft" },
    { id: "c2", name: "Eid Offer",    status: "running" },
    { id: "c3", name: "Black Friday", status: "paused" },
  ];

  it("shows numbered list with name and status", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toContain("draft");
    expect(patch.finalResponse).toContain("Eid Offer");
    expect(patch.finalResponse).toContain("Black Friday");
  });

  it("does NOT include a 'which would you like to' selection prompt", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toMatch(/which campaign would you like/i);
    expect(patch.finalResponse).not.toMatch(/reply with the number/i);
  });
});

// ── 8. Bug #8 — get_campaign_stats formats stats data ────────────────────────

describe("get_campaign_stats — deterministic formatted stats message", () => {
  it("formats sent, opened, and open rate from flat data", async () => {
    mockEnhanceResponse.mockRejectedValue(new Error("skip")); // force deterministic path
    const state = makeState({
      intent:      "get_campaign_stats",
      toolName:    "get_campaign_stats",
      userMessage: "Show stats",
      toolResult: {
        data:        { sent: 10000, delivered: 9800, opened: 4500, clicked: 900, bounced: 200, openRate: 0.45, clickRate: 0.09, bounceRate: 0.02 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("10,000");
    expect(parsed.message).toContain("4,500");
    expect(parsed.message).toContain("45.0%");
  });

  it("message contains 'statistics' or numeric data (not just generic label)", async () => {
    mockEnhanceResponse.mockRejectedValue(new Error("skip"));
    const state = makeState({
      intent:      "get_campaign_stats",
      toolName:    "get_campaign_stats",
      userMessage: "Show stats",
      toolResult:  { data: { sent: 500, opened: 200, openRate: 0.4 }, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    // Must not be just the generic placeholder
    expect(parsed.message).not.toBe("Campaign statistics retrieved.");
    expect(parsed.message).toMatch(/\d/); // contains at least one number
  });
});

// ── 9. Bug #9 — list_replies formats reply items ─────────────────────────────

describe("list_replies — formats actual reply items", () => {
  it("shows sender and preview for each reply item", async () => {
    mockEnhanceResponse.mockRejectedValue(new Error("skip"));
    const repliesData = {
      items: [
        { sender: "alice@example.com", preview: "Thanks for the offer!", receivedAt: "2026-01-10T10:00:00Z" },
        { sender: "bob@example.com",   preview: "I am interested.",       receivedAt: "2026-01-10T11:00:00Z" },
      ],
      total: 2,
    };
    const state = makeState({
      intent:      "list_replies",
      toolName:    "list_replies",
      userMessage: "Show replies",
      toolResult:  { data: repliesData, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.message).toContain("alice@example.com");
    expect(parsed.message).toContain("Thanks for the offer");
    expect(parsed.message).not.toBe("Replies retrieved.");
  });

  it("shows 'No replies found' when items array is empty", async () => {
    mockEnhanceResponse.mockRejectedValue(new Error("skip"));
    const state = makeState({
      intent:      "list_replies",
      toolName:    "list_replies",
      userMessage: "Show replies",
      toolResult:  { data: { items: [], total: 0 }, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.message).toMatch(/no replies/i);
  });
});

// ── 10. Bug #10 — summarize_replies: empty data skips OpenAI ─────────────────

describe("summarize_replies — skips OpenAI when no reply items", () => {
  it("returns 'no replies to summarize' without calling OpenAI for empty items", async () => {
    const state = makeState({
      intent:      "summarize_replies",
      toolName:    "summarize_replies",
      userMessage: "Summarise replies",
      toolResult:  { data: { items: [], total: 0 }, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(mockSummarizeReplies).not.toHaveBeenCalled();
    const parsed = parseFR(patch);
    expect(parsed.message).toMatch(/no replies/i);
  });

  it("calls OpenAI when items are present", async () => {
    mockSummarizeReplies.mockResolvedValue("Great feedback from customers!");
    const state = makeState({
      intent:      "summarize_replies",
      toolName:    "summarize_replies",
      userMessage: "Summarise replies",
      toolResult: {
        data:        { items: [{ id: "1", sender: "a@b.com", preview: "Love it" }], total: 1 },
        isToolError: false,
        rawContent:  [],
      },
    });
    await finalResponseNode(state);

    expect(mockSummarizeReplies).toHaveBeenCalledOnce();
  });
});

// ── 11. Bug #11 — check_smtp formats SMTP settings ────────────────────────────

describe("check_smtp — formatted SMTP settings with verification status", () => {
  it("shows host, port, username, and verified status", async () => {
    const smtpData = { host: "smtp.sendgrid.net", port: 587, username: "apikey", encryption: "tls", isVerified: true };
    const state = makeState({
      intent:      "check_smtp",
      toolName:    "get_smtp_settings",
      userMessage: "Show smtp settings",
      toolResult:  { data: smtpData, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.message).toContain("smtp.sendgrid.net");
    expect(parsed.message).toContain("587");
    expect(parsed.message).toContain("apikey");
    expect(parsed.message).toContain("✅");
  });

  it("shows ❌ when isVerified is false", async () => {
    const smtpData = { host: "smtp.example.com", port: 465, username: "user@example.com", encryption: "ssl", isVerified: false };
    const state = makeState({
      intent:      "check_smtp",
      toolName:    "get_smtp_settings",
      userMessage: "Check smtp",
      toolResult:  { data: smtpData, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.message).toContain("❌");
    expect(parsed.message).not.toBe("SMTP settings retrieved.");
  });

  it("message is not the generic placeholder", async () => {
    const state = makeState({
      intent:      "check_smtp",
      toolName:    "get_smtp_settings",
      toolResult:  { data: { host: "smtp.test.com", port: 25 }, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);
    const parsed = parseFR(patch);

    expect(parsed.message).not.toBe("SMTP settings retrieved.");
    expect(parsed.message).toContain("smtp.test.com");
  });
});

// ── 12. schedule_campaign empty-state and error handling ─────────────────────

describe("schedule_campaign — no campaigns empty-state", () => {
  it("empty campaign list returns exact 'before scheduling' message (not generic error)", async () => {
    const state = makeState({
      intent:                "schedule_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "schedule_campaign",
      toolResult: { data: [], isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBe(
      "No campaigns found. Please create a campaign first before scheduling.",
    );
  });

  it("MCP envelope with empty data returns 'before scheduling' message", async () => {
    const envelope = { success: true, data: [] };
    const state = makeState({
      intent:                "schedule_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "schedule_campaign",
      toolResult: { data: envelope, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).toMatch(/scheduling/i);
  });

  it("toolError on get_all_campaigns with pendingAction=schedule → no-campaigns message (not generic)", async () => {
    const state = makeState({
      intent:                "schedule_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "schedule_campaign",
      toolResult: {
        data:        { code: "NOT_FOUND", message: "no campaigns" },
        isToolError: true,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).not.toMatch(/something went wrong/i);
    expect(patch.finalResponse).not.toMatch(/could not be completed/i);
  });

  it("state.error on schedule_campaign with get_all_campaigns toolName → no-campaigns message", async () => {
    const state = makeState({
      intent:                "schedule_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "schedule_campaign",
      error:                 "The request could not be completed. Please check your input and try again.",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBe(
      "No campaigns found. Please create a campaign first before scheduling.",
    );
  });

  it("state.error on schedule_campaign with unknown toolName → no-campaigns safety-net (not generic error)", async () => {
    // Defensive: even if toolName ends up as update_campaign (e.g. plan path regression),
    // intent=schedule_campaign should still return the no-campaigns message.
    const state = makeState({
      intent:   "schedule_campaign",
      toolName: "update_campaign",
      error:    "The request could not be completed. Please check your input and try again.",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/no campaigns/i);
    expect(patch.finalResponse).not.toMatch(/something went wrong/i);
  });

  it("schedule clarification prompt (no toolName, error is user message) returns prompt directly", async () => {
    const clarification =
      "When would you like to schedule this campaign? Please provide a date and time, " +
      "e.g. **tomorrow at 10 AM**, **next Monday at 9:00 AM**, or an exact date/time.";
    const state = makeState({
      intent:   "schedule_campaign",
      toolName: undefined,
      error:    clarification,
    });
    const patch = await finalResponseNode(state);

    // CampaignAgent returns the clarification as error with no toolName —
    // buildResponse should surface it directly (not wrap in "I'm sorry...")
    expect(patch.finalResponse).toContain("tomorrow at 10 AM");
    expect(patch.finalResponse).not.toMatch(/something went wrong/i);
  });

  it("multiple campaigns returns selection prompt with 'schedule' verb", async () => {
    const CAMPAIGNS = [
      { id: "camp-1", name: "Summer Sale",  status: "draft" },
      { id: "camp-2", name: "Winter Promo", status: "draft" },
    ];
    const state = makeState({
      intent:                "schedule_campaign",
      toolName:              "get_all_campaigns",
      pendingCampaignAction: "schedule_campaign",
      toolResult: { data: CAMPAIGNS, isToolError: false, rawContent: [] },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/\bschedule\b/i);
    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toContain("Winter Promo");
    expect(patch.finalResponse).not.toMatch(/no campaigns/i);
  });
});

// ── 8. Phase 1 capabilities — general_help content ───────────────────────────

describe("general_help — Phase 1 capabilities are included", () => {
  // All these tests use a broad-help userMessage so EXPLICIT_HELP_RE fires
  // and the full CAPABILITIES card is returned (not the clarification prompt).

  it("mentions CSV upload in general_help response", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/CSV|Excel/i);
  });

  it("mentions personalized email generation in general_help response", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/personali[sz]ed/i);
  });

  it("mentions schedule or date/time in general_help response", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/schedul/i);
  });

  it("mentions AI campaign or AI-assisted in general_help response", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/AI.*(campaign|assisted)|AI Campaigns/i);
  });

  it("mentions template selection in general_help response", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/template/i);
  });
});

// ── 9. Context-aware general_help: capabilities card vs clarification ─────────

describe("general_help — explicit vs contextual", () => {
  it("'help' alone shows the full capabilities card", async () => {
    const state = makeState({ intent: "general_help", userMessage: "help" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("AI Campaigns");
    expect(patch.finalResponse).toContain("Analytics");
    expect(patch.finalResponse).toContain("Inbox");
  });

  it("'what can you do' shows the full capabilities card", async () => {
    const state = makeState({ intent: "general_help", userMessage: "what can you do" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("AI Campaigns");
  });

  it("vague help ('I need some help') shows clarification, not full card", async () => {
    const state = makeState({ intent: "general_help", userMessage: "I need some help" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toContain("AI Campaigns");
    expect(patch.finalResponse).toMatch(/campaigns|recipients|templates/i);
    expect(patch.finalResponse).toMatch(/which part|work on/i);
  });

  it("'I want to do something' shows clarification, not full card", async () => {
    const state = makeState({ intent: "general_help", userMessage: "I want to do something with my emails" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toContain("Analytics\n");
    expect(patch.finalResponse).toMatch(/campaigns|templates/i);
  });
});

// ── 10. template_help intent ──────────────────────────────────────────────────

describe("template_help — does not return generic capabilities card", () => {
  it("returns template list, not the capabilities card", async () => {
    const state = makeState({ intent: "template_help", userMessage: "I want templates" });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toBeDefined();
    // Must list actual templates
    expect(patch.finalResponse).toMatch(/promotional/i);
    expect(patch.finalResponse).toMatch(/newsletter/i);
    expect(patch.finalResponse).toMatch(/follow.up/i);
    // Must NOT be the generic capabilities card
    expect(patch.finalResponse).not.toContain("Analytics");
    expect(patch.finalResponse).not.toContain("Inbox");
  });

  it("response is plain text (not JSON)", async () => {
    const state = makeState({ intent: "template_help" });
    const patch = await finalResponseNode(state);
    expect(() => JSON.parse(patch.finalResponse!)).toThrow();
  });
});

// ── 11. upload_recipients_help intent ─────────────────────────────────────────

describe("upload_recipients_help — gives concrete upload guidance", () => {
  it("mentions the attach button and CSV", async () => {
    const state = makeState({
      intent:      "upload_recipients_help",
      userMessage: "how do I upload recipients",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/attach|📎/i);
    expect(patch.finalResponse).toMatch(/CSV|Excel/i);
    expect(patch.finalResponse).toMatch(/email.*column|column.*email/i);
    expect(patch.finalResponse).not.toContain("Analytics");
  });

  it("response is plain text (not JSON)", async () => {
    const state = makeState({ intent: "upload_recipients_help" });
    const patch = await finalResponseNode(state);
    expect(() => JSON.parse(patch.finalResponse!)).toThrow();
  });
});

// ── 12. ai_campaign_help intent ───────────────────────────────────────────────

describe("ai_campaign_help — explains the AI campaign wizard", () => {
  it("describes the wizard steps", async () => {
    const state = makeState({
      intent:      "ai_campaign_help",
      userMessage: "how do I create an AI campaign",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/upload.*recipient|recipient.*upload/i);
    expect(patch.finalResponse).toMatch(/personaliz/i);
    expect(patch.finalResponse).toMatch(/template/i);
    expect(patch.finalResponse).not.toContain("Analytics");
  });
});

// ── 13. next_step_help — session-aware guidance ───────────────────────────────

describe("next_step_help — session-aware next-step guidance", () => {
  it("suggests creating a campaign when no campaigns exist", async () => {
    const state = makeState({
      intent:               "next_step_help",
      userMessage:          "what should I do next",
      activeCampaignId:     undefined,
      campaignSelectionList: [],
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/create.*campaign|campaign.*create/i);
    expect(patch.finalResponse).not.toContain("Analytics");
  });

  it("suggests uploading CSV when campaign has 0 recipients", async () => {
    const state = makeState({
      intent:               "next_step_help",
      userMessage:          "what next",
      activeCampaignId:     "42",
      pendingAiCampaignData: { recipientCount: "0" },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/upload|CSV/i);
    expect(patch.finalResponse).toMatch(/no recipients|0 recipient/i);
  });

  it("suggests generating emails when recipients are ready", async () => {
    const state = makeState({
      intent:               "next_step_help",
      userMessage:          "what should I do",
      activeCampaignId:     "42",
      pendingAiCampaignData: { recipientCount: "150" },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/150 recipient/i);
    expect(patch.finalResponse).toMatch(/personali/i);
  });

  it("shows wizard step guidance when AI wizard is active", async () => {
    const state = makeState({
      intent:                "next_step_help",
      userMessage:           "what's next",
      pendingAiCampaignStep: "upload_recipients",
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/attach|📎|upload/i);
    expect(patch.finalResponse).toMatch(/CSV/i);
  });
});

// ── 14. campaign list 0-recipient warning ─────────────────────────────────────

describe("formatCampaignList — 0-recipient warning", () => {
  const CAMPAIGNS_WITH_ZERO = [
    { id: "1", name: "Summer Sale",  status: "draft", recieptCount: 0 },
    { id: "2", name: "Black Friday", status: "draft", recieptCount: 50 },
  ];

  it("shows ⚠️ marker on 0-recipient campaigns", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: {
        data:        { data: CAMPAIGNS_WITH_ZERO },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toContain("Summer Sale");
    expect(patch.finalResponse).toMatch(/⚠️.*0 recipient|0 recipient.*⚠️/i);
    // Black Friday has 50 recipients — no warning for that one
    expect(patch.finalResponse).toContain("Black Friday");
  });

  it("shows footer note when any campaign has 0 recipients", async () => {
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: {
        data:        { data: CAMPAIGNS_WITH_ZERO },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).toMatch(/upload a CSV/i);
  });

  it("no 0-recipient warning when all campaigns have recipients", async () => {
    const campaigns = [
      { id: "1", name: "Summer Sale",  status: "draft", recieptCount: 100 },
      { id: "2", name: "Black Friday", status: "draft", recieptCount: 50  },
    ];
    const state = makeState({
      intent:   "list_campaigns",
      toolName: "get_all_campaigns",
      toolResult: {
        data:        { data: campaigns },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    expect(patch.finalResponse).not.toMatch(/⚠️/);
    expect(patch.finalResponse).not.toMatch(/upload a CSV/i);
  });
});

// ── generate_personalized_emails — duplicate guard and regenerate ─────────────

describe("generate_personalized_emails — duplicate guard (alreadyExists)", () => {

  it("shows 'already exist' message when alreadyExists is true", async () => {
    const state = makeState({
      intent:           "generate_personalized_emails",
      toolName:         "generate_personalized_emails",
      activeCampaignId: "7",
      toolResult: {
        data:        { alreadyExists: true, existingCount: 24, generatedCount: 0, failedCount: 0 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("24");
    expect(parsed.message).toContain("#7");
  });

  it("alreadyExists message includes all three action options", async () => {
    const state = makeState({
      intent:           "generate_personalized_emails",
      toolName:         "generate_personalized_emails",
      activeCampaignId: "7",
      toolResult: {
        data:        { alreadyExists: true, existingCount: 5, generatedCount: 0, failedCount: 0 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    const msg = parsed.message as string;
    expect(msg).toMatch(/review/i);
    expect(msg).toMatch(/regenerate/i);
    expect(msg).toMatch(/start campaign/i);
  });

  it("alreadyExists message is plain markdown, not raw JSON", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { alreadyExists: true, existingCount: 3, generatedCount: 0, failedCount: 0 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(typeof parsed.message).toBe("string");
    expect(() => JSON.parse(parsed.message as string)).toThrow();
  });

  it("normal generation (no alreadyExists) shows generated count", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { generatedCount: 10, failedCount: 0, totalRecipients: 10 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("10");
    expect(parsed.message).not.toContain("already exist");
  });

  it("all-failed generation returns error status with OPENAI_API_KEY hint", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { generatedCount: 0, failedCount: 3, totalRecipients: 3 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.message).toMatch(/OPENAI_API_KEY/i);
  });

  it("regenerate_personalized_emails intent formats the same way (overwrite success)", async () => {
    const state = makeState({
      intent:   "regenerate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { generatedCount: 5, failedCount: 0, totalRecipients: 5 },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("success");
    expect(parsed.message).toContain("5");
  });

  it("includes deliverability guidance when generation returns diagnostics", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data: {
          generatedCount: 1,
          failedCount: 0,
          totalRecipients: 1,
          modeUsed: "low_promotional_plaintext",
          deliverability: {
            inboxRisk: "medium",
            likelyTab: "promotions_likely",
            reasons: ["Marketing-style campaign language"],
            recommendations: ["Use shorter plain-text email"],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const patch = await finalResponseNode(state);
    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    const msg = parsed.message as string;

    expect(msg).toMatch(/Deliverability check/i);
    expect(msg).toMatch(/Inbox risk/i);
    expect(msg).toMatch(/Promotions/i);
    expect(msg).toMatch(/Review email/i);
    expect(msg).toMatch(/Start campaign/i);
  });

  it("includes SDR strategy summary and touch schedule for sequence generation", async () => {
    const state = makeState({
      intent: "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data: {
          generatedCount: 12,
          failedCount: 0,
          totalRecipients: 12,
          touchesPerLead: 4,
          strategy: {
            tone: "executive_direct",
            ctaType: "curiosity_cta",
            ctaText: "Worth sharing a quick idea?",
            sequenceType: "cold_outreach",
            outreachApproach: "value-first cold outreach",
            reasoning: [],
          },
          touchSchedule: [0, 3, 7, 14],
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const patch = await finalResponseNode(state);
    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    const msg = parsed.message as string;

    expect(msg).toMatch(/4-touch SDR sequence/i);
    expect(msg).toContain("**Tone:** executive_direct");
    expect(msg).toContain("**CTA:** curiosity_cta");
    expect(msg).toContain("**Sequence:** cold_outreach");
    expect(msg).toMatch(/Day 14/i);
  });

  it("formats get_personalized_emails sequence preview from emails array", async () => {
    const state = makeState({
      intent: "review_personalized_emails",
      toolName: "get_personalized_emails",
      toolResult: {
        data: {
          success: true,
          data: {
            emails: [
              {
                recipientEmail: "sam@example.com",
                sequenceTouches: [
                  {
                    touchNumber: 1,
                    recommendedDelayDays: 0,
                    personalizedSubject: "Quick question",
                    personalizedText: "Hi Sam...",
                  },
                  {
                    touchNumber: 2,
                    recommendedDelayDays: 3,
                    personalizedSubject: "Quick follow-up",
                    personalizedText: "Following up...",
                  },
                ],
              },
            ],
          },
        },
        isToolError: false,
        rawContent: [],
      },
    });

    const patch = await finalResponseNode(state);
    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    const msg = parsed.message as string;

    expect(msg).toMatch(/sequence preview/i);
    expect(msg).toMatch(/Touch 1/i);
    expect(msg).toMatch(/Day 3/i);
  });

  // ── Timeout / toolFailure handling ───────────────────────────────────────────

  it("success:false with MAILFLOW_TIMEOUT → timeout failure message, never 'Generated 0'", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { success: false, error: { code: "MAILFLOW_TIMEOUT", message: "Request timed out after 10000ms" } },
        isToolError: false, // simulates FastMCP transport not setting isToolError
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.message).toMatch(/timed out|timeout/i);
    expect(parsed.message).not.toMatch(/Generated 0/i);
    expect(parsed.message).not.toMatch(/OPENAI_API_KEY/i);
  });

  it("success:false (non-timeout) → generic failure message, never 'Generated 0'", async () => {
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { success: false, error: { code: "MAILFLOW_API_ERROR", message: "Internal server error" } },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.message).toMatch(/failed/i);
    expect(parsed.message).not.toMatch(/Generated 0/i);
    expect(parsed.message).not.toMatch(/OPENAI_API_KEY/i);
  });

  it("regenerate intent + success:false timeout → timeout failure message", async () => {
    const state = makeState({
      intent:   "regenerate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { success: false, error: { code: "MAILFLOW_TIMEOUT", message: "Request timed out" } },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.message).toMatch(/timed out|timeout/i);
    expect(parsed.message).not.toMatch(/Generated 0/i);
  });

  it("success:false check runs before alreadyExists — no false 'already exist' on failures", async () => {
    // Regression guard: a toolFailure response must never trigger the alreadyExists branch
    const state = makeState({
      intent:   "generate_personalized_emails",
      toolName: "generate_personalized_emails",
      toolResult: {
        data:        { success: false, error: { code: "MAILFLOW_TIMEOUT" } },
        isToolError: false,
        rawContent:  [],
      },
    });
    const patch = await finalResponseNode(state);

    const parsed = JSON.parse(patch.finalResponse!) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(parsed.message).not.toMatch(/already exist/i);
    expect(parsed.message).not.toMatch(/review existing/i);
  });
});

// ── fetch_website_content formatter ──────────────────────────────────────────

describe("fetch_website_content formatter", () => {
  const SAMPLE_CONTENT = [
    "# About Us",
    "OpenAI is an AI safety company focused on building beneficial artificial general intelligence.",
    "## Products",
    "We build ChatGPT, GPT-4, DALL·E, and Whisper.",
    "## Research",
    "Our research covers reinforcement learning, alignment, and interpretability.",
  ].join("\n");

  function makeWebsiteState(overrides: Partial<AgentGraphStateType> = {}): AgentGraphStateType {
    return makeState({
      intent:   "fetch_company_website",
      toolName: "fetch_website_content",
      toolResult: {
        data: {
          url:           "https://openai.com",
          title:         "OpenAI",
          content:       SAMPLE_CONTENT,
          contentLength: SAMPLE_CONTENT.length,
          source:        "jina",
          fallbackUsed:  false,
        },
        isToolError: false,
        rawContent:  [],
      },
      ...overrides,
    });
  }

  it("deterministic: does not include raw content in response", async () => {
    mockSummarizeWebsiteContent.mockRejectedValue(new Error("OpenAI unavailable"));
    const patch = await finalResponseNode(makeWebsiteState());
    const parsed = parseFR(patch);
    expect(parsed.message).not.toContain(SAMPLE_CONTENT);
    expect((parsed.message as string).length).toBeLessThan(1500);
  });

  it("deterministic: includes contentLength in response", async () => {
    mockSummarizeWebsiteContent.mockRejectedValue(new Error("OpenAI unavailable"));
    const patch = await finalResponseNode(makeWebsiteState());
    const parsed = parseFR(patch);
    expect(parsed.message).toContain(String(SAMPLE_CONTENT.length));
  });

  it("deterministic: includes provider in response", async () => {
    mockSummarizeWebsiteContent.mockRejectedValue(new Error("OpenAI unavailable"));
    const patch = await finalResponseNode(makeWebsiteState());
    const parsed = parseFR(patch);
    expect(parsed.message).toMatch(/Jina Reader/i);
  });

  it("deterministic: includes a summary extracted from headings", async () => {
    mockSummarizeWebsiteContent.mockRejectedValue(new Error("OpenAI unavailable"));
    const patch = await finalResponseNode(makeWebsiteState());
    const parsed = parseFR(patch);
    expect(parsed.message).toContain("Summary");
    expect(parsed.message).toContain("Detected focus areas");
  });

  it("openai path: uses summarizeWebsiteContent result when available", async () => {
    mockSummarizeWebsiteContent.mockResolvedValue(
      "SUMMARY:\nOpenAI builds safe AI systems.\n\nFOCUS AREAS:\n- AI safety\n- Research\n- Products",
    );
    const patch = await finalResponseNode(makeWebsiteState());
    const parsed = parseFR(patch);
    expect(parsed.message).toContain("OpenAI builds safe AI systems.");
    expect(parsed.message).toContain("AI safety");
    expect((parsed.message as string).length).toBeLessThan(1500);
  });
});
