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

const { mockGenerateCampaignDraft } = vi.hoisted(() => ({
  mockGenerateCampaignDraft: vi.fn<() => Promise<Record<string, string> | null>>(),
}));

vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () =>
    mockGenerateCampaignDraft.getMockImplementation() !== undefined
      ? { generateCampaignDraft: mockGenerateCampaignDraft }
      : undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

// Import after mock registration so the mock is applied.
import { campaignAgent } from "../CampaignAgent.js";

// Reset the mock before each test so tests don't bleed into each other.
// By default the mock has no implementation → getOpenAIService() returns undefined.
import { beforeEach } from "vitest";
beforeEach(() => { mockGenerateCampaignDraft.mockReset(); });

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

describe("create_campaign — missing required fields → starts wizard", () => {
  it("vague input starts step-by-step wizard, asks for campaign name first", async () => {
    const state = makeState({ intent: "create_campaign", userMessage: "create a new campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.toolArgs).toEqual({});
    expect(patch.error).toBeDefined();
    // Should ask the first step question (name)
    expect(patch.error).toContain("name");
    // Should set pendingCampaignStep to the first missing field
    expect(patch.pendingCampaignStep).toBe("name");
    // Should initialise pendingCampaignDraft
    expect(patch.pendingCampaignDraft).toBeDefined();
  });

  it("'create new email campaign' — no filters — starts wizard", async () => {
    const state = makeState({ intent: "create_campaign", userMessage: "create new email campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
    expect(patch.pendingCampaignDraft).toBeDefined();
  });

  it("partial filters (only name + subject) asks for next missing field", async () => {
    const llmExtractedArgs: LLMIntentArguments = {
      filters: { name: "Summer Sale", subject: "Big Deals" },
    };
    const state = makeState({ intent: "create_campaign", llmExtractedArgs });
    const patch = await campaignAgent.handle(state);

    // body is still missing — wizard should continue
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
    // First missing field after name+subject is body (new FIELD_ORDER)
    expect(patch.pendingCampaignStep).toBe("body");
    // Draft should store already-known fields
    expect(patch.pendingCampaignDraft?.name).toBe("Summer Sale");
    expect(patch.pendingCampaignDraft?.subject).toBe("Big Deals");
  });

  it("wizard prompt does not expose raw error stacks or internal codes", async () => {
    const state = makeState({ intent: "create_campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).not.toMatch(/Error:/);
    expect(patch.error).not.toMatch(/stack/i);
    expect(patch.error).not.toMatch(/-32602/);
  });
});

// ── create_campaign — auto-generation (OpenAI available) ─────────────────────

describe("create_campaign — auto-generation via OpenAI", () => {
  const generatedDraft = {
    name:      "Summer Sale 2024",
    subject:   "Don't Miss Our Summer Savings",
    fromName:  "Your Team",
    fromEmail: "hello@yourcompany.com",
    body:      "We're excited to bring you incredible summer deals this season.",
  };

  it("presents a full draft for confirmation when OpenAI generates all fields", async () => {
    mockGenerateCampaignDraft.mockResolvedValue(generatedDraft);

    const state = makeState({ intent: "create_campaign", userMessage: "Create a campaign for summer sale" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignStep).toBe("confirm");
    expect(patch.pendingCampaignDraft).toMatchObject(generatedDraft);
    expect(patch.error).toContain("confirm");
  });

  it("user-supplied fields override generated ones", async () => {
    mockGenerateCampaignDraft.mockResolvedValue(generatedDraft);

    const state = makeState({
      intent:      "create_campaign",
      userMessage: "create campaign",
      llmExtractedArgs: { filters: { name: "My Custom Name" } },
    });
    const patch = await campaignAgent.handle(state);

    // User-supplied name wins over generated name
    expect(patch.pendingCampaignDraft?.name).toBe("My Custom Name");
    expect(patch.pendingCampaignStep).toBe("confirm");
  });

  it("falls back to step-by-step when OpenAI returns null", async () => {
    mockGenerateCampaignDraft.mockResolvedValue(null);

    const state = makeState({ intent: "create_campaign", userMessage: "create a campaign" });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingCampaignStep).toBe("name");
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

describe("create_campaign — deterministic extraction from userMessage (Gemini unavailable)", () => {
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
      llmExtractedArgs: undefined, // Gemini unavailable
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
    // Gemini extracted name/subject/body via filters — these take priority over
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

  it("returns clarification when message has some but not all fields", async () => {
    const state = makeState({
      intent: "create_campaign",
      // Has name but missing subject and body
      userMessage: "Create a campaign called My Campaign",
      llmExtractedArgs: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
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
  it("pre-populates fromName/fromEmail from saved defaults so user is not asked again", async () => {
    const state = makeState({
      intent:         "create_campaign",
      userMessage:    "create a campaign",
      senderDefaults: { fromName: "Marketing Team", fromEmail: "marketing@example.com" },
    });
    const patch = await campaignAgent.handle(state);

    // Draft should already have fromName and fromEmail from senderDefaults
    expect(patch.pendingCampaignDraft?.fromName).toBe("Marketing Team");
    expect(patch.pendingCampaignDraft?.fromEmail).toBe("marketing@example.com");
    // First field still missing is name, not fromName/fromEmail
    expect(patch.pendingCampaignStep).toBe("name");
  });

  it("fromEmail comes from senderDefaults; LLM filter fromEmail is ignored (not a wizard field)", async () => {
    // fromEmail is no longer collected by the wizard — backend derives it from SMTP.
    // senderDefaults.fromEmail is still stored in the draft for transparency,
    // but LLM-extracted fromEmail (via filters) is ignored by the resolver.
    const state = makeState({
      intent:         "create_campaign",
      userMessage:    "create a campaign",
      senderDefaults: { fromName: "Old Name", fromEmail: "old@example.com" },
      llmExtractedArgs: { filters: { fromEmail: "new@example.com" } },
    });
    const patch = await campaignAgent.handle(state);

    // Draft retains senderDefaults value — LLM filter value is not extracted
    expect(patch.pendingCampaignDraft?.fromEmail).toBe("old@example.com");
  });

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
    // Simulates Gemini extracting a template placeholder instead of a real ID
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
      pendingCampaignAction: "pause_campaign",
      campaignSelectionList: CAMPAIGN_LIST,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("pause_campaign");
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


describe("schedule_campaign — campaign exists (campaignId known)", () => {
  it("returns schedule draft JSON (no backend call) when campaignId is present", async () => {
    const state = makeState({
      intent:           "schedule_campaign",
      userMessage:      "Schedule this campaign for tomorrow at 10 AM",
      activeCampaignId: "42",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("42");
    expect(draft.schedule.status).toBe("draft_not_saved");
  });

  it("returns schedule draft JSON using LLM-extracted campaignId", async () => {
    const state = makeState({
      intent:           "schedule_campaign",
      userMessage:      "Schedule Summer Sale for next Monday at 9 AM",
      llmExtractedArgs: { campaignId: "55" },
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("55");
    expect(draft.schedule.status).toBe("draft_not_saved");
  });

  it("startText is clean when userMessage contains prior-turn context and newlines", async () => {
    // Bug regression: "Show all campaigns\n\nscheduling tomorrow 10 AM" must not
    // bleed "Show all campaigns" into startText.
    const state = makeState({
      intent:           "schedule_campaign",
      userMessage:      "Show all campaigns\n\nscheduling tomorrow 10 AM",
      activeCampaignId: "42",
      llmExtractedArgs: { campaignId: "42" },
    });
    const patch = await campaignAgent.handle(state);

    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.schedule.startText).toBe("tomorrow 10 AM");
    expect(draft.schedule.startText).not.toMatch(/show all campaigns/i);
    expect(draft.schedule.startText).not.toMatch(/\n/);
  });
});

describe("schedule_campaign — multiple campaigns (selection flow)", () => {
  const SCHED_CAMPAIGNS = [
    { id: "1", name: "Summer Sale",  status: "draft" },
    { id: "2", name: "Winter Promo", status: "draft" },
  ];

  it("selecting campaign by number builds schedule draft JSON with stored scheduling text", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "1",
      pendingCampaignAction: "schedule_campaign",
      campaignSelectionList: SCHED_CAMPAIGNS,
      pendingScheduledAt:   "tomorrow at 10 AM for 2 hours",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("1");
    expect(draft.schedule.status).toBe("draft_not_saved");
    expect(draft.schedule.durationMinutes).toBe(120);
    expect(patch.pendingCampaignAction).toBeUndefined();
    expect(patch.campaignSelectionList).toBeUndefined();
    expect(patch.pendingScheduledAt).toBeUndefined();
  });

  it("selecting campaign by name builds schedule draft JSON with stored scheduling text", async () => {
    const state = makeState({
      intent:               "general_help",
      userMessage:          "Winter Promo",
      pendingCampaignAction: "schedule_campaign",
      campaignSelectionList: SCHED_CAMPAIGNS,
      pendingScheduledAt:   "next Monday at 9 AM",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("2");
    expect(draft.schedule.status).toBe("draft_not_saved");
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

  it("confirm → dispatches create_campaign with name+subject+body, advances to recipient_source", async () => {
    const state = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: baseData,
      userMessage: "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.toolArgs).toMatchObject({
      name:    "Summer Sale 2024",
      subject: "Big deals inside",
      body:    baseData.body,
    });
    expect(patch.pendingAiCampaignStep).toBe("recipient_source");
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

describe("AI wizard — recipient_source step", () => {
  const baseData = { campaignName: "Summer Sale", subject: "Big Deals" };

  it("any reply with activeCampaignId → dispatches get_recipient_count, advances to check_count", async () => {
    const state = makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "done",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_recipient_count");
    expect(patch.toolArgs).toMatchObject({ campaignId: "42" });
    expect(patch.pendingAiCampaignStep).toBe("check_count");
  });

  it("'1' → dispatches get_recipient_count (no longer shows upload prompt)", async () => {
    const state = makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "1",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_recipient_count");
    expect(patch.pendingAiCampaignStep).toBe("check_count");
  });

  it("'uploaded' → dispatches get_recipient_count", async () => {
    const state = makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "uploaded",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_recipient_count");
    expect(patch.pendingAiCampaignStep).toBe("check_count");
  });

  it("missing activeCampaignId → error, stays at recipient_source", async () => {
    const state = makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "done",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("recipient_source");
    expect(patch.error).toBeDefined();
  });
});

// ── Phase 1: AI wizard — template step ───────────────────────────────────────

describe("AI wizard — template step", () => {
  it("'1' maps to 'promotional' and advances to tone step", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "1",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("tone");
    expect(patch.pendingAiCampaignData?.templateType).toBe("promotional");
    expect(patch.error).toContain("Tone");
  });

  it("'2' maps to 'newsletter'", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "2",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("tone");
    expect(patch.pendingAiCampaignData?.templateType).toBe("newsletter");
  });

  it("'event' (name) maps to 'event'", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "event",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("tone");
    expect(patch.pendingAiCampaignData?.templateType).toBe("event");
  });

  it("'4' maps to 'announcement'", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "4",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData?.templateType).toBe("announcement");
  });

  it("'follow-up' maps to 'follow_up'", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "follow-up",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData?.templateType).toBe("follow_up");
  });

  it("invalid input re-prompts at template step without advancing", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "something random",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("template");
    expect(patch.error).toContain("1–5");
  });

  it("template data persists into updated pendingAiCampaignData", async () => {
    const state = makeState({
      pendingAiCampaignStep: "template",
      pendingAiCampaignData: {},
      activeCampaignId: "42",
      userMessage: "3",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData).toMatchObject({ templateType: "event" });
  });
});

// ── Phase 1: AI wizard — tone step ────────────────────────────────────────────

describe("AI wizard — tone step", () => {
  const baseData = { templateType: "promotional" };

  it("tone provided → stores toneInstruction and advances to custom_prompt", async () => {
    const state = makeState({
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "friendly and casual",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("custom_prompt");
    expect(patch.pendingAiCampaignData?.toneInstruction).toBe("friendly and casual");
    expect(patch.pendingAiCampaignData?.templateType).toBe("promotional");
    expect(patch.error).toContain("Custom instructions");
  });

  it("'skip' → no toneInstruction stored, advances to custom_prompt", async () => {
    const state = makeState({
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "skip",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignStep).toBe("custom_prompt");
    expect(patch.pendingAiCampaignData?.toneInstruction).toBeUndefined();
    expect(patch.error).toContain("default");
  });

  it("'SKIP' (uppercase) is treated as skip", async () => {
    const state = makeState({
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "SKIP",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData?.toneInstruction).toBeUndefined();
  });
});

// ── Phase 1: AI wizard — custom_prompt step ───────────────────────────────────

describe("AI wizard — custom_prompt step", () => {
  const baseData = { templateType: "promotional", toneInstruction: "friendly" };

  it("custom prompt provided → dispatches save_ai_prompt and advances to generate", async () => {
    const state = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "Mention the 30-day money-back guarantee",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("save_ai_prompt");
    expect(patch.pendingAiCampaignStep).toBe("generate");
    expect(patch.pendingAiCampaignData?.customPrompt).toBe("Mention the 30-day money-back guarantee");
    expect(patch.toolArgs).toEqual({
      campaignId:      "42",
      templateType:    "promotional",
      toneInstruction: "friendly",
      customPrompt:    "Mention the 30-day money-back guarantee",
    });
  });

  it("'skip' → dispatches save_ai_prompt with no customPrompt, advances to generate", async () => {
    const state = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "skip",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("save_ai_prompt");
    expect(patch.pendingAiCampaignStep).toBe("generate");
    expect(patch.pendingAiCampaignData?.customPrompt).toBeUndefined();
    expect((patch.toolArgs as Record<string, unknown>)?.customPrompt).toBeUndefined();
  });

  it("existing data (templateType, toneInstruction) is preserved and included in save_ai_prompt", async () => {
    const state = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "skip",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData?.templateType).toBe("promotional");
    expect(patch.pendingAiCampaignData?.toneInstruction).toBe("friendly");
    expect((patch.toolArgs as Record<string, unknown>)?.templateType).toBe("promotional");
    expect((patch.toolArgs as Record<string, unknown>)?.toneInstruction).toBe("friendly");
  });

  it("no activeCampaignId → resets wizard with error", async () => {
    const state = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "skip",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toBeDefined();
  });

  it("save_ai_prompt args include customPrompt when provided", async () => {
    const state = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "mention guarantee",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("save_ai_prompt");
    expect((patch.toolArgs as Record<string, unknown>)?.customPrompt).toBe("mention guarantee");
  });
});

// ── Phase 1: AI wizard — upload_recipients step ───────────────────────────────

describe("AI wizard — upload_recipients step", () => {
  const baseData = { campaignName: "Summer Sale", campaignSubject: "Big Deals" };

  it("upload confirmed → dispatches get_recipient_count and advances to check_count", async () => {
    const state = makeState({
      pendingAiCampaignStep: "upload_recipients",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "CSV uploaded successfully: 50 recipients added, 0 rejected.",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_recipient_count");
    expect(patch.toolArgs).toEqual({ campaignId: "42" });
    expect(patch.pendingAiCampaignStep).toBe("check_count");
    expect(patch.pendingAiCampaignData).toEqual(baseData);
  });

  it("any message triggers get_recipient_count (wizard does not gate on message content)", async () => {
    const state = makeState({
      pendingAiCampaignStep: "upload_recipients",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "done",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_recipient_count");
    expect(patch.toolArgs).toEqual({ campaignId: "42" });
  });

  it("no activeCampaignId → error, stays at upload_recipients step", async () => {
    const state = makeState({
      pendingAiCampaignStep: "upload_recipients",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "done",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("upload_recipients");
    expect(patch.error).toBeDefined();
  });
});

// ── Phase 1: AI wizard — check_count step ────────────────────────────────────

describe("AI wizard — check_count step", () => {
  const baseData = { campaignName: "Summer Sale", subject: "Big Deals" };

  it("recipientCount > 0 → advances to tone step (no tool dispatch)", async () => {
    const state = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: { ...baseData, recipientCount: "25" },
      activeCampaignId: "42",
      userMessage: "continue",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("tone");
    expect(patch.error).toMatch(/tone/i);
    expect(patch.error).toContain("25");
  });

  it("recipientCount is '0' → error, directs to web UI, returns to upload_recipients step", async () => {
    const state = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: { ...baseData, recipientCount: "0" },
      activeCampaignId: "42",
      userMessage: "continue",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("upload_recipients");
    expect(patch.error).toMatch(/no recipients/i);
    expect(patch.error).toMatch(/web UI/i);
    expect(patch.error).not.toContain("📎");
  });

  it("recipientCount absent → error and returns to upload_recipients step", async () => {
    const state = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "continue",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("upload_recipients");
  });

  it("no activeCampaignId on valid count → resets wizard", async () => {
    const state = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: { ...baseData, recipientCount: "10" },
      activeCampaignId: undefined,
      userMessage: "continue",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toBeDefined();
  });

  it("recipientCount stored in pendingAiCampaignData when advancing to tone", async () => {
    const state = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: { ...baseData, recipientCount: "10" },
      activeCampaignId: "42",
      userMessage: "continue",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.pendingAiCampaignData?.recipientCount).toBe("10");
  });
});

// ── Phase 1: AI wizard — generate step ───────────────────────────────────────

describe("AI wizard — generate step", () => {
  const baseData = { templateType: "promotional", recipientCount: "25" };

  it("dispatches generate_personalized_emails and advances to review", async () => {
    const state = makeState({
      pendingAiCampaignStep: "generate",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("generate_personalized_emails");
    expect(patch.toolArgs).toEqual({ campaignId: "42", mode: "low_promotional_plaintext" });
    expect(patch.pendingAiCampaignStep).toBe("review");
  });

  it("no activeCampaignId → resets wizard", async () => {
    const state = makeState({
      pendingAiCampaignStep: "generate",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
});

// ── Phase 1: AI wizard — review step ─────────────────────────────────────────

describe("AI wizard — review step", () => {
  const baseData = { templateType: "promotional", recipientCount: "25" };

  it("dispatches get_personalized_emails with limit 3 and advances to approve", async () => {
    const state = makeState({
      pendingAiCampaignStep: "review",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("get_personalized_emails");
    expect(patch.toolArgs).toEqual({ campaignId: "42", limit: 3 });
    expect(patch.pendingAiCampaignStep).toBe("approve");
  });

  it("no activeCampaignId → resets wizard", async () => {
    const state = makeState({
      pendingAiCampaignStep: "review",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
});

// ── Phase 1: AI wizard — approve step ────────────────────────────────────────

describe("AI wizard — approve step", () => {
  const baseData = { templateType: "promotional", recipientCount: "25" };

  it("'yes' → dispatches start_campaign, clears wizard, sets requiresApproval", async () => {
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "yes",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "42" });
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.pendingAiCampaignData).toBeUndefined();
    expect(patch.requiresApproval).toBe(true);
  });

  it("'confirm' → dispatches start_campaign", async () => {
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "confirm",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
    expect(patch.requiresApproval).toBe(true);
  });

  it("'go ahead' → dispatches start_campaign", async () => {
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "go ahead",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("start_campaign");
  });

  it("scheduledAt in data → dispatches update_campaign instead of start_campaign", async () => {
    const scheduledAt = "2026-06-01T09:00:00Z";
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: { ...baseData, scheduledAt },
      activeCampaignId: "42",
      userMessage: "yes",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("update_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "42", scheduledAt });
    expect(patch.intent).toBe("schedule_campaign");
    expect(patch.requiresApproval).toBe(true);
    expect(patch.pendingAiCampaignStep).toBeUndefined();
  });

  it("unclear response → re-prompts with confirm/cancel, stays at approve", async () => {
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: baseData,
      activeCampaignId: "42",
      userMessage: "hmm, maybe",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBe("approve");
    expect(patch.error).toContain("confirm");
    expect(patch.error).toContain("cancel");
  });

  it("no activeCampaignId on confirmation → resets wizard", async () => {
    const state = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: baseData,
      activeCampaignId: undefined,
      userMessage: "yes",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(patch.error).toBeDefined();
  });
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
    // Gemini would classify this as template_help, but wizard must take priority.
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
    // Gemini would classify this as create_campaign, but wizard must take priority.
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

    expect(patch.toolName).toBe("create_campaign");
    expect(patch.toolArgs).toMatchObject({
      name:    "Summer Sale 2024",
      subject: "Exclusive 50% Off",
      body:    "Hi {{name}}, great deal inside!",
    });
    expect(patch.pendingAiCampaignStep).toBe("recipient_source");
  });
});

// ── Phase 1: generate_personalized_emails intent ──────────────────────────────

describe("generate_personalized_emails intent (standalone, not via wizard)", () => {
  it("with activeCampaignId → dispatches generate_personalized_emails tool", async () => {
    const state = makeState({
      intent: "generate_personalized_emails",
      activeCampaignId: "42",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("generate_personalized_emails");
    expect(patch.toolArgs).toEqual({ campaignId: "42", mode: "low_promotional_plaintext" });
    expect(patch.error).toBeUndefined();
  });

  it("parses regeneration modifiers like founder tone and shortened sequence", async () => {
    const state = makeState({
      intent: "regenerate_personalized_emails",
      activeCampaignId: "42",
      userMessage: "regenerate with founder tone and remove breakup email",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBe("generate_personalized_emails");
    expect(patch.toolArgs).toEqual({
      campaignId: "42",
      overwrite: true,
      mode: "low_promotional_plaintext",
      tone: "founder_style",
      removeBreakupEmail: true,
    });
  });

  it("no activeCampaignId → error without dispatching tool", async () => {
    const state = makeState({
      intent: "generate_personalized_emails",
      activeCampaignId: undefined,
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toBeDefined();
    expect(patch.error).toMatch(/campaign/i);
  });

  it("wizard continuation takes priority over generate_personalized_emails intent", async () => {
    // If pendingAiCampaignStep is set, the wizard continuation runs regardless of intent.
    const state = makeState({
      intent: "generate_personalized_emails",
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: { templateType: "promotional" },
      activeCampaignId: "42",
      userMessage: "professional",
    });
    const patch = await campaignAgent.handle(state);

    // Wizard continues — moves to custom_prompt step, does NOT dispatch generate tool
    expect(patch.pendingAiCampaignStep).toBe("custom_prompt");
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

    // 5. campaign_body → confirm → dispatches create_campaign, advances to recipient_source
    const s4 = makeState({
      pendingAiCampaignStep: "campaign_body",
      pendingAiCampaignData: p3.pendingAiCampaignData!,
      userMessage: "confirm",
    });
    const p4 = await campaignAgent.handle(s4);
    expect(p4.toolName).toBe("create_campaign");
    expect(p4.pendingAiCampaignStep).toBe("recipient_source");
    expect((p4.toolArgs as Record<string, unknown>)?.name).toBe("Summer Sale 2024");
    expect((p4.toolArgs as Record<string, unknown>)?.subject).toBe("Big Deals Inside");
    expect(typeof (p4.toolArgs as Record<string, unknown>)?.body).toBe("string");

    // 6. recipient_source → dispatches get_recipient_count, advances to check_count
    const s5 = makeState({
      pendingAiCampaignStep: "recipient_source",
      pendingAiCampaignData: p4.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "done",
    });
    const p5 = await campaignAgent.handle(s5);
    expect(p5.toolName).toBe("get_recipient_count");
    expect(p5.toolArgs).toMatchObject({ campaignId: "10" });
    expect(p5.pendingAiCampaignStep).toBe("check_count");

    // 7. check_count → tone (recipients found)
    const s6 = makeState({
      pendingAiCampaignStep: "check_count",
      pendingAiCampaignData: { ...p5.pendingAiCampaignData!, recipientCount: "30" },
      activeCampaignId: "10",
      userMessage: "continue",
    });
    const p6 = await campaignAgent.handle(s6);
    expect(p6.toolName).toBeUndefined();
    expect(p6.pendingAiCampaignStep).toBe("tone");

    // 8. tone → custom_prompt (skip)
    const s7 = makeState({
      pendingAiCampaignStep: "tone",
      pendingAiCampaignData: p6.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "skip",
    });
    const p7 = await campaignAgent.handle(s7);
    expect(p7.pendingAiCampaignStep).toBe("custom_prompt");

    // 9. custom_prompt → dispatches save_ai_prompt, advances to generate (skip)
    const s8 = makeState({
      pendingAiCampaignStep: "custom_prompt",
      pendingAiCampaignData: p7.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "skip",
    });
    const p8 = await campaignAgent.handle(s8);
    expect(p8.toolName).toBe("save_ai_prompt");
    expect(p8.pendingAiCampaignStep).toBe("generate");

    // 10. generate → generate_personalized_emails
    const s9 = makeState({
      pendingAiCampaignStep: "generate",
      pendingAiCampaignData: p8.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "",
    });
    const p9 = await campaignAgent.handle(s9);
    expect(p9.toolName).toBe("generate_personalized_emails");
    expect(p9.pendingAiCampaignStep).toBe("review");

    // 11. review → get_personalized_emails
    const s10 = makeState({
      pendingAiCampaignStep: "review",
      pendingAiCampaignData: p9.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "",
    });
    const p10 = await campaignAgent.handle(s10);
    expect(p10.toolName).toBe("get_personalized_emails");
    expect(p10.pendingAiCampaignStep).toBe("approve");

    // 12. approve → start_campaign
    const s11 = makeState({
      pendingAiCampaignStep: "approve",
      pendingAiCampaignData: p10.pendingAiCampaignData!,
      activeCampaignId: "10",
      userMessage: "confirm",
    });
    const p11 = await campaignAgent.handle(s11);
    expect(p11.toolName).toBe("start_campaign");
    expect(p11.requiresApproval).toBe(true);
    expect(p11.pendingAiCampaignStep).toBeUndefined();
    expect(p11.pendingAiCampaignData).toBeUndefined();
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

  it("schedule_campaign + activeCampaignId returns schedule draft JSON (not contextual fallback)", async () => {
    const state = makeState({
      intent:           "schedule_campaign",
      userMessage:      "schedule for tomorrow at 10 AM",
      activeCampaignId: "6",
      llmExtractedArgs: { campaignId: "6" },
    });
    const patch = await campaignAgent.handle(state);

    // Should produce a schedule draft, not the contextual fallback options menu
    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    expect(patch.error).not.toMatch(/You're currently working on campaign/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("6");
    expect(draft.schedule.status).toBe("draft_not_saved");
  });

  it("general_help + activeCampaignId + 'tomorrow 10 AM for 2 hours' — returns schedule draft JSON, not options menu", async () => {
    const state = makeState({
      intent:           "general_help",
      userMessage:      "tomorrow 10 AM for 2 hours",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    expect(patch.error).not.toMatch(/You're currently working on campaign/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("6");
    expect(draft.schedule.durationMinutes).toBe(120);
    expect(draft.schedule.status).toBe("draft_not_saved");
  });

  it("general_help + activeCampaignId + 'monday 10 am 2 hours' — returns schedule draft JSON", async () => {
    const state = makeState({
      intent:           "general_help",
      userMessage:      "monday 10 am 2 hours",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.toolName).toBeUndefined();
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
    const jsonMatch = patch.error!.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).not.toBeNull();
    const draft = JSON.parse(jsonMatch![1]);
    expect(draft.campaignId).toBe("6");
    expect(draft.schedule.durationMinutes).toBe(120);
    expect(draft.schedule.status).toBe("draft_not_saved");
  });

  it("schedule draft flow does not produce generic help response when activeCampaignId is set", async () => {
    // A "schedule" keyword message with activeCampaignId should never hit the
    // generic fallback "I can help with campaigns, recipients..." card.
    const state = makeState({
      intent:           "general_help",
      userMessage:      "schedule for tomorrow",
      activeCampaignId: "6",
    });
    const patch = await campaignAgent.handle(state);

    expect(patch.error).not.toMatch(/I can help with campaigns, recipients/);
    expect(patch.error).toMatch(/This schedule has been prepared as JSON only/);
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
