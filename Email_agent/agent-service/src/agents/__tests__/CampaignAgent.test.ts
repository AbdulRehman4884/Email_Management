/**
 * src/agents/__tests__/CampaignAgent.test.ts
 *
 * Unit tests for CampaignAgent.handle().
 *
 * Covers:
 *   1. Vague create_campaign requests start the wizard (step-by-step or auto-gen)
 *   2. Detailed create_campaign requests with all required fields resolve to
 *      a valid MCP dispatch (toolName set, toolArgs populated)
 *   3. MCP tool is NOT dispatched when required fields are missing
 *      (toolName is undefined in the returned patch)
 *   4. Draft continuation — confirmation, cancellation, and field edits
 *   5. All other campaign intents still resolve correctly
 */

import { vi, describe, it, expect } from "vitest";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";
import type { LLMIntentArguments } from "../../schemas/llmIntent.schema.js";

// ── Module mock ───────────────────────────────────────────────────────────────
// Default: OpenAI unavailable → forces step-by-step wizard in all tests below.
// Individual describe blocks override mockGenerateCampaignDraft to test auto-gen.

const { mockGenerateCampaignDraft, mockCompleteJson } = vi.hoisted(() => ({
  mockGenerateCampaignDraft: vi.fn<() => Promise<Record<string, string> | null>>(),
  mockCompleteJson: vi.fn<(system: string, user: string) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () =>
    mockGenerateCampaignDraft.getMockImplementation() !== undefined || mockCompleteJson.getMockImplementation() !== undefined
      ? { generateCampaignDraft: mockGenerateCampaignDraft, completeJson: mockCompleteJson }
      : undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

// "Generate personalized emails" starts the agent's own flow (tested in lib/__tests__/campaignCreation.test.ts).
const { mockStartPersonalize, mockStartPersonalizeFor } = vi.hoisted(() => ({ mockStartPersonalize: vi.fn(), mockStartPersonalizeFor: vi.fn() }));
vi.mock("../../lib/personalizeEmailsFlow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/personalizeEmailsFlow.js")>()),
  startPersonalize: mockStartPersonalize,
  startPersonalizeFor: mockStartPersonalizeFor,
}));

// The MCP server: offline unless a test says otherwise (the start/pause/resume status check then lets the action through).
const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));

// Import after mock registration so the mock is applied.
import { campaignAgent } from "../CampaignAgent.js";

// Reset the mock before each test so tests don't bleed into each other.
// By default the mock has no implementation → getOpenAIService() returns undefined.
import { beforeEach } from "vitest";
beforeEach(() => {
  mockGenerateCampaignDraft.mockReset();
  mockCompleteJson.mockReset();
  mockStartPersonalize.mockClear();
  mockStartPersonalizeFor.mockReset();
  mockDispatch.mockReset();
  mockDispatch.mockRejectedValue(new Error("MCP offline in unit tests"));
});

// ── State builder ─────────────────────────────────────────────────────────────

function makeState(
  partial: Partial<AgentGraphStateType>,
): AgentGraphStateType {
  return {
    messages:             [],
    userMessage:          "",
    sessionId:            undefined,
    userId:               undefined,
    rawToken:             undefined,
    intent:               undefined,
    confidence:           0,
    llmExtractedArgs:     undefined,
    agentDomain:          undefined,
    toolName:             undefined,
    toolArgs:             {},
    toolResult:           undefined,
    requiresApproval:     false,
    pendingActionId:      undefined,
    finalResponse:        undefined,
    activeCampaignId:     undefined,
    senderDefaults:       undefined,
    pendingCampaignDraft: undefined,
    pendingCampaignStep:  undefined,
    plan:                 undefined,
    planIndex:            0,
    planResults:          [],
    error:                undefined,
    pendingCampaignAction:  undefined,
    campaignSelectionList:  undefined,
    pendingScheduledAt:     undefined,
    pendingAiCampaignStep:  undefined,
    pendingAiCampaignData:  undefined,
    ...partial,
  } as AgentGraphStateType;
}

describe("sequence control intents", () => {
  it("routes show_sequence_progress to get_sequence_progress", async () => {
    const state = makeState({
      intent: "show_sequence_progress",
      activeCampaignId: "42",
      userMessage: "show sequence progress",
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_sequence_progress");
    expect(patch.toolArgs).toEqual({ campaignId: "42" });
  });

  it("routes show_pending_follow_ups to get_pending_follow_ups", async () => {
    const state = makeState({
      intent: "show_pending_follow_ups",
      activeCampaignId: "42",
      userMessage: "show pending follow-ups",
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_pending_follow_ups");
    expect(patch.toolArgs).toEqual({ campaignId: "42", limit: 10 });
  });

  it("extracts recipient email for touch history", async () => {
    const state = makeState({
      intent: "show_recipient_touch_history",
      activeCampaignId: "42",
      userMessage: "show touch history for sam@example.com",
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_recipient_touch_history");
    expect(patch.toolArgs).toEqual({ campaignId: "42", recipientEmail: "sam@example.com" });
  });

  it("routes mark replied and mark bounced commands", async () => {
    const replied = await campaignAgent.handle(makeState({
      intent: "mark_recipient_replied",
      activeCampaignId: "42",
      userMessage: "mark recipient 12 replied",
    }));
    expect(replied.toolName).toBe("mark_recipient_replied");
    expect(replied.toolArgs).toEqual({ campaignId: "42", recipientId: "12" });

    const bounced = await campaignAgent.handle(makeState({
      intent: "mark_recipient_bounced",
      activeCampaignId: "42",
      userMessage: "mark bounced for jane@example.com",
    }));
    expect(bounced.toolName).toBe("mark_recipient_bounced");
    expect(bounced.toolArgs).toEqual({ campaignId: "42", recipientEmail: "jane@example.com" });
  });
});

// ── create_campaign — wizard start (missing fields) ──────────────────────────

// "create campaign" now starts the chat campaign creation flow (lib/campaignCreationFlow.ts):
// name → file → one researched email per recipient → template → schedule → confirm.
const flowMessage = (patch: Partial<AgentGraphStateType>) => JSON.parse(String(patch.formattedResponse)).message as string;

describe("create_campaign — starts the campaign creation flow", () => {
  it("vague input asks for the campaign name first", async () => {
    const state = makeState({ intent: "create_campaign", userMessage: "create a new campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.campaignCreation?.step).toBe("name");
    expect(flowMessage(patch)).toMatch(/What should the campaign be called/);
    // The old step-by-step draft is not started.
    expect(patch.pendingCampaignDraft).toBeUndefined();
  });

  it("a name in the request skips to the file question", async () => {
    const llmExtractedArgs: LLMIntentArguments = { filters: { name: "Summer Sale", subject: "Big Deals" } };
    const patch = await campaignAgent.handle(makeState({ intent: "create_campaign", userMessage: "create campaign", llmExtractedArgs }));

    expect(patch.toolName).toBeUndefined();
    expect(patch.campaignCreation).toMatchObject({ step: "file", name: "Summer Sale" });
    expect(flowMessage(patch)).toMatch(/upload your recipient file/i);
  });

  it("the question does not expose raw error stacks or internal codes", async () => {
    const patch = await campaignAgent.handle(makeState({ intent: "create_campaign" }));
    const text = flowMessage(patch);
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(/stack/i);
    expect(text).not.toMatch(/-32602/);
  });

  it("no OpenAI draft is generated any more: the emails are written per recipient later", async () => {
    mockGenerateCampaignDraft.mockResolvedValue({ name: "X", subject: "Y", body: "Z" });
    const patch = await campaignAgent.handle(makeState({ intent: "create_campaign", userMessage: "Create a campaign for summer sale" }));

    expect(mockGenerateCampaignDraft).not.toHaveBeenCalled();
    expect(patch.campaignCreation?.step).toBe("name");
  });
});

// ── create_campaign — draft continuation ─────────────────────────────────────

describe("create_campaign — draft continuation (pendingCampaignDraft set)", () => {
  const partialDraft = { name: "Summer Sale" };

  it("cancellation clears the draft and returns a cancellation message", async () => {
    const state = makeState({
      intent:              "general_help",
      userMessage:         "cancel",
      pendingCampaignDraft: partialDraft,
      pendingCampaignStep:  "subject",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignDraft).toBeUndefined();
    expect(patch.pendingCampaignStep).toBeUndefined();
    expect(patch.error).toMatch(/cancel/i);
  });

  it("user answer to step question is stored in draft and next field is asked", async () => {
    const state = makeState({
      intent:              "general_help",
      userMessage:         "Big Summer Deals",  // answer to "What should the subject be?"
      pendingCampaignDraft: { name: "Summer Sale" },
      pendingCampaignStep:  "subject",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignDraft?.name).toBe("Summer Sale");
    expect(patch.pendingCampaignDraft?.subject).toBe("Big Summer Deals");
    // Next missing field after name+subject is body (new FIELD_ORDER)
    expect(patch.pendingCampaignStep).toBe("body");
  });

  it("confirmation with complete draft dispatches create_campaign tool", async () => {
    const completeDraft = {
      name:      "Summer Sale",
      subject:   "Big Deals This Summer",
      fromName:  "Marketing Team",
      fromEmail: "marketing@example.com",
      body:      "Check out our summer deals!",
    };
    const state = makeState({
      intent:              "general_help",
      userMessage:         "yes",
      pendingCampaignDraft: completeDraft,
      pendingCampaignStep:  "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.toolArgs).toMatchObject(completeDraft);
    expect(patch.pendingCampaignDraft).toBeUndefined();
    expect(patch.pendingCampaignStep).toBeUndefined();
    expect(patch.error).toBeUndefined();
  });

  it("'confirm' clears the draft after dispatching", async () => {
    const completeDraft = {
      name: "X", subject: "Y", fromName: "Z",
      fromEmail: "a@b.com", body: "Hello",
    };
    const state = makeState({
      intent:              "general_help",
      userMessage:         "confirm",
      pendingCampaignDraft: completeDraft,
      pendingCampaignStep:  "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.pendingCampaignDraft).toBeUndefined();
    expect(patch.pendingCampaignStep).toBeUndefined();
  });

  it("re-presents draft when user response is unclear during confirm step", async () => {
    const completeDraft = {
      name: "X", subject: "Y", fromName: "Z",
      fromEmail: "a@b.com", body: "Hello",
    };
    const state = makeState({
      intent:              "general_help",
      userMessage:         "hmm",
      pendingCampaignDraft: completeDraft,
      pendingCampaignStep:  "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignDraft).toEqual(completeDraft);
    expect(patch.pendingCampaignStep).toBe("confirm");
    expect(patch.error).toBeDefined();
  });
});

// ── create_campaign — valid dispatch (all required fields present) ─────────────

describe("create_campaign — all required fields present → valid dispatch", () => {
  const fullFilters: LLMIntentArguments = {
    filters: {
      name:      "Summer Sale",
      subject:   "Big Deals Inside",
      fromName:  "Marketing Team",
      fromEmail: "marketing@example.com",
      body:      "Check out our latest offers.",
    },
  };

  it("sets toolName to create_campaign when all fields are present", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.error).toBeUndefined();
  });

  it("populates all three required fields in toolArgs (fromName/fromEmail come from SMTP, not wizard)", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolArgs).toMatchObject({
      name:    "Summer Sale",
      subject: "Big Deals Inside",
      body:    "Check out our latest offers.",
    });
  });

  it("does not set error when dispatch is allowed", async () => {
    const state = makeState({ intent: "create_campaign", llmExtractedArgs: fullFilters });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).toBeUndefined();
  });
});

// ── create_campaign — deterministic fallback extraction ───────────────────────

describe("create_campaign — deterministic extraction from userMessage (OpenAI unavailable)", () => {
  it("extracts required fields from a detailed natural-language message", async () => {
    // Regex extractor still parses fromName/fromEmail from message text.
    // Since only name/subject/body are required, the tool dispatches as soon
    // as those 3 are found — fromName/fromEmail may also appear in toolArgs
    // (from the regex merge) but are not required.
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Test Campaign, subject Welcome Offer, " +
        "from Saad at saad@example.com, body: Hello everyone",
      llmExtractedArgs: undefined, // OpenAI unavailable
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.error).toBeUndefined();
    expect(patch.toolArgs).toMatchObject({
      name:    "Test Campaign",
      subject: "Welcome Offer",
      body:    "Hello everyone",
    });
  });

  it("stops body extraction at 'and then' for multi-step messages", async () => {
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Test Campaign, subject Welcome Offer, " +
        "from Saad at saad@example.com, body: Hello everyone and then start it",
      llmExtractedArgs: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.body).toBe("Hello everyone");
  });

  it("LLM-extracted fields override deterministic extraction when both present", async () => {
    // OpenAI extracted name/subject/body via filters — these take priority over
    // values the regex extractor would pull from the userMessage.
    // fromName/fromEmail are no longer wizard fields — backend derives from SMTP.
    const state = makeState({
      intent: "create_campaign",
      userMessage:
        "Create a campaign called Regex Name, subject Regex Subject, " +
        "from Regex at regex@example.com, body: Regex body",
      llmExtractedArgs: {
        filters: {
          name:      "LLM Name",      // LLM wins over regex "Regex Name"
          subject:   "LLM Subject",   // LLM wins over regex "Regex Subject"
          fromName:  "LLM Sender",
          fromEmail: "llm@example.com",
          body:      "LLM body",      // LLM wins over regex "Regex body"
        },
      },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.name).toBe("LLM Name");
    expect((patch.toolArgs as Record<string, unknown>)?.subject).toBe("LLM Subject");
    expect((patch.toolArgs as Record<string, unknown>)?.body).toBe("LLM body");
  });

  it("a name without subject and body starts the creation flow at the file question", async () => {
    const state = makeState({
      intent: "create_campaign",
      userMessage: "Create a campaign called My Campaign",
      llmExtractedArgs: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.campaignCreation).toMatchObject({ step: "file", name: "My Campaign" });
  });
});

// ── MCP not called gate (toolName check) ──────────────────────────────────────

describe("MCP dispatch gate — toolName is undefined when required fields missing", () => {
  it("toolName is undefined for vague create request", async () => {
    const state = makeState({ intent: "create_campaign" });
    const patch = await campaignAgent.handle(state);
    // executeToolNode checks toolName before calling MCP; undefined means no call
    expect(patch.toolName).toBeUndefined();
  });

  it("toolName is set only when all three required fields are provided (name, subject, body)", async () => {
    const withAllFields = makeState({
      intent: "create_campaign",
      llmExtractedArgs: {
        filters: {
          name: "X", subject: "Y", body: "Hello",
        },
      },
    });
    const withMissingField = makeState({
      intent: "create_campaign",
      llmExtractedArgs: {
        filters: {
          name: "X", subject: "Y",
          // body missing
        },
      },
    });

    const patchFull    = await campaignAgent.handle(withAllFields);
    const patchPartial = await campaignAgent.handle(withMissingField);

    expect(patchFull.toolName).toBe("create_campaign");
    expect(patchPartial.toolName).toBeUndefined();
  });
});

// ── create_campaign — senderDefaults pre-population ─────────────────────────

describe("create_campaign — senderDefaults pre-population", () => {
  it("with senderDefaults, only name+subject+body are asked before confirm", async () => {
    const state = makeState({
      intent:         "create_campaign",
      userMessage:    "create a campaign",
      senderDefaults: { fromName: "Team", fromEmail: "team@example.com" },
      llmExtractedArgs: { filters: { name: "Summer Sale", subject: "Big Deals", body: "Great offers!" } },
    });
    const patch = await campaignAgent.handle(state);

    // All fields present including senderDefaults — should dispatch immediately
    expect(patch.toolName).toBe("create_campaign");
    expect(patch.toolArgs).toMatchObject({
      name:      "Summer Sale",
      subject:   "Big Deals",
      body:      "Great offers!",
      fromName:  "Team",
      fromEmail: "team@example.com",
    });
  });
});

// ── Other campaign intents unaffected ─────────────────────────────────────────

describe("other campaign intents are unaffected", () => {
  it("start_campaign resolves campaignId from LLM extraction", async () => {
    const state = makeState({
      intent: "start_campaign",
      llmExtractedArgs: { campaignId: "123" },
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "123" });
    expect(patch.error).toBeUndefined();
  });

  it("start_campaign resolves campaignId from session fallback", async () => {
    const state = makeState({
      intent:           "start_campaign",
      activeCampaignId: "99",
    });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "99" });
  });

  it("pause_campaign with no campaignId fetches campaign list for selection", async () => {
    const state = makeState({ intent: "pause_campaign" });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({});
    expect(patch.pendingCampaignAction).toBe("pause_campaign");
    expect(patch.error).toBeUndefined();
  });

  it("check_smtp maps to get_smtp_settings with empty args", async () => {
    const state = makeState({ intent: "check_smtp" });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBe("get_smtp_settings");
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeUndefined();
  });

  it("unknown intent returns error without setting toolName", async () => {
    const state = makeState({ intent: "general_help" as never });
    const patch = await campaignAgent.handle(state);
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
});

// ── list_campaigns intent ─────────────────────────────────────────────────────

describe("list_campaigns intent dispatches get_all_campaigns", () => {
  it("list_campaigns → toolName get_all_campaigns with empty args", async () => {
    const state = makeState({ intent: "list_campaigns" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeUndefined();
  });
});

// ── start/pause/resume with no campaignId → selection flow ───────────────────

describe("campaign action intents with no campaignId trigger selection flow", () => {
  it("start_campaign with no campaignId dispatches get_all_campaigns and sets pendingCampaignAction", async () => {
    const state = makeState({ intent: "start_campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({});
    expect(patch.pendingCampaignAction).toBe("start_campaign");
    // Intent is NOT overridden — original intent is preserved in graph state
    expect(patch.intent).toBeUndefined();
    expect(patch.error).toBeUndefined();
  });

  it("pause_campaign with no campaignId dispatches get_all_campaigns and sets pendingCampaignAction", async () => {
    const state = makeState({ intent: "pause_campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({});
    expect(patch.pendingCampaignAction).toBe("pause_campaign");
    expect(patch.intent).toBeUndefined();
  });

  it("resume_campaign with no campaignId dispatches get_all_campaigns and sets pendingCampaignAction", async () => {
    const state = makeState({ intent: "resume_campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({});
    expect(patch.pendingCampaignAction).toBe("resume_campaign");
    expect(patch.intent).toBeUndefined();
  });

  it("start_campaign with numeric campaignId from LLM skips selection and dispatches directly", async () => {
    const state = makeState({
      intent: "start_campaign",
      llmExtractedArgs: { campaignId: "42" },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("42");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("non-numeric LLM campaignId ('...') falls back to session activeCampaignId", async () => {
    // Simulates OpenAI extracting a template placeholder instead of a real ID
    const state = makeState({
      intent:           "start_campaign",
      llmExtractedArgs: { campaignId: "..." },
      activeCampaignId: "3",
    });
    const patch = await campaignAgent.handle(state);

    // Must use session activeCampaignId "3", not the garbage "..."
    expect(patch.toolName).toBe("start_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("3");
  });

  it("non-numeric LLM campaignId with no session fallback → triggers selection flow", async () => {
    const state = makeState({
      intent:           "start_campaign",
      llmExtractedArgs: { campaignId: "all" },
      activeCampaignId: undefined,
    });
    const patch = await campaignAgent.handle(state);

    // Neither LLM value nor session value is valid — must fetch campaign list
    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.pendingCampaignAction).toBe("start_campaign");
  });

  it("non-numeric LLM campaignId ('recipients') with no session → selection flow", async () => {
    const state = makeState({
      intent:           "start_campaign",
      llmExtractedArgs: { campaignId: "recipients" },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.pendingCampaignAction).toBe("start_campaign");
  });
});

// ── Campaign selection (user picks from numbered list) ────────────────────────

const CAMPAIGN_LIST = [
  { id: "1", name: "Summer Sale", status: "draft" },
  { id: "2", name: "Eid Offer",   status: "draft" },
  { id: "3", name: "Black Friday", status: "paused" },
];

describe("handleCampaignSelection — numeric and name selection", () => {
  it("numeric '1' selects the first campaign and dispatches the pending action", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "1",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("1");
    expect(patch.pendingCampaignAction).toBeUndefined();
    expect(patch.campaignSelectionList).toBeUndefined();
  });

  it("numeric '2' selects the second campaign", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "2",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("2");
  });

  it("campaign name match selects the correct campaign", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "Summer Sale",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("1");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("partial name match ('eid') selects the matching campaign", async () => {
    // resume_campaign filters to paused campaigns only, so Eid Offer must be paused
    const listWithPausedEid = [
      { id: "1", name: "Summer Sale", status: "running" },
      { id: "2", name: "Eid Offer",   status: "paused" },
      { id: "3", name: "Black Friday", status: "paused" },
    ];
    const state = makeState({
      intent:               "general_help",
      userMessage:          "eid",
      pendingCampaignAction: "resume_campaign",
      campaignSelectionList: listWithPausedEid,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("resume_campaign");
    expect((patch.toolArgs as Record<string, unknown>)?.campaignId).toBe("2");
  });

  it("unclear response re-presents the list without dispatching a tool", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "hmmm, not sure",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignAction).toBe("start_campaign");
    expect(patch.campaignSelectionList).toEqual(CAMPAIGN_LIST);
    expect(patch.error).toBeDefined();
  });

  it("out-of-range number re-presents the list", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "99",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignAction).toBe("start_campaign");
    expect(patch.error).toBeDefined();
  });

  it("cancellation clears pendingCampaignAction and campaignSelectionList", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "cancel",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignAction).toBeUndefined();
    expect(patch.campaignSelectionList).toBeUndefined();
    expect(patch.error).toMatch(/cancel/i);
  });

  it("'no' is treated as cancellation during selection", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "no",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignAction).toBeUndefined();
  });
});

// ── schedule_campaign ─────────────────────────────────────────────────────────

describe("schedule_campaign — no campaigns exist", () => {
  it("with valid date and no campaignId dispatches get_all_campaigns and stores scheduledAt", async () => {
    const state = makeState({
      intent: "schedule_campaign",
      userMessage: "scheduling tomorrow 10 AM for 2 hours",
    });

    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.pendingCampaignAction).toBe("schedule_campaign");
    expect(patch.pendingScheduledAt).toBe("tomorrow 10 AM for 2 hours");
    expect(patch.error).toBeUndefined();
  });
});


  it("with no campaignId — always fetches campaign list regardless of scheduling content", async () => {
    const state = makeState({
      intent:      "schedule_campaign",
      userMessage: "Schedule the campaign",
    });
    const patch = await campaignAgent.handle(state);

    // No campaignId → always fetch campaign list first
    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.pendingCampaignAction).toBe("schedule_campaign");
    // "schedule" keyword detected → preserves message for post-selection use
    expect(patch.pendingScheduledAt).toBe("Schedule the campaign");
  });

  it("strips prefix context and cleans newlines before storing pendingScheduledAt", async () => {
    // Simulates a polluted user message that contains prior-turn context followed
    // by the actual scheduling phrase on the next line.
    const state = makeState({
      intent:      "schedule_campaign",
      userMessage: "Show all campaigns\n\nscheduling tomorrow 10 AM",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.pendingScheduledAt).toBe("tomorrow 10 AM");
    expect(patch.pendingScheduledAt).not.toMatch(/show all campaigns/i);
    expect(patch.pendingScheduledAt).not.toMatch(/\n/);
  });


// QA 15 Nov 2026: scheduling answered with a JSON stub ("Backend schedule API integration pending")
// and saved nothing; a past date was accepted. Now: the time is read, a past time is refused, and an
// approval card sets scheduledAt (update_campaign, intent schedule_campaign) on Confirm.
describe("schedule_campaign — campaign exists (campaignId known)", () => {
  const future = () => mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2099-01-05 10:00" });

  it("a real schedule: update_campaign with scheduledAt, confirmed first (intent schedule_campaign)", async () => {
    future();
    const patch = await campaignAgent.handle(makeState({
      intent:           "schedule_campaign",
      userMessage:      "Schedule this campaign for tomorrow at 10 AM",
      activeCampaignId: "42",
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "42", scheduledAt: "2099-01-05T05:00:00.000Z" });
    expect(patch.intent).toBe("schedule_campaign");
    expect(String(patch.error ?? "")).not.toMatch(/JSON/);
  });

  it("uses the LLM-extracted campaignId", async () => {
    future();
    const patch = await campaignAgent.handle(makeState({
      intent:           "schedule_campaign",
      userMessage:      "Schedule Summer Sale for next Monday at 9 AM",
      llmExtractedArgs: { campaignId: "55" },
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect((patch.toolArgs as Record<string, unknown>).campaignId).toBe("55");
  });

  it("a time in the past is refused (QA: 'yesterday at 10am' was accepted)", async () => {
    mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2020-01-01 10:00" });
    const patch = await campaignAgent.handle(makeState({
      intent:           "schedule_campaign",
      userMessage:      "schedule it for yesterday at 10am",
      activeCampaignId: "42",
    }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toContain("has already passed");
  });

  it("a draft with no recipients is not scheduled (nothing would go out)", async () => {
    future();
    mockDispatch.mockResolvedValue({ isToolError: false, data: { success: true, data: [{ id: 452, name: "QA TEST AGENT DRAFT 2", status: "draft", recipientCount: 0 }] } });
    const patch = await campaignAgent.handle(makeState({
      intent: "schedule_campaign", userMessage: "schedule QA TEST AGENT DRAFT 2 for 31 December 2026 at 10:00 AM", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toContain("(#452) has **no recipients**");
  });
});

describe("schedule_campaign — multiple campaigns (selection flow)", () => {
  const SCHED_CAMPAIGNS = [
    { id: "1", name: "Summer Sale",  status: "draft" },
    { id: "2", name: "Winter Promo", status: "draft" },
  ];

  it("picking by number schedules that campaign with the time from the first message", async () => {
    mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2099-01-05 10:00" });
    const patch = await campaignAgent.handle(makeState({
      intent:               "general_help",
      userMessage:          "1",
      pendingCampaignAction: "schedule_campaign",
      campaignSelectionList: SCHED_CAMPAIGNS,
      pendingScheduledAt:   "tomorrow at 10 AM",
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect((patch.toolArgs as Record<string, unknown>).campaignId).toBe("1");
    expect(JSON.parse(String(mockCompleteJson.mock.calls[0]![1])).message).toBe("tomorrow at 10 AM");
    expect(patch.pendingCampaignAction).toBeUndefined();
    expect(patch.campaignSelectionList).toBeUndefined();
    expect(patch.pendingScheduledAt).toBeUndefined();
  });

  it("picking by name", async () => {
    mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2099-01-05 09:00" });
    const patch = await campaignAgent.handle(makeState({
      intent:               "general_help",
      userMessage:          "Winter Promo",
      pendingCampaignAction: "schedule_campaign",
      campaignSelectionList: SCHED_CAMPAIGNS,
      pendingScheduledAt:   "next Monday at 9 AM",
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect((patch.toolArgs as Record<string, unknown>).campaignId).toBe("2");
  });

  it("re-presents list when scheduledAt is missing during selection (lost state)", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "1",
      pendingCampaignAction: "schedule_campaign",
      campaignSelectionList: SCHED_CAMPAIGNS,
      pendingScheduledAt:   undefined, // lost
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
    expect(patch.error).toMatch(/schedule|time/i);
  });
});

// ── Phase 1: create_ai_campaign — wizard entry ────────────────────────────────

describe("create_ai_campaign — wizard entry", () => {
  it("always starts at campaign_name step (no activeCampaignId)", async () => {
    const state = makeState({ intent: "create_ai_campaign", userMessage: "create ai campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_name");
    expect(patch.pendingAiCampaignData).toEqual({});
    expect(patch.error).toBeDefined();
    expect(patch.error).toMatch(/campaign name/i);
  });

  it("always starts at campaign_name step (even with activeCampaignId)", async () => {
    const state = makeState({
      intent: "create_ai_campaign",
      userMessage: "create ai campaign",
      activeCampaignId: "42",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_name");
    expect(patch.pendingAiCampaignData).toEqual({});
    expect(patch.error).toMatch(/campaign name/i);
  });
});

// ── Phase 1: AI wizard — campaign_name step ───────────────────────────────────

describe("AI wizard — campaign_name step", () => {
  it("name provided → stores campaignName and advances to campaign_subject", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      userMessage: "Summer Sale 2024",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(patch.pendingAiCampaignData?.campaignName).toBe("Summer Sale 2024");
    expect(patch.error).toContain("subject");
  });

  it("empty message → re-prompts at campaign_name", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_name");
    expect(patch.error).toBeDefined();
  });

  it("name is echoed back in the subject prompt", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      userMessage: "Black Friday",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).toContain("Black Friday");
  });
});

// ── Phase 1: AI wizard — campaign_subject step ────────────────────────────────

describe("AI wizard — campaign_subject step", () => {
  const baseData = { campaignName: "Summer Sale 2024" };

  it("subject provided → saves subject, advances to template_selection (NO tool call)", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: baseData,
      userMessage: "Huge deals — up to 50% off",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
    expect(patch.pendingAiCampaignData?.subject).toBe("Huge deals — up to 50% off");
    expect(patch.error).toContain("Template type");
  });

  it("empty message → re-prompts at campaign_subject", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: baseData,
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
  });
});

// ── Phase 1: AI wizard — template_selection step ─────────────────────────────

describe("AI wizard — template_selection step", () => {
  const baseData = { campaignName: "Summer Sale 2024", subject: "Big deals inside" };

  it("'1' → promotional, advances to campaign_body with body draft", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: baseData,
      userMessage: "1",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_body");
    expect(patch.pendingAiCampaignData?.templateType).toBe("promotional");
    expect(typeof patch.pendingAiCampaignData?.body).toBe("string");
    expect((patch.pendingAiCampaignData?.body ?? "").length).toBeGreaterThan(0);
    expect(patch.error).toContain("confirm");
  });

  it("'newsletter' → newsletter, advances to campaign_body", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: baseData,
      userMessage: "newsletter",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("campaign_body");
    expect(patch.pendingAiCampaignData?.templateType).toBe("newsletter");
  });

  it("unrecognised input → re-prompts at template_selection", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: baseData,
      userMessage: "something else entirely",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
  });
});

// ── Phase 1: AI wizard — campaign_body step ───────────────────────────────────

describe("AI wizard — campaign_body step", () => {
  const baseData = {
    campaignName: "Summer Sale 2024",
    subject: "Big deals inside",
    templateType: "promotional",
    body: "Hi {{name}},\n\nExclusive offer!\n\nBest regards,\nThe Summer Sale 2024 Team",
  };

  it("confirm → shows a summary to approve; nothing is created yet (bug A-04)", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: baseData,
      userMessage: "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("confirm_create");
    expect(patch.error).toContain("Please check before I create the campaign");
    expect(patch.error).toContain("Summer Sale 2024");
    expect(patch.error).toContain("no emails are sent");
  });

  it("create on the summary → dispatches create_campaign, advances to recipient_source", async () => {
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "confirm_create",
      pendingAiCampaignData: baseData,
      userMessage: "create",
    }));

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.toolArgs).toMatchObject({
      name:    "Summer Sale 2024",
      subject: "Big deals inside",
      // Saved as HTML paragraphs so the preview keeps the line breaks (bug A-11).
      body:    expect.stringMatching(/^<p>/),
    });
    expect(patch.pendingAiCampaignStep).toBe("recipient_source");
  });

  it("edit body on the summary → back to the body step, nothing created", async () => {
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "confirm_create",
      pendingAiCampaignData: baseData,
      userMessage: "edit body",
    }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_body");
  });

  it("a subject over 255 characters is rejected at the subject step (bug A-10)", async () => {
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Summer Sale 2024" },
      userMessage: "x".repeat(319),
    }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(patch.error).toContain("319 characters");
    expect(patch.pendingAiCampaignData?.subject).toBeUndefined();
  });

  it("edit message → updates body, stays at campaign_body", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: baseData,
      userMessage: "Make it shorter please",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("campaign_body");
    expect(patch.pendingAiCampaignData?.body).toBe("Make it shorter please");
    expect(patch.error).toContain("confirm");
  });

  it("missing fields → clears wizard and returns error", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: { campaignName: "Test" }, // no subject or body
      userMessage: "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
  });
});

// ── Phase 1: AI wizard — recipient_source step ────────────────────────────────

// QA 15 Nov 2026: "done" after uploading on the Campaigns page always found 0 recipients (the count went
// to a backend route that does not exist) and two different upload instructions alternated. The wizard
// now counts the campaign's recipients itself.
describe("AI wizard — 'done': the recipients are counted (recipient_source / upload_recipients / check_count)", () => {
  const baseData = { campaignName: "QA TEST WIZARD AGENT 2", subject: "Hi" };
  const count = (n: number) =>
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_recipient_count" ? { isToolError: false, data: { success: true, data: { campaignId: 454, pendingCount: n, totalCount: n } } } : { isToolError: true, data: {} },
    );

  it.each(["recipient_source", "upload_recipients", "check_count"])("%s + 2 recipients on the campaign → the wizard ends with the next steps", async (step) => {
    count(2);
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: step as never, pendingAiCampaignData: baseData, activeCampaignId: "454", userMessage: "done", rawToken: "t", userId: "u1" as never,
    }));
    expect(mockDispatch).toHaveBeenCalledWith("get_recipient_count", { campaignId: "454" }, expect.anything());
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toContain("has **2** recipients");
    expect(patch.error).toContain("Start campaign");
  });

  it("0 recipients → ONE instruction (chat 📎 or the Campaigns page), waits for 'done'", async () => {
    count(0);
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "upload_recipients", pendingAiCampaignData: baseData, activeCampaignId: "454", userMessage: "done", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.pendingAiCampaignStep).toBe("upload_recipients");
    expect(patch.error).toContain("has no recipients yet");
    expect(patch.error).toContain("📎");
    expect(patch.error).toContain("Upload Recipients");
  });

  it("the count can't be read → say so, keep waiting", async () => {
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "recipient_source", pendingAiCampaignData: baseData, activeCampaignId: "454", userMessage: "done", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.pendingAiCampaignStep).toBe("upload_recipients");
    expect(patch.error).toContain("couldn't check the recipients");
  });

  it("no activeCampaignId → the wizard ends with a restart hint", async () => {
    const patch = await campaignAgent.handle(makeState({ pendingAiCampaignStep: "check_count", pendingAiCampaignData: baseData, userMessage: "done" }));
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toContain("create AI campaign");
  });

  it.each(["template", "tone", "custom_prompt", "generate", "review", "approve"])(
    "a session still on the old '%s' step ends the wizard instead of calling a missing backend route",
    async (step) => {
      const patch = await campaignAgent.handle(makeState({
        pendingAiCampaignStep: step as never,
        pendingAiCampaignData: { ...baseData, recipientCount: "5" },
        activeCampaignId: "42",
        userMessage: "yes",
      }));
      expect(patch.toolName).toBeUndefined();
      expect(patch.pendingAiCampaignStep).toBeUndefined();
      expect(patch.error).toContain("draft");
    },
  );
});

// ── Phase 1: AI wizard — cancellation at any step ────────────────────────────

describe("AI wizard — cancellation clears wizard state", () => {
  const CANCEL_STEPS = [
    { step: "campaign_name",      data: {} },
    { step: "campaign_subject",   data: { campaignName: "Summer Sale" } },
    { step: "template_selection", data: { campaignName: "Summer Sale", subject: "Deals" } },
    { step: "campaign_body",      data: { campaignName: "Summer Sale", subject: "Deals", body: "Hi!" } },
    { step: "recipient_source",   data: { campaignName: "Summer Sale", subject: "Deals" } },
    { step: "upload_recipients",  data: { campaignName: "Summer Sale" } },
    { step: "check_count",        data: { campaignName: "Summer Sale", recipientCount: "25" } },
    { step: "template",           data: {} },
    { step: "tone",               data: { templateType: "promotional" } },
    { step: "custom_prompt",      data: { templateType: "promotional", toneInstruction: "friendly" } },
    { step: "generate",           data: { templateType: "promotional" } },
    { step: "review",             data: { templateType: "promotional" } },
    { step: "approve",            data: { templateType: "promotional" } },
  ] as const;

  for (const { step, data } of CANCEL_STEPS) {
    it(`'cancel' at '${step}' clears pendingAiCampaignStep and pendingAiCampaignData`, async () => {
      const state = makeState({
        pendingAiCampaignStep: step,
        pendingAiCampaignData: data,
        activeCampaignId: "42",
        userMessage: "cancel",
      });
      const patch = await campaignAgent.handle(state);

      expect(patch.toolName).toBeUndefined();
      expect(patch.pendingAiCampaignStep).toBeUndefined();
      expect(patch.pendingAiCampaignData).toBeUndefined();
      expect(patch.error).toMatch(/cancel/i);
    });
  }

  it("'abort' is treated as cancellation at any step", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "abort",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toMatch(/cancel/i);
  });

  it("'stop' is treated as cancellation", async () => {
    const state = makeState({
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: { templateType: "newsletter" },
      activeCampaignId: "42",
      userMessage: "stop",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.pendingAiCampaignData).toBeUndefined();
  });
});

// ── Phase 1: AI wizard — unknown step ────────────────────────────────────────

describe("AI wizard — unknown step resets wizard", () => {
  it("unknown step string → resets wizard and returns error", async () => {
    const state = makeState({
      pendingAiCampaignStep: "some_unknown_step",
      pendingAiCampaignData: { templateType: "promotional" },
      activeCampaignId: "42",
      userMessage: "anything",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.pendingAiCampaignData).toBeUndefined();
    expect(patch.error).toMatch(/AI campaign wizard/i);
  });
});

// ── Phase 1: AI wizard — routing override regression tests ───────────────────
// These tests guard against the bug where wizard turns were intercepted by the
// planner or misrouted by the manager when the intent was classified as
// template_help / create_campaign / etc. instead of create_ai_campaign.

describe("AI wizard — wizard state overrides any intent classification", () => {
  it("'template_help' intent with active wizard continues wizard (not template_help flow)", async () => {
    // Simulates user typing "Choose template" during campaign_subject step —
    // OpenAI would classify this as template_help, but wizard must take priority.
    const state = makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Summer Sale" },
      intent: "template_help",
      userMessage: "Choose template",
    });
    const patch = await campaignAgent.handle(state);

    // Wizard handles it: saves "Choose template" as subject, advances to template_selection
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
    expect(patch.pendingAiCampaignData?.subject).toBe("Choose template");
    expect(patch.toolName).toBeUndefined();
  });

  it("'create_campaign' intent with active wizard continues wizard (not fresh create flow)", async () => {
    // Simulates user typing "Summer Sale Campaign" during campaign_name step —
    // OpenAI would classify this as create_campaign, but wizard must take priority.
    const state = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      intent: "create_campaign",
      userMessage: "Summer Sale Campaign",
    });
    const patch = await campaignAgent.handle(state);

    // Wizard handles it: saves name, advances to campaign_subject, NO tool call
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(patch.pendingAiCampaignData?.campaignName).toBe("Summer Sale Campaign");
    expect(patch.toolName).toBeUndefined();
  });

  it("'template_selection' step with input '1' selects Promotional (not treated as subject)", async () => {
    // Guards the specific corruption case: "1" must pick a template at template_selection,
    // never be saved as a subject value.
    const state = makeState({
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: { campaignName: "Summer Sale", subject: "Exclusive 50% Off" },
      intent: "general_help",
      userMessage: "1",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("campaign_body");
    expect(patch.pendingAiCampaignData?.templateType).toBe("promotional");
    // Subject must NOT have been overwritten
    expect(patch.pendingAiCampaignData?.subject).toBe("Exclusive 50% Off");
    expect(patch.toolName).toBeUndefined();
  });

  it("campaign_subject step does NOT dispatch create_campaign (regression guard)", async () => {
    // The original bug: campaign_subject fired create_campaign prematurely.
    const state = makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Summer Sale 2024" },
      intent: "create_campaign",
      userMessage: "Exclusive 50% Off",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
  });

  it("campaign_body confirm with all fields dispatches create_campaign exactly once", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: {
        campaignName: "Summer Sale 2024",
        subject: "Exclusive 50% Off",
        body: "Hi {{name}}, great deal inside!",
      },
      intent: "create_campaign",
      userMessage: "confirm",
    });
    const patch = await campaignAgent.handle(state);

    // confirm on the body shows the summary first — nothing is created yet (bug A-04)
    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("confirm_create");

    const created = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "confirm_create",
      pendingAiCampaignData: patch.pendingAiCampaignData!,
      intent: "create_campaign",
      userMessage: "create",
    }));
    expect(created.toolName).toBe("create_campaign");
    expect(created.toolArgs).toMatchObject({
      name:    "Summer Sale 2024",
      subject: "Exclusive 50% Off",
      body:    "<p>Hi {name}, great deal inside!</p>",
    });
    expect(created.pendingAiCampaignStep).toBe("recipient_source");
  });
});

// ── Phase 1: generate_personalized_emails intent ──────────────────────────────

describe("generate_personalized_emails intent (standalone, not via wizard)", () => {
  it("starts the agent's own flow (asks the campaign) even with an active campaign — the backend has no generation endpoint", async () => {
    mockStartPersonalize.mockResolvedValueOnce({ campaignCreation: { step: "pick_campaign", kind: "personalize", atIso: "" } });
    const state = makeState({
      intent: "generate_personalized_emails",
      activeCampaignId: "42",
    });
    const patch = await campaignAgent.handle(state);

    expect(mockStartPersonalize).toHaveBeenCalledWith(state);
    expect(patch.campaignCreation).toMatchObject({ step: "pick_campaign", kind: "personalize" });
    expect(patch.toolName).toBeUndefined();
  });

  it("'regenerate personalized emails' uses the agent's own writer for the active campaign (never the dead tool)", async () => {
    mockStartPersonalizeFor.mockResolvedValueOnce({ campaignCreation: { step: "p_mode", kind: "personalize", atIso: "" } });
    const state = makeState({
      intent: "regenerate_personalized_emails",
      activeCampaignId: "42",
      userMessage: "regenerate with founder tone and remove breakup email",
    });
    const patch = await campaignAgent.handle(state);

    expect(mockStartPersonalizeFor).toHaveBeenCalledWith(state, expect.objectContaining({ id: "42" }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.campaignCreation).toMatchObject({ step: "p_mode" });
  });

  it("no activeCampaignId → the same flow (it lists every campaign to pick from)", async () => {
    mockStartPersonalize.mockResolvedValueOnce({ campaignCreation: { step: "pick_campaign", kind: "personalize", atIso: "" } });
    const state = makeState({
      intent: "generate_personalized_emails",
      activeCampaignId: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.campaignCreation).toMatchObject({ step: "pick_campaign" });
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("picking from the list generates for that campaign", async () => {
    const state = makeState({
      intent: "general_help",
      userMessage: "2",
      pendingCampaignAction: "generate_personalized_emails",
      campaignSelectionList: [
        { id: "7", name: "Alpha", status: "draft" },
        { id: "9", name: "Beta", status: "draft" },
      ],
    });
    mockStartPersonalizeFor.mockResolvedValueOnce({ campaignCreation: { step: "p_mode", kind: "personalize", atIso: "" } });
    const patch = await campaignAgent.handle(state);

    // The agent's own writer for that campaign — the old generate tool's backend route does not exist (bug B19-09).
    expect(patch.toolName).toBeUndefined();
    expect(mockStartPersonalizeFor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "9", name: "Beta" }));
    expect(patch.activeCampaignId).toBe("9");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("'pause campaign id 17' picks by id; a paused campaign gets a reason, not 'didn't catch that'", async () => {
    const list = [
      { id: "17", name: "Damo", status: "paused" },
      { id: "21", name: "Live One", status: "running" },
    ];
    const byId = await campaignAgent.handle(makeState({ intent: "pause_campaign", userMessage: "pause campaign id 21", pendingCampaignAction: "pause_campaign", campaignSelectionList: list }));
    expect(byId.toolName).toBe("pause_campaign");
    expect(byId.toolArgs).toEqual({ campaignId: "21" });

    const blocked = await campaignAgent.handle(makeState({ intent: "pause_campaign", userMessage: "pause campaign id 17", pendingCampaignAction: "pause_campaign", campaignSelectionList: list }));
    expect(blocked.toolName).toBeUndefined();
    expect(String(blocked.error)).toContain("**Damo** (#17) is paused.");
    expect(String(blocked.error)).not.toContain("didn't catch that");

    // A bare number is still the position in the list shown (1 = Live One).
    const pos = await campaignAgent.handle(makeState({ intent: "general_help", userMessage: "1", pendingCampaignAction: "pause_campaign", campaignSelectionList: list }));
    expect(pos.toolArgs).toEqual({ campaignId: "21" });
  });

  it("wizard continuation takes priority over generate_personalized_emails intent", async () => {
    // If pendingAiCampaignStep is set, the wizard continuation runs regardless of intent.
    const state = makeState({
      intent: "generate_personalized_emails",
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Summer Sale" },
      activeCampaignId: "42",
      userMessage: "Big deals inside",
    });
    const patch = await campaignAgent.handle(state);

    // Wizard continues — the subject is taken; the personalize flow is not started
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
    expect(mockStartPersonalize).not.toHaveBeenCalled();
    expect(patch.toolName).toBeUndefined();
  });
});

describe("review_personalized_emails intent", () => {
  it("dispatches get_personalized_emails for the active campaign", async () => {
    const state = makeState({
      intent: "review_personalized_emails",
      activeCampaignId: "42",
      userMessage: "review sequence",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_personalized_emails");
    expect(patch.toolArgs).toEqual({ campaignId: "42", limit: 3 });
  });
});

// ── Phase 1: full wizard happy path (step-by-step dispatch check) ─────────────

describe("AI wizard — full happy-path dispatch sequence", () => {
  it("complete wizard produces correct tool dispatches in order", async () => {
    // 1. Entry → campaign_name
    const s0 = makeState({ intent: "create_ai_campaign", userMessage: "ai campaign" });
    const p0 = await campaignAgent.handle(s0);
    expect(p0.pendingAiCampaignStep).toBe("campaign_name");

    // 2. campaign_name → campaign_subject
    const s1 = makeState({
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
      userMessage: "Summer Sale 2024",
    });
    const p1 = await campaignAgent.handle(s1);
    expect(p1.pendingAiCampaignStep).toBe("campaign_subject");
    expect(p1.pendingAiCampaignData?.campaignName).toBe("Summer Sale 2024");

    // 3. campaign_subject → saves subject, advances to template_selection (NO tool call)
    const s2 = makeState({
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: p1.pendingAiCampaignData!,
      userMessage: "Big Deals Inside",
    });
    const p2 = await campaignAgent.handle(s2);
    expect(p2.toolName).toBeUndefined();
    expect(p2.pendingAiCampaignStep).toBe("template_selection");
    expect(p2.pendingAiCampaignData?.subject).toBe("Big Deals Inside");

    // 4. template_selection → generates body draft, advances to campaign_body (NO tool call)
    const s3 = makeState({
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: p2.pendingAiCampaignData!,
      userMessage: "1",
    });
    const p3 = await campaignAgent.handle(s3);
    expect(p3.toolName).toBeUndefined();
    expect(p3.pendingAiCampaignStep).toBe("campaign_body");
    expect(p3.pendingAiCampaignData?.templateType).toBe("promotional");
    expect(typeof p3.pendingAiCampaignData?.body).toBe("string");

    // 5. campaign_body → confirm → summary (no tool) → create → dispatches create_campaign
    const s4a = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: p3.pendingAiCampaignData!,
      userMessage: "confirm",
    });
    const p4a = await campaignAgent.handle(s4a);
    expect(p4a.toolName).toBeUndefined();
    expect(p4a.pendingAiCampaignStep).toBe("confirm_create");

    const s4 = makeState({
      pendingAiCampaignStep: "confirm_create",
      pendingAiCampaignData: p4a.pendingAiCampaignData!,
      userMessage: "create",
    });
    const p4 = await campaignAgent.handle(s4);
    expect(p4.toolName).toBe("create_campaign");
    expect(p4.pendingAiCampaignStep).toBe("recipient_source");
    expect((p4.toolArgs as Record<string, unknown>)?.name).toBe("Summer Sale 2024");
    expect((p4.toolArgs as Record<string, unknown>)?.subject).toBe("Big Deals Inside");
    expect(typeof (p4.toolArgs as Record<string, unknown>)?.body).toBe("string");

    // 6. "done" → the recipients are counted; with 30 the wizard ends with start / schedule / personalize
    mockDispatch.mockResolvedValue({ isToolError: false, data: { success: true, data: { campaignId: 10, pendingCount: 30, totalCount: 30 } } });
    const p6 = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: p4.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "done",
      rawToken: "t",
      userId: "u1" as never,
    }));
    expect(p6.toolName).toBeUndefined();
    expect(p6.pendingAiCampaignStep).toBeUndefined();
    expect(p6.error).toContain("**Summer Sale 2024** has **30** recipients");
  });
});

// ── Context persistence — explicit campaign ID ────────────────────────────────

describe("CampaignAgent — explicit campaign ID from user message", () => {
  it("'I am working on campaign ID: 6' sets activeCampaignId = '6'", async () => {
    const state = makeState({
      intent:      "general_help",
      userMessage: "I am working on campaign 'Summer Sales' (ID: 6)",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("6");
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/\*\*#6\*\*/);
  });

  it("'use campaign ID 42' sets activeCampaignId = '42'", async () => {
    const state = makeState({
      intent:      "general_help",
      userMessage: "use campaign ID 42",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("42");
    expect(patch.toolName).toBeUndefined();
  });

  it("'select campaign 10' sets activeCampaignId = '10'", async () => {
    const state = makeState({
      intent:      "general_help",
      userMessage: "select campaign 10",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("10");
  });

  it("explicit ID does NOT fire when AI wizard is active", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "working on campaign ID: 6",
      pendingAiCampaignStep: "campaign_name",
      pendingAiCampaignData: {},
    });
    const patch = await campaignAgent.handle(state);

    // Wizard should handle it, not the explicit ID handler
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(patch.activeCampaignId).toBeUndefined();
  });
});

// ── Context persistence — campaign selection from prior list ──────────────────

describe("CampaignAgent — campaign selection from prior list (no pendingCampaignAction)", () => {
  const LIST = [
    { id: "1", name: "Summer Sale 2024", status: "draft" },
    { id: "2", name: "Newsletter June",  status: "running" },
    { id: "3", name: "Product Launch",   status: "paused" },
  ];

  it("'1' after list → sets activeCampaignId to first campaign's id", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "1",
      campaignSelectionList: LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("1");
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/Summer Sale 2024/);
    expect(patch.campaignSelectionList).toBeUndefined();
  });

  it("'2' after list → selects second campaign", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "2",
      campaignSelectionList: LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("2");
    expect(patch.error).toMatch(/Newsletter June/);
  });

  it("campaign name match → selects by name", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "product launch",
      campaignSelectionList: LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("3");
  });

  it("no match → does NOT set activeCampaignId (falls through to contextual fallback)", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "completely unrelated message xyz",
      campaignSelectionList: LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBeUndefined();
  });

  it("does not fire when pendingCampaignAction is set (handled by existing selection)", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "1",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: LIST,
    });
    const patch = await campaignAgent.handle(state);

    // handleCampaignSelection handles this — dispatches start_campaign tool
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toMatchObject({ campaignId: "1" });
  });
});

// ── Context persistence — contextual fallback with activeCampaignId ───────────

describe("CampaignAgent — contextual fallback when activeCampaignId is set", () => {
  it("general_help + activeCampaignId → contextual options (no generic capability card)", async () => {
    const state = makeState({
      intent:           "general_help",
      userMessage:      "done",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/campaign \*\*#6\*\*/);
    expect(patch.error).toMatch(/Schedule|Start|View stats/);
    // Must NOT be the generic capability card phrasing
    expect(patch.error).not.toMatch(/I can help with campaigns, recipients/);
  });

  it("out_of_domain + activeCampaignId → contextual options", async () => {
    const state = makeState({
      intent:           "out_of_domain",
      userMessage:      "what time is it",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).toMatch(/campaign \*\*#6\*\*/);
  });

  it("next_step_help + activeCampaignId → contextual options", async () => {
    const state = makeState({
      intent:           "next_step_help",
      userMessage:      "what next?",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).toMatch(/campaign \*\*#6\*\*/);
  });

  it("schedule_campaign + activeCampaignId → a real schedule for that campaign (not the options menu)", async () => {
    mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2099-01-05 10:00" });
    const patch = await campaignAgent.handle(makeState({
      intent:           "schedule_campaign",
      userMessage:      "schedule for tomorrow at 10 AM",
      activeCampaignId: "6",
      llmExtractedArgs: { campaignId: "6" },
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "6", scheduledAt: "2099-01-05T05:00:00.000Z" });
    expect(String(patch.error ?? "")).not.toMatch(/You're currently working on campaign/);
  });

  it("general_help + activeCampaignId + a send time ('tomorrow 10 AM') → that campaign is scheduled, not the menu", async () => {
    mockCompleteJson.mockResolvedValue({ status: "scheduled", local: "2099-01-05 10:00" });
    const patch = await campaignAgent.handle(makeState({
      intent:           "general_help",
      userMessage:      "tomorrow 10 AM for 2 hours",
      activeCampaignId: "6",
    }));
    expect(patch.toolName).toBe("update_campaign");
    expect(patch.intent).toBe("schedule_campaign");
    expect(String(patch.error ?? "")).not.toMatch(/I can help with campaigns, recipients/);
  });
});

// ── CSV upload — parse preview ────────────────────────────────────────────────

describe("CSV upload — parse preview", () => {
  it("dispatches parse_csv_file when pendingCsvFile is set and no pendingCsvData", async () => {
    const state = makeState({
      intent:          "upload_csv",
      activeCampaignId: "5",
      pendingCsvFile:  { filename: "contacts.csv", fileContent: "bmFtZSxlbWFpbA==" },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("parse_csv_file");
    expect(patch.toolArgs).toMatchObject({
      filename: "contacts.csv",
      fileContent: "bmFtZSxlbWFpbA==",
    });
  });

  it("asks user to upload a CSV when no file and no pending data", async () => {
    const state = makeState({ intent: "upload_csv", activeCampaignId: "5" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.finalResponse ?? patch.error).toMatch(/upload.*CSV|attach.*file/i);
  });
});

// ── CSV upload — confirm save flow ────────────────────────────────────────────

describe("CSV upload — confirm save flow", () => {
  const csvData = {
    totalRows:   3,
    validRows:   3,
    invalidRows: 0,
    columns:     ["email", "name"],
    preview:     [{ email: "a@x.com", name: "Alice" }],
    rows:        [
      { email: "a@x.com", name: "Alice" },
      { email: "b@x.com", name: "Bob" },
      { email: "c@x.com", name: "Carol" },
    ],
  };

  it("dispatches save_csv_recipients with rows when pendingCsvData present and user confirms", async () => {
    const state = makeState({
      intent:           "upload_csv",
      userMessage:      "yes",
      activeCampaignId: "5",
      pendingCsvData:   csvData,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("save_csv_recipients");
    expect(patch.toolArgs).toMatchObject({
      campaignId: "5",
      rows: csvData.rows,
    });
  });

  it("shows discard confirmation when user cancels the pending CSV save", async () => {
    const state = makeState({
      intent:           "upload_csv",
      userMessage:      "discard",
      activeCampaignId: "5",
      pendingCsvData:   csvData,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCsvData).toBeUndefined();
    expect(patch.finalResponse ?? patch.error).toMatch(/discard|cancel/i);
  });

  it("returns an error when save is attempted without activeCampaignId", async () => {
    const state = makeState({
      intent:         "upload_csv",
      userMessage:    "yes",
      pendingCsvData: csvData,
      // no activeCampaignId
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error ?? patch.finalResponse).toMatch(/campaign|which campaign/i);
  });
});

// ── Short campaign names must not hijack ordinary messages ────────────────────
// Regression: an account with a campaign literally named "n" turned every
// subsequent message into a selection, because "show all campaigns" contains
// the letter "n". Re-listing silently answered 'Campaign "n" selected'.

const SHORT_NAME_LIST = [
  { id: "10", name: "n",     status: "draft" },
  { id: "11", name: "ok",    status: "draft" },
  { id: "12", name: "AR",    status: "draft" },
  { id: "13", name: "Noor",  status: "completed" },
];

describe("campaign selection — short names and explicit commands", () => {
  it("re-sending 'Show all campaigns' re-lists instead of selecting campaign 'n'", async () => {
    const state = makeState({
      intent:                "list_campaigns",
      userMessage:           "Show all campaigns",
      campaignSelectionList: SHORT_NAME_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.activeCampaignId).toBeUndefined();
    expect(patch.error ?? "").not.toMatch(/selected/i);
  });

  it("a one-letter name is not matched inside a longer sentence", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "what can I do with these campaigns",
      campaignSelectionList: SHORT_NAME_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).not.toBe("10");
  });

  it("replying with the exact short name still selects it", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "n",
      campaignSelectionList: SHORT_NAME_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("10");
    expect(patch.error).toMatch(/Campaign \*\*"n"\*\* selected/);
  });

  it("numeric selection still works", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "4",
      campaignSelectionList: SHORT_NAME_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("13");
  });

  it("a full name typed on its own still selects, whatever its casing", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "  noor  ",
      campaignSelectionList: SHORT_NAME_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("13");
  });

  it("a long name inside a sentence still selects", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "let's go with Black Friday please",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("3");
  });

  it("a prefix of a long name still selects", async () => {
    const state = makeState({
      intent:                "general_help",
      userMessage:           "summer",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.activeCampaignId).toBe("1");
  });
});

// ── Start / pause / resume: no approval card for a campaign that can't take the action (bugs B19-02, B19-04) ──

describe("start / pause / resume — status and recipients are checked before the approval card", () => {
  const campaigns = (rows: Array<{ id: number; name: string; status: string; recipientCount?: number }>) => ({
    isToolError: false,
    data: { success: true, data: rows },
  });

  it("'Pause a campaign' after looking at a draft: no card for the draft, just 'no running campaigns'", async () => {
    mockDispatch.mockResolvedValue(campaigns([
      { id: 452, name: "QA TEST AGENT DRAFT UI", status: "draft", recipientCount: 0 },
      { id: 10, name: "Old", status: "completed", recipientCount: 5 },
    ]));
    const patch = await campaignAgent.handle(makeState({
      intent: "pause_campaign", userMessage: "Pause a campaign", activeCampaignId: "452", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.requiresApproval).toBeFalsy();
    expect(String(patch.error)).toContain("No running campaigns found to pause");
    expect(String(patch.error)).not.toContain("452");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("same chip with a running campaign: the pick list of running campaigns, not the draft", async () => {
    mockDispatch.mockResolvedValue(campaigns([
      { id: 452, name: "QA TEST AGENT DRAFT UI", status: "draft" },
      { id: 21, name: "Live One", status: "in_progress", recipientCount: 3 },
    ]));
    const patch = await campaignAgent.handle(makeState({
      intent: "pause_campaign", userMessage: "Pause a campaign", activeCampaignId: "452", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.toolName).toBeUndefined();
    expect(String(patch.error)).toContain("Which campaign would you like to pause?");
    expect(String(patch.error)).toContain("Live One");
    expect(String(patch.error)).not.toContain("QA TEST AGENT DRAFT UI");
    expect(patch.pendingCampaignAction).toBe("pause_campaign");
  });

  it("a draft NAMED in the message gets the reason, still no card", async () => {
    mockDispatch.mockResolvedValue(campaigns([{ id: 452, name: "QA TEST AGENT DRAFT UI", status: "draft" }]));
    const patch = await campaignAgent.handle(makeState({
      intent: "pause_campaign", userMessage: "pause campaign 452", activeCampaignId: "452", rawToken: "t", userId: "u1" as never,
    }));
    expect(patch.toolName).toBeUndefined();
    expect(String(patch.error)).toContain("**QA TEST AGENT DRAFT UI** (#452) is **draft** — only running campaigns can be paused.");
  });

  it("starting a draft with 0 recipients (picked from the list): no card, the reason and what to do", async () => {
    mockDispatch.mockResolvedValue(campaigns([
      { id: 450, name: "Ready", status: "draft", recipientCount: 4 },
      { id: 451, name: "QA-TEST Wizard 1511 - do not use", status: "draft", recipientCount: 0 },
    ]));
    const patch = await campaignAgent.handle(makeState({
      intent: "general_help", userMessage: "2", rawToken: "t", userId: "u1" as never,
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: [
        { id: "450", name: "Ready", status: "draft" },
        { id: "451", name: "QA-TEST Wizard 1511 - do not use", status: "draft" },
      ],
    }));
    expect(patch.toolName).toBeUndefined();
    expect(String(patch.error)).toContain("(#451) has **no recipients**");
    expect(String(patch.error)).toContain("upload a CSV");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("a campaign that can take the action still gets its approval card", async () => {
    mockDispatch.mockResolvedValue(campaigns([{ id: 21, name: "Live One", status: "running", recipientCount: 3 }]));
    const pause = await campaignAgent.handle(makeState({ intent: "pause_campaign", userMessage: "Pause a campaign", activeCampaignId: "21", rawToken: "t", userId: "u1" as never }));
    expect(pause.toolName).toBe("pause_campaign");
    expect(pause.toolArgs).toEqual({ campaignId: "21" });

    mockDispatch.mockResolvedValue(campaigns([{ id: 450, name: "Ready", status: "draft", recipientCount: 4 }]));
    const start = await campaignAgent.handle(makeState({ intent: "start_campaign", userMessage: "start campaign 450", rawToken: "t", userId: "u1" as never, llmExtractedArgs: { campaignId: "450" } as never }));
    expect(start.toolName).toBe("start_campaign");
  });

  it("when the campaigns can't be read, the action goes ahead as before (the backend still decides)", async () => {
    const patch = await campaignAgent.handle(makeState({ intent: "pause_campaign", userMessage: "Pause a campaign", activeCampaignId: "21", rawToken: "t", userId: "u1" as never }));
    expect(patch.toolName).toBe("pause_campaign");
  });
});

// ── "Create an AI campaign": the body (bug A-11 retest) ───────────────────────

describe("AI wizard — the email body", () => {
  const data = { campaignName: "QA-TEST AI 1511 - do not use", subject: "QA-TEST monthly update for {first_name}" };

  it("without the AI writer: {first_name}, no subject line pasted in, no markdown", async () => {
    const patch = await campaignAgent.handle(makeState({ pendingAiCampaignStep: "template_selection", pendingAiCampaignData: data, userMessage: "2" }));
    const body = String(patch.pendingAiCampaignData?.body);
    expect(body.startsWith("Hi {first_name},\n")).toBe(true);
    expect(body).not.toContain("{{");
    expect(body).not.toContain("**");
    expect(body).not.toContain(data.subject);
    expect(body).not.toMatch(/We have news and updates to share/);
  });

  it("the AI writes it; a draft that breaks the rules is sent back once with the problems", async () => {
    mockCompleteJson
      .mockResolvedValueOnce({ body: "Hi {{first_name}},\n\n**QA-TEST monthly update for {first_name}**\n\nCheck this out!\n\nBest regards" })
      .mockResolvedValueOnce({
        body: "Hi {first_name},\n\nHere's this month's short update from our team. We've tidied up how new orders are confirmed, so you get a reply the same day instead of waiting.\n\nWe also moved support hours to start an hour earlier, which a few of you asked about last month.\n\nIs there anything you'd like us to cover in the next one?\n\nBest,\nAbdul",
      });
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "template_selection", pendingAiCampaignData: data, userMessage: "newsletter",
      senderDefaults: { fromName: "Abdul" } as never,
    }));
    expect(mockCompleteJson).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(mockCompleteJson.mock.calls[1]![1])) as { feedback: string[] };
    expect(retry.feedback.join(" ")).toMatch(/one pair of curly braces/);
    expect(String(patch.pendingAiCampaignData?.body)).toContain("Here's this month's short update");
  });

  it("the campaign is created with an HTML body that keeps the line breaks and {first_name}", async () => {
    const body = "Hi {first_name},\n\nFirst paragraph.\n\nSecond one?\n\nBest,\nAbdul";
    const patch = await campaignAgent.handle(makeState({
      pendingAiCampaignStep: "confirm_create", pendingAiCampaignData: { ...data, body }, userMessage: "create",
    }));
    expect(patch.toolName).toBe("create_campaign");
    const html = String((patch.toolArgs as Record<string, unknown>).body);
    expect(html).toBe("<p>Hi {first_name},</p><p>First paragraph.</p><p>Second one?</p><p>Best,<br>Abdul</p>");
  });
});

// ── QA batch 15 Nov 2026: editing / deleting / writing from the chat ──────────

describe("update / delete / write-only (QA bugs 8, 11, 13, 14 + delete)", () => {
  const list = (rows: Array<Record<string, unknown>>) => ({ isToolError: false, data: { success: true, data: rows } });
  const C466 = { id: 466, name: "QATEST AI Run C", status: "draft", subject: "Hello C", body: "<p>just a QA test</p>", smtpSettingsId: 1, fromName: "testing", fromEmail: "t@x.com", recipientCount: 0 };
  const auth = { rawToken: "t", userId: "u1" as never };

  it("'change the subject of campaign 466 to Hello C' → card with ONLY 'Hello C' (not the command words)", async () => {
    mockDispatch.mockResolvedValue(list([C466]));
    const patch = await campaignAgent.handle(makeState({ intent: "update_campaign", userMessage: "change the subject of campaign 466 to Hello C", ...auth }));
    expect(patch.toolName).toBe("update_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "466", subject: "Hello C" });
    expect(patch.intent).toBe("update_campaign");
  });

  it("Roman Urdu + comma: the full quoted body is kept and saved as paragraphs", async () => {
    mockDispatch.mockResolvedValue(list([C466]));
    const patch = await campaignAgent.handle(makeState({ intent: "update_campaign", userMessage: "466 ki body change kar do: 'Hi {first_name}, just a QA test, please ignore'", ...auth }));
    expect(patch.toolArgs).toEqual({ campaignId: "466", body: "<p>Hi {first_name}, just a QA test, please ignore</p>" });
  });

  it("a completed campaign gets a plain reason, no raw backend error", async () => {
    mockDispatch.mockResolvedValue(list([{ ...C466, id: 464, status: "completed" }]));
    const patch = await campaignAgent.handle(makeState({ intent: "update_campaign", userMessage: "change the subject of campaign 464 to Hi", ...auth }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toContain("only draft, paused or scheduled campaigns can be edited");
  });

  it("sender name: explains it comes from the email account and offers the other accounts (no fake success)", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_smtp_settings"
        ? { isToolError: false, data: { success: true, data: { accounts: [{ id: 1, fromEmail: "t@x.com", fromName: "testing" }, { id: 2, fromEmail: "noor@x.com", fromName: "Noor" }] } } }
        : list([C466]));
    const patch = await campaignAgent.handle(makeState({ intent: "update_campaign", userMessage: "change the sender name of campaign 466 to QA Bot", ...auth }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toContain("come from the email account");
    expect(patch.error).toContain("1. **noor@x.com** (Noor)");
    expect(patch.pendingCampaignStep).toBe("update_smtp_pick");

    const picked = await campaignAgent.handle(makeState({
      intent: "general_help", userMessage: "1", pendingCampaignDraft: patch.pendingCampaignDraft!, pendingCampaignStep: "update_smtp_pick", ...auth,
    }));
    expect(picked.toolName).toBe("update_campaign");
    expect(picked.toolArgs).toEqual({ campaignId: "466", smtpSettingsId: 2 });
  });

  it("'delete campaign 466' → a delete approval (it opened the update wizard); a running one must be paused first", async () => {
    mockDispatch.mockResolvedValue(list([C466]));
    const del = await campaignAgent.handle(makeState({ intent: "delete_campaign", userMessage: "delete campaign 466", ...auth }));
    expect(del.toolName).toBe("delete_campaign");
    expect(del.toolArgs).toEqual({ campaignId: "466" });

    mockDispatch.mockResolvedValue(list([{ ...C466, status: "in_progress" }]));
    const running = await campaignAgent.handle(makeState({ intent: "delete_campaign", userMessage: "delete campaign 466", ...auth }));
    expect(running.toolName).toBeUndefined();
    expect(running.error).toContain("Pause it first");
  });

  it("'suggest a better subject line for campaign 466' → ideas in the chat; nothing is saved", async () => {
    mockDispatch.mockResolvedValue(list([C466]));
    mockCompleteJson.mockResolvedValue({ subjects: ["Quick question about your test", "A short note on Hello C", "Can I show you this?"] });
    const patch = await campaignAgent.handle(makeState({ intent: "write_email", userMessage: "can you suggest a better subject line for campaign 466?", ...auth }));
    expect(patch.toolName).toBeUndefined();
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("1. Quick question about your test");
    expect(msg).toContain("Nothing was changed in **QATEST AI Run C**");
  });

  it("'write a quick email to announce our launch' → the text in the chat, no campaign created or started", async () => {
    mockCompleteJson.mockResolvedValue({ subject: "Our new product is here", body: "Hi {first_name},\n\nWe just launched something new.\n\nBest," });
    const patch = await campaignAgent.handle(makeState({ intent: "write_email", userMessage: "can you write a quick email to announce our new product launch?", ...auth }));
    expect(patch.toolName).toBeUndefined();
    expect(patch.requiresApproval).toBeFalsy();
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("**Subject:** Our new product is here");
    expect(msg).toContain("Nothing was saved");
  });
});

describe("campaign recipient-list validation", () => {
  it("checks each address of the explicitly named campaign", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      const data = tool === "get_all_campaigns"
        ? [{ id: 453, name: "QA TEST WIZARD AGENT", status: "draft" }]
        : tool === "get_campaign_recipients"
          ? { campaign: { id: "453", name: "QA TEST WIZARD AGENT" }, total: 2, recipients: [{ email: "good@example.com" }, { email: "bad@@example.com" }] }
          : { email: args.email, isValid: args.email === "good@example.com", disposable: false, reason: args.email === "good@example.com" ? "Business domain" : "Invalid email format" };
      return { data: { success: true, data }, isToolError: false };
    });
    const patch = await campaignAgent.handle(makeState({
      intent: "list_campaigns", userMessage: "validate recipients of campaign 453", rawToken: "token", userId: "5",
    }));
    const message = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(mockDispatch).toHaveBeenCalledWith("get_campaign_recipients", { campaignId: "453", limit: 100 }, expect.any(Object));
    expect(message).toContain("1 valid");
    expect(message).toContain("invalid");
  });
});

describe("AI wizard subject help", () => {
  it("suggests three choices and keeps the wizard at the subject step", async () => {
    const patch = await campaignAgent.handle(makeState({
      intent: "create_ai_campaign",
      userMessage: "Can you suggest a good subject line for me?",
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Diwali offer test" },
    }));
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(patch.pendingAiCampaignData?.subjectSuggestions).toContain("A fresh update about Diwali offer test");
    expect(String(patch.error)).toContain("Reply with **1**, **2**, or **3**");
    expect(patch.toolName).toBeUndefined();
  });

  it("uses the selected subject without saving the question as the subject", async () => {
    const patch = await campaignAgent.handle(makeState({
      intent: "create_ai_campaign",
      userMessage: "2",
      pendingAiCampaignStep: "campaign_subject",
      pendingAiCampaignData: { campaignName: "Diwali offer test", subjectSuggestions: "One\nWhat’s new with Diwali offer test?\nThree" },
    }));
    expect(patch.pendingAiCampaignStep).toBe("template_selection");
    expect(String(patch.error)).toContain("What’s new with Diwali offer test?");
  });
});
