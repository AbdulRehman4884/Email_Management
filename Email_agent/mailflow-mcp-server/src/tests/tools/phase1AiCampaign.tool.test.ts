/**
 * src/tests/tools/phase1AiCampaign.tool.test.ts
 *
 * Tests for Phase 1 AI Campaign tools:
 *   - getAllCampaignsTool
 *   - getRecipientCountTool
 *   - saveAiPromptTool
 *   - generatePersonalizedEmailsTool
 *   - getPersonalizedEmailsTool
 *
 * Each tool is tested for:
 *   1. Happy path — correct API call + success result
 *   2. Correct args forwarded
 *   3. Error propagation — 404 and 500
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getAllCampaignsTool } from "../../mcp/tools/campaign/getAllCampaigns.tool.js";
import { getRecipientCountTool } from "../../mcp/tools/campaign/getRecipientCount.tool.js";
import { saveAiPromptTool } from "../../mcp/tools/campaign/saveAiPrompt.tool.js";
import { generatePersonalizedEmailsTool } from "../../mcp/tools/campaign/generatePersonalizedEmails.tool.js";
import { getPersonalizedEmailsTool } from "../../mcp/tools/campaign/getPersonalizedEmails.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import { MailFlowApiError, ErrorCode } from "../../lib/errors.js";
import { TOOL_NAMES } from "../../config/constants.js";
import type { Campaign, RecipientCountResult, AiPromptSaveResult, PersonalizedEmailGenerationResult, PersonalizedEmailsResult } from "../../types/mailflow.js";
import type { CampaignId, ISODateString } from "../../types/common.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = "7";

const DRAFT_CAMPAIGN: Campaign = {
  id:           CAMPAIGN_ID as CampaignId,
  name:         "Summer Promo",
  subject:      "Big summer deals inside",
  fromName:     "Marketing",
  fromEmail:    "marketing@example.com",
  replyToEmail: null,
  bodyFormat:   "html",
  body:         "<p>Hello!</p>",
  status:       "draft",
  scheduledAt:  null,
  startedAt:    null,
  pausedAt:     null,
  completedAt:  null,
  createdAt:    "2025-01-01T00:00:00Z" as ISODateString,
  updatedAt:    "2025-01-01T00:00:00Z" as ISODateString,
};

const ANOTHER_CAMPAIGN: Campaign = {
  ...DRAFT_CAMPAIGN,
  id:     "8" as CampaignId,
  name:   "Newsletter Q3",
  status: "running",
};

const RECIPIENT_COUNT_RESULT: RecipientCountResult = {
  campaignId:   7,
  pendingCount: 120,
  totalCount:   150,
};

const AI_PROMPT_SAVE_RESULT: AiPromptSaveResult = {
  message:    "AI prompt configuration saved",
  campaignId: 7,
};

const GENERATION_RESULT: PersonalizedEmailGenerationResult = {
  message:          "Personalized email generation complete",
  campaignId:       7,
  totalRecipients:  150,
  generatedCount:   148,
  failedCount:      2,
};

/** Empty result used to make the guard in generatePersonalizedEmailsTool pass through */
const NO_EXISTING_EMAILS: PersonalizedEmailsResult = { campaignId: 7, total: 0, emails: [] };

const PERSONALIZED_EMAILS_RESULT: PersonalizedEmailsResult = {
  campaignId: 7,
  total:      148,
  emails: [
    {
      id:                  1,
      recipientId:         10,
      personalizedSubject: null,
      personalizedBody:    "<p>Hi Alice, check out our deals!</p>",
      generationStatus:    "generated",
      recipientEmail:      "alice@example.com",
      recipientName:       "Alice",
    },
    {
      id:                  2,
      recipientId:         11,
      personalizedSubject: null,
      personalizedBody:    "<p>Hi Bob, here are our offers!</p>",
      generationStatus:    "generated",
      recipientEmail:      "bob@example.com",
      recipientName:       "Bob",
    },
  ],
};

// ── getAllCampaignsTool ────────────────────────────────────────────────────────

describe("getAllCampaignsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has the correct tool name", () => {
    expect(getAllCampaignsTool.name).toBe(TOOL_NAMES.GET_ALL_CAMPAIGNS);
  });

  it("returns all campaigns on success", async () => {
    const getAllCampaigns = vi.fn().mockResolvedValue([DRAFT_CAMPAIGN, ANOTHER_CAMPAIGN]);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getAllCampaigns }),
    });

    const result = await getAllCampaignsTool.handler({}, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe("Summer Promo");
      expect(result.data[1]!.name).toBe("Newsletter Q3");
    }
  });

  it("calls mailflow.getAllCampaigns exactly once", async () => {
    const getAllCampaigns = vi.fn().mockResolvedValue([DRAFT_CAMPAIGN]);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getAllCampaigns }),
    });

    await getAllCampaignsTool.handler({}, context);

    expect(getAllCampaigns).toHaveBeenCalledOnce();
  });

  it("returns empty array when user has no campaigns", async () => {
    const getAllCampaigns = vi.fn().mockResolvedValue([]);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getAllCampaigns }),
    });

    const result = await getAllCampaignsTool.handler({}, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([]);
    }
  });

  it("500 error → toolFailure with MAILFLOW_API_ERROR", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getAllCampaigns: vi.fn().mockRejectedValue(
          new MailFlowApiError(500, "Internal server error"),
        ),
      }),
    });

    const result = await getAllCampaignsTool.handler({}, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_API_ERROR);
    }
  });
});

// ── getRecipientCountTool ─────────────────────────────────────────────────────

describe("getRecipientCountTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  const validInput = { campaignId: CAMPAIGN_ID };

  it("has the correct tool name", () => {
    expect(getRecipientCountTool.name).toBe(TOOL_NAMES.GET_RECIPIENT_COUNT);
  });

  it("returns pending and total recipient counts", async () => {
    const getRecipientCount = vi.fn().mockResolvedValue(RECIPIENT_COUNT_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getRecipientCount }),
    });

    const result = await getRecipientCountTool.handler(validInput, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingCount).toBe(120);
      expect(result.data.totalCount).toBe(150);
      expect(result.data.campaignId).toBe(7);
    }
  });

  it("forwards the campaignId correctly", async () => {
    const getRecipientCount = vi.fn().mockResolvedValue(RECIPIENT_COUNT_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getRecipientCount }),
    });

    await getRecipientCountTool.handler(validInput, context);

    expect(getRecipientCount).toHaveBeenCalledOnce();
    expect(getRecipientCount).toHaveBeenCalledWith(CAMPAIGN_ID);
  });

  it("404 not found → toolFailure with MAILFLOW_NOT_FOUND", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getRecipientCount: vi.fn().mockRejectedValue(
          new MailFlowApiError(404, "Campaign not found"),
        ),
      }),
    });

    const result = await getRecipientCountTool.handler(validInput, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    }
  });

  it("500 error → toolFailure", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getRecipientCount: vi.fn().mockRejectedValue(
          new MailFlowApiError(500, "Database error"),
        ),
      }),
    });

    const result = await getRecipientCountTool.handler(validInput, context);

    expect(result.success).toBe(false);
  });
});

// ── saveAiPromptTool ──────────────────────────────────────────────────────────

describe("saveAiPromptTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has the correct tool name", () => {
    expect(saveAiPromptTool.name).toBe(TOOL_NAMES.SAVE_AI_PROMPT);
  });

  it("saves the AI prompt and returns a success message", async () => {
    const saveAiPrompt = vi.fn().mockResolvedValue(AI_PROMPT_SAVE_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ saveAiPrompt }),
    });

    const result = await saveAiPromptTool.handler(
      { campaignId: CAMPAIGN_ID, templateType: "promotional", toneInstruction: "friendly" },
      context,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.campaignId).toBe(7);
      expect(result.data.message).toBe("AI prompt configuration saved");
    }
  });

  it("forwards campaignId, templateType, toneInstruction, and customPrompt", async () => {
    const saveAiPrompt = vi.fn().mockResolvedValue(AI_PROMPT_SAVE_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ saveAiPrompt }),
    });

    const input = {
      campaignId:      CAMPAIGN_ID,
      templateType:    "newsletter" as const,
      toneInstruction: "professional",
      customPrompt:    "Focus on product benefits",
    };

    await saveAiPromptTool.handler(input, context);

    expect(saveAiPrompt).toHaveBeenCalledOnce();
    const [payload] = saveAiPrompt.mock.calls[0]!;
    expect(payload.campaignId).toBe(CAMPAIGN_ID);
    expect(payload.templateType).toBe("newsletter");
    expect(payload.toneInstruction).toBe("professional");
    expect(payload.customPrompt).toBe("Focus on product benefits");
  });

  it("works with only campaignId (all optional fields absent)", async () => {
    const saveAiPrompt = vi.fn().mockResolvedValue(AI_PROMPT_SAVE_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ saveAiPrompt }),
    });

    const result = await saveAiPromptTool.handler({ campaignId: CAMPAIGN_ID }, context);

    expect(result.success).toBe(true);
    expect(saveAiPrompt).toHaveBeenCalledOnce();
  });

  it("404 not found → toolFailure with MAILFLOW_NOT_FOUND", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveAiPrompt: vi.fn().mockRejectedValue(
          new MailFlowApiError(404, "Campaign not found"),
        ),
      }),
    });

    const result = await saveAiPromptTool.handler({ campaignId: CAMPAIGN_ID }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    }
  });
});

// ── generatePersonalizedEmailsTool ───────────────────────────────────────────

describe("generatePersonalizedEmailsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  const validInput = { campaignId: CAMPAIGN_ID };

  it("has the correct tool name", () => {
    expect(generatePersonalizedEmailsTool.name).toBe(TOOL_NAMES.GENERATE_PERSONALIZED_EMAILS);
  });

  it("returns generation counts on success", async () => {
    const generatePersonalizedEmails = vi.fn().mockResolvedValue(GENERATION_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails: vi.fn().mockResolvedValue(NO_EXISTING_EMAILS),
        generatePersonalizedEmails,
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler(validInput, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generatedCount).toBe(148);
      expect(result.data.failedCount).toBe(2);
      expect(result.data.totalRecipients).toBe(150);
    }
  });

  it("forwards the campaignId correctly", async () => {
    const generatePersonalizedEmails = vi.fn().mockResolvedValue(GENERATION_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails: vi.fn().mockResolvedValue(NO_EXISTING_EMAILS),
        generatePersonalizedEmails,
      }),
    });

    await generatePersonalizedEmailsTool.handler(validInput, context);

    expect(generatePersonalizedEmails).toHaveBeenCalledOnce();
    expect(generatePersonalizedEmails).toHaveBeenCalledWith(CAMPAIGN_ID, undefined);
  });

  it("forwards sequence strategy options when provided", async () => {
    const generatePersonalizedEmails = vi.fn().mockResolvedValue(GENERATION_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails: vi.fn().mockResolvedValue(NO_EXISTING_EMAILS),
        generatePersonalizedEmails,
      }),
    });

    await generatePersonalizedEmailsTool.handler({
      ...validInput,
      tone: "founder_style",
      ctaType: "reply_cta",
      sequenceType: "founder_outreach",
      removeBreakupEmail: true,
      shortenEmails: true,
    }, context);

    expect(generatePersonalizedEmails).toHaveBeenCalledWith(CAMPAIGN_ID, {
      tone: "founder_style",
      ctaType: "reply_cta",
      sequenceType: "founder_outreach",
      removeBreakupEmail: true,
      shortenEmails: true,
      mode: undefined,
      sequenceLength: undefined,
      includeBreakupEmail: undefined,
      intent: undefined,
    });
  });

  it("422 no recipients → toolFailure with MAILFLOW_API_ERROR", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails:      vi.fn().mockResolvedValue(NO_EXISTING_EMAILS),
        generatePersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(422, "No recipients found. Upload a CSV first."),
        ),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler(validInput, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_API_ERROR);
    }
  });

  it("404 not found → toolFailure with MAILFLOW_NOT_FOUND", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails:      vi.fn().mockResolvedValue(NO_EXISTING_EMAILS),
        generatePersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(404, "Campaign not found"),
        ),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler(validInput, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    }
  });

  it("500 error → toolFailure", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        generatePersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(500, "OpenAI API error"),
        ),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler(validInput, context);

    expect(result.success).toBe(false);
  });
});

// ── getPersonalizedEmailsTool ─────────────────────────────────────────────────

describe("getPersonalizedEmailsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has the correct tool name", () => {
    expect(getPersonalizedEmailsTool.name).toBe(TOOL_NAMES.GET_PERSONALIZED_EMAILS);
  });

  it("returns personalized email samples on success", async () => {
    const getPersonalizedEmails = vi.fn().mockResolvedValue(PERSONALIZED_EMAILS_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getPersonalizedEmails }),
    });

    const result = await getPersonalizedEmailsTool.handler(
      { campaignId: CAMPAIGN_ID, limit: 2 },
      context,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.total).toBe(148);
      expect(result.data.emails).toHaveLength(2);
      expect(result.data.emails[0]!.recipientEmail).toBe("alice@example.com");
    }
  });

  it("forwards campaignId and limit correctly", async () => {
    const getPersonalizedEmails = vi.fn().mockResolvedValue(PERSONALIZED_EMAILS_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getPersonalizedEmails }),
    });

    await getPersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID, limit: 5 }, context);

    expect(getPersonalizedEmails).toHaveBeenCalledOnce();
    expect(getPersonalizedEmails).toHaveBeenCalledWith(CAMPAIGN_ID, 5);
  });

  it("uses default limit of 3 when not specified", async () => {
    const getPersonalizedEmails = vi.fn().mockResolvedValue(PERSONALIZED_EMAILS_RESULT);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ getPersonalizedEmails }),
    });

    await getPersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, context);

    expect(getPersonalizedEmails).toHaveBeenCalledWith(CAMPAIGN_ID, 3);
  });

  it("404 not found → toolFailure with MAILFLOW_NOT_FOUND", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(404, "Campaign not found"),
        ),
      }),
    });

    const result = await getPersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    }
  });

  it("500 error → toolFailure", async () => {
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(500, "Database error"),
        ),
      }),
    });

    const result = await getPersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, context);

    expect(result.success).toBe(false);
  });
});
