import { describe, expect, it, vi, beforeEach } from "vitest";
import { bulkWorkflowNode } from "../bulkWorkflow.node.js";
import { mcpClientService } from "../../../services/mcpClient.service.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

vi.mock("../../../services/mcpClient.service.js", () => ({
  mcpClientService: {
    dispatch: vi.fn(),
  },
}));

const dispatch = vi.mocked(mcpClientService.dispatch);

function state(overrides: Partial<AgentGraphStateType> = {}): AgentGraphStateType {
  return {
    messages: [],
    userMessage: "",
    sessionId: "s1" as never,
    userId: "u1" as never,
    rawToken: "token",
    intent: "bulk_manual_rows_intake",
    confidence: 1,
    agentDomain: "bulk",
    llmExtractedArgs: undefined,
    toolName: undefined,
    toolArgs: {},
    toolResult: undefined,
    requiresApproval: false,
    pendingActionId: undefined,
    finalResponse: undefined,
    activeCampaignId: undefined,
    senderDefaults: undefined,
    pendingSmtpSelectionAction: undefined,
    smtpProfileChoices: undefined,
    pendingCampaignDraft: undefined,
    pendingCampaignStep: undefined,
    pendingCampaignAction: undefined,
    pendingScheduledAt: undefined,
    campaignSelectionList: undefined,
    plan: undefined,
    planIndex: 0,
    planResults: [],
    extractedRecipients: undefined,
    pendingCsvFile: undefined,
    pendingCsvData: undefined,
    bulkWorkflow: undefined,
    pendingAiCampaignStep: undefined,
    pendingAiCampaignData: undefined,
    pendingEnrichmentStep: undefined,
    pendingEnrichmentData: undefined,
    pendingOutreachDraft: undefined,
    pendingEnrichmentAction: undefined,
    pendingWorkflowDeadlineIso: undefined,
    workflowExpiredNotice: undefined,
    sessionSchemaVersion: 2,
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
    error: undefined,
    ...overrides,
  };
}

function ok(data: unknown) {
  return { isToolError: false, rawContent: [], data: { success: true, data } };
}

function okNested(data: unknown) {
  return { isToolError: false, rawContent: [], data: { success: true, data: { success: true, data } } };
}

beforeEach(() => {
  dispatch.mockReset();
});

describe("bulkWorkflowNode", () => {
  it("creates a bulk manual rows job and asks for template strategy without generating emails", async () => {
    dispatch.mockResolvedValueOnce(ok({
      jobId: 101,
      summary: { totalRows: 3, valid: 3, invalid: 0, duplicates: 0 },
      templateOptions: [{ id: "enterprise_transformation", name: "Enterprise Transformation" }],
      detectedGroups: [{ group: "enterprise_it", count: 3, recommendedTemplate: "enterprise_transformation" }],
    }) as never);

    const patch = await bulkWorkflowNode(state({
      userMessage: [
        "1. Systems Limited / https://www.systemsltd.com / test1@example.com",
        "2. NETSOL Technologies / https://www.netsoltech.com / test2@example.com",
        "3. 10Pearls / https://10pearls.com / test3@example.com",
      ].join("\n"),
    }));

    expect(dispatch).toHaveBeenCalledWith("create_bulk_manual_rows_job", expect.objectContaining({
      rows: [
        { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
        { company: "NETSOL Technologies", website: "https://www.netsoltech.com", email: "test2@example.com" },
        { company: "10Pearls", website: "https://10pearls.com", email: "test3@example.com" },
      ],
    }), expect.any(Object), expect.any(Object));
    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_template_strategy");
    expect(patch.activeCampaignId).toBeUndefined();
    expect(patch.formattedResponse).toContain("Validation summary");
    expect(patch.formattedResponse).toContain("Before generating emails");
    expect(dispatch).not.toHaveBeenCalledWith("start_campaign", expect.anything(), expect.anything(), expect.anything());
  });

  it("normalizes nested MCP response and backend validRows summary shape", async () => {
    dispatch.mockResolvedValueOnce(okNested({
      jobId: "101",
      summary: { totalRows: 3, validRows: 3, invalidRows: 0, duplicateRows: 0 },
      templateOptions: [{ id: "enterprise_transformation", name: "Enterprise Transformation" }],
      detectedGroups: [{ group: "enterprise_it", count: 3, recommendedTemplate: "enterprise_transformation" }],
    }) as never);

    const patch = await bulkWorkflowNode(state({
      userMessage: "Systems Limited / https://www.systemsltd.com / test1@example.com",
    }));

    expect(patch.bulkWorkflow?.jobId).toBe(101);
    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_template_strategy");
    expect(patch.bulkWorkflow?.rowsSummary).toMatchObject({
      totalRows: 3,
      validRows: 3,
      invalidRows: 0,
      duplicateRows: 0,
    });
    expect(patch.formattedResponse).toContain("Validation summary");
    expect(patch.formattedResponse).toContain("Valid: 3");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
  });

  it("returns a safe incomplete-response message when jobId is missing", async () => {
    dispatch.mockResolvedValueOnce(ok({
      summary: { totalRows: 1, validRows: 1, invalidRows: 0, duplicateRows: 0 },
    }) as never);

    const patch = await bulkWorkflowNode(state({
      userMessage: "Systems Limited / https://www.systemsltd.com / test1@example.com",
    }));

    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_rows");
    expect(patch.formattedResponse).toBe("Bulk workflow response was incomplete. Please try again.");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
  });

  it("returns a safe incomplete-response message when summary is missing", async () => {
    dispatch.mockResolvedValueOnce(ok({ jobId: 101 }) as never);

    const patch = await bulkWorkflowNode(state({
      userMessage: "Systems Limited / https://www.systemsltd.com / test1@example.com",
    }));

    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_rows");
    expect(patch.formattedResponse).toBe("Bulk workflow response was incomplete. Please try again.");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
  });

  it("returns a safe incomplete-response message for malformed MCP response data", async () => {
    dispatch.mockResolvedValueOnce({ isToolError: false, rawContent: [], data: "not-json" } as never);

    const patch = await bulkWorkflowNode(state({
      userMessage: "Systems Limited / https://www.systemsltd.com / test1@example.com",
    }));

    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_rows");
    expect(patch.formattedResponse).toBe("Bulk workflow response was incomplete. Please try again.");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
  });

  it("does not call MCP when no valid manual rows are detected", async () => {
    const patch = await bulkWorkflowNode(state({
      userMessage: "Here are my leads: Systems Limited / missing website / not-an-email",
    }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_rows");
    expect(patch.formattedResponse).toContain("I could not detect valid rows");
    expect(patch.formattedResponse).toContain("Company / Website / Email");
  });

  it("applies recommendations, generates preview, and waits for approval", async () => {
    dispatch
      .mockResolvedValueOnce(ok({ jobId: 101, message: "saved" }) as never)
      .mockResolvedValueOnce(ok({ jobId: 101, total: 3, processed: 3, failed: 0, remaining: 0, status: "completed" }) as never)
      .mockResolvedValueOnce(ok({
        jobId: 101,
        total: 3,
        templates: [{ id: 1, company: "Systems Limited", email: "test1@example.com", templateName: "Enterprise Transformation", subject: "Delivery visibility", body: "Hi...", followup1: "Follow up", followup2: "Close", cta: "Open to a review?", confidence: 0.8 }],
      }) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_select_template_strategy",
      userMessage: "Apply recommendations",
      activeCampaignId: "36",
      bulkWorkflow: { jobId: 202, currentStep: "awaiting_template_strategy", industryTemplateMap: { enterprise_it: "enterprise_transformation" } },
    }));

    expect(dispatch).toHaveBeenCalledWith("select_bulk_template_strategy", expect.objectContaining({
      jobId: "202",
      strategy: expect.objectContaining({ industryTemplateMap: { enterprise_it: "enterprise_transformation" } }),
    }), expect.any(Object), expect.any(Object));
    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_template_approval");
    expect(patch.formattedResponse).toContain("Template Preview");
    expect(patch.formattedResponse).toContain("Approve all");
  });

  it("creates a draft after approval but does not start campaign", async () => {
    dispatch
      .mockResolvedValueOnce(ok({ approved: 3 }) as never)
      .mockResolvedValueOnce(ok({ id: "7" }) as never)
      .mockResolvedValueOnce(ok({ campaignId: 55, status: "draft", recipients: 3, estimatedSendDurationDays: 1 }) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_create_campaign_draft",
      userMessage: "Approve all and create campaign draft",
      bulkWorkflow: { jobId: 101, currentStep: "awaiting_template_approval" },
    }));

    expect(dispatch).toHaveBeenCalledWith("create_bulk_campaign_draft", expect.objectContaining({ jobId: "101", smtpSettingsId: 7 }), expect.any(Object), expect.any(Object));
    expect(dispatch).not.toHaveBeenCalledWith("start_campaign", expect.anything(), expect.anything(), expect.anything());
    expect(patch.bulkWorkflow?.awaitingFinalConfirm).toBe(true);
    expect(patch.formattedResponse).toContain("No emails have been sent");
    expect(patch.formattedResponse).toContain("CONFIRM");
  });

  it("does not start on vague or lowercase approval and starts only latest draft after exact CONFIRM", async () => {
    const waiting = { jobId: 101, campaignDraftId: 55, currentStep: "awaiting_final_confirm" as const, awaitingFinalConfirm: true };

    const vague = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "yes",
      bulkWorkflow: waiting,
    }));
    expect(vague.formattedResponse).toContain("exact word **CONFIRM**");
    expect(dispatch).not.toHaveBeenCalled();

    const lowercase = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "confirm",
      bulkWorkflow: waiting,
    }));
    expect(lowercase.formattedResponse).toContain("exact word **CONFIRM**");
    expect(dispatch).not.toHaveBeenCalled();

    dispatch
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([]) as never)
      .mockResolvedValueOnce(ok({ id: "55", status: "running" }) as never);
    const confirmed = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "CONFIRM",
      activeCampaignId: "36",
      bulkWorkflow: waiting,
    }));
    expect(dispatch).toHaveBeenCalledWith("repair_bulk_campaign_readiness", { campaignId: "55" }, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenCalledWith("get_all_campaigns", {}, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenCalledWith("start_campaign", { campaignId: "55" }, expect.any(Object), expect.any(Object));
    expect(dispatch).not.toHaveBeenCalledWith("start_campaign", { campaignId: "36" }, expect.any(Object), expect.any(Object));
    expect(confirmed.bulkWorkflow?.currentStep).toBe("campaign_started");
  });

  it("repairs sender-name placeholders in readiness before starting campaign", async () => {
    dispatch
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: true,
        repairedFields: ["personalized_email.1", "sequence_touch.2"],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([]) as never)
      .mockResolvedValueOnce(ok({ id: "37", status: "running" }) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "CONFIRM",
      bulkWorkflow: { jobId: 101, campaignDraftId: 37, currentStep: "awaiting_final_confirm", awaitingFinalConfirm: true },
    }));

    expect(dispatch).toHaveBeenCalledWith("repair_bulk_campaign_readiness", { campaignId: "37" }, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenCalledWith("start_campaign", { campaignId: "37" }, expect.any(Object), expect.any(Object));
    expect(patch.bulkWorkflow?.currentStep).toBe("campaign_started");
  });

  it("does not start when readiness finds unknown placeholders and avoids generic failure", async () => {
    dispatch.mockResolvedValueOnce(ok({
      ready: false,
      campaignFound: true,
      smtpConfigured: true,
      recipientsExist: true,
      recipientCount: 3,
      pendingRecipientCount: 3,
      unsupportedPlaceholders: ["sender_title"],
      repairedSenderName: false,
      repairedFields: [],
      issues: ["unsupported_placeholders"],
    }) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "CONFIRM",
      bulkWorkflow: { jobId: 101, campaignDraftId: 37, currentStep: "awaiting_final_confirm", awaitingFinalConfirm: true },
    }));

    expect(dispatch).toHaveBeenCalledWith("repair_bulk_campaign_readiness", { campaignId: "37" }, expect.any(Object), expect.any(Object));
    expect(dispatch).not.toHaveBeenCalledWith("start_campaign", expect.anything(), expect.anything(), expect.anything());
    expect(patch.formattedResponse).toContain("unsupported placeholders remain: sender_title");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
  });

  it("surfaces start_campaign failures without generic bulk failure", async () => {
    dispatch
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([]) as never)
      .mockResolvedValueOnce({ isToolError: false, rawContent: [], data: { success: false, error: { message: "No pending recipients to send to" } } } as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "CONFIRM",
      bulkWorkflow: { jobId: 101, campaignDraftId: 37, currentStep: "awaiting_final_confirm", awaitingFinalConfirm: true },
    }));

    expect(patch.formattedResponse).toContain("no pending recipients");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
    expect(patch.bulkWorkflow?.currentStep).toBe("awaiting_final_confirm");
  });

  it("detects and lists multiple running campaign blockers before start", async () => {
    dispatch
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([
        { id: 26, name: "Live Test Campaign - AI SDR - 2026-05-11T14-46", status: "running" },
        { id: 30, name: "summer sale", status: "in_progress" },
        { id: 40, name: "Current Draft", status: "draft" },
      ]) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "CONFIRM",
      bulkWorkflow: { jobId: 101, campaignDraftId: 40, currentStep: "awaiting_final_confirm", awaitingFinalConfirm: true },
    }));

    expect(patch.formattedResponse).toContain("Campaign cannot start because these campaigns are already running");
    expect(patch.formattedResponse).toContain("#26 Live Test Campaign - AI SDR");
    expect(patch.formattedResponse).toContain("#30 summer sale");
    expect(patch.formattedResponse).toContain("PAUSE ALL AND START");
    expect(patch.formattedResponse).not.toContain("PAUSE AND START");
    expect(patch.formattedResponse).toContain("Live Test Campaign - AI SDR");
    expect(patch.bulkWorkflow?.pendingStartConflictCampaignId).toBe(26);
    expect(patch.bulkWorkflow?.pendingStartConflictCampaigns).toEqual([
      { id: 26, name: "Live Test Campaign - AI SDR - 2026-05-11T14-46" },
      { id: 30, name: "summer sale" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalledWith("start_campaign", expect.anything(), expect.anything(), expect.anything());
  });

  it("requires exact PAUSE ALL AND START after conflict; vague yes does not pause or start", async () => {
    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "yes",
      bulkWorkflow: {
        jobId: 101,
        campaignDraftId: 40,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: [{ id: 26, name: "Live Test Campaign" }, { id: 30, name: "summer sale" }],
      },
    }));

    expect(patch.formattedResponse).toContain("PAUSE ALL AND START");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("PAUSE AND START does not accidentally pause all blockers", async () => {
    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "PAUSE AND START",
      bulkWorkflow: {
        jobId: 101,
        campaignDraftId: 40,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: [{ id: 26, name: "Live Test Campaign" }, { id: 30, name: "summer sale" }],
      },
    }));

    expect(patch.formattedResponse).toContain("PAUSE ALL AND START");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("PAUSE ALL AND START pauses all blockers, rechecks readiness, then starts current draft", async () => {
    dispatch
      .mockResolvedValueOnce(ok({ id: "26", status: "paused" }) as never)
      .mockResolvedValueOnce(ok({ id: "30", status: "paused" }) as never)
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([]) as never)
      .mockResolvedValueOnce(ok({ id: "40", status: "running" }) as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "PAUSE ALL AND START",
      bulkWorkflow: {
        jobId: 101,
        campaignDraftId: 40,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: [{ id: 26, name: "Live Test Campaign" }, { id: 30, name: "summer sale" }],
      },
    }));

    expect(dispatch).toHaveBeenNthCalledWith(1, "pause_campaign", { campaignId: "26" }, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenNthCalledWith(2, "pause_campaign", { campaignId: "30" }, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenNthCalledWith(3, "repair_bulk_campaign_readiness", { campaignId: "40" }, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenNthCalledWith(4, "get_all_campaigns", {}, expect.any(Object), expect.any(Object));
    expect(dispatch).toHaveBeenNthCalledWith(5, "start_campaign", { campaignId: "40" }, expect.any(Object), expect.any(Object));
    expect(patch.formattedResponse).toContain("Campaigns #26, #30 were paused");
    expect(patch.bulkWorkflow?.currentStep).toBe("campaign_started");
  });

  it("surfaces a new conflict if one appears after PAUSE ALL retry", async () => {
    dispatch
      .mockResolvedValueOnce(ok({ id: "26", status: "paused" }) as never)
      .mockResolvedValueOnce(ok({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }) as never)
      .mockResolvedValueOnce(ok([]) as never)
      .mockResolvedValueOnce({
        isToolError: false,
        rawContent: [],
        data: {
          success: false,
          error: {
            code: "MAILFLOW_CONFLICT",
            message: "MailFlow API error on /campaigns/40/start",
            details: {
              error: "Another campaign is already running.",
              code: "CAMPAIGN_CONFLICT",
              conflictCampaignId: 30,
              conflictCampaignName: "summer sale",
            },
          },
        },
      } as never);

    const patch = await bulkWorkflowNode(state({
      intent: "bulk_final_confirm_start",
      userMessage: "PAUSE ALL AND START",
      bulkWorkflow: {
        jobId: 101,
        campaignDraftId: 40,
        currentStep: "awaiting_final_confirm",
        awaitingFinalConfirm: true,
        pendingStartConflictCampaigns: [{ id: 26, name: "Live Test Campaign" }],
      },
    }));

    expect(patch.formattedResponse).toContain("MailFlow found another running conflict after retry");
    expect(patch.formattedResponse).toContain("#30 summer sale");
    expect(patch.formattedResponse).toContain("PAUSE ALL AND START");
    expect(patch.formattedResponse).not.toContain("I could not complete the bulk workflow step");
    expect(patch.bulkWorkflow?.pendingStartConflictCampaignId).toBe(30);
  });
});
