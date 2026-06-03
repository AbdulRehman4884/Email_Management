import { describe, expect, it, vi } from "vitest";
import {
  approveBulkTemplatesTool,
  createBulkCampaignDraftTool,
  createBulkManualRowsJobTool,
  repairBulkCampaignReadinessTool,
  selectBulkTemplateStrategyTool,
} from "../../mcp/tools/bulk/bulkWorkflow.tools.js";
import type { ToolContext } from "../../mcp/types/toolContext.js";

function context(overrides: Partial<ToolContext["mailflow"]> = {}): ToolContext {
  return {
    auth: { userId: "1" as never, bearerToken: "token" as never },
    session: { sessionId: "s1", rawAuth: "Bearer token" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    mailflow: {
      createBulkManualRowsJob: vi.fn().mockResolvedValue({ jobId: 1 }),
      selectBulkTemplateStrategy: vi.fn().mockResolvedValue({ jobId: 1, strategy: {}, message: "saved" }),
      approveBulkTemplates: vi.fn().mockResolvedValue({ message: "approved", approved: 3 }),
      createBulkCampaignDraft: vi.fn().mockResolvedValue({ campaignId: 9, status: "draft", recipients: 3, message: "draft", estimatedSendDurationDays: 1, smtpSafeDailyCapacity: 50 }),
      repairBulkCampaignReadiness: vi.fn().mockResolvedValue({ ready: true, campaignFound: true, smtpConfigured: true, recipientsExist: true, recipientCount: 3, pendingRecipientCount: 3, unsupportedPlaceholders: [], repairedSenderName: false, repairedFields: [], issues: [] }),
      ...overrides,
    } as never,
  };
}

describe("bulk workflow tools", () => {
  it("creates manual-row jobs through the shared MailFlow API client", async () => {
    const ctx = context();
    const result = await createBulkManualRowsJobTool.handler({
      rows: [{ company: "Systems Limited", website: "https://www.systemsltd.com", email: "test@example.com" }],
    }, ctx);
    expect(result.success).toBe(true);
    expect(ctx.mailflow.createBulkManualRowsJob).toHaveBeenCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({ company: "Systems Limited" })]),
    }));
  });

  it("saves strategy, approves templates, and creates draft without starting campaign", async () => {
    const startCampaign = vi.fn();
    const ctx = context({ startCampaign } as never);
    await selectBulkTemplateStrategyTool.handler({ jobId: "1", strategy: { industryTemplateMap: { fintech: "fintech_compliance" } } }, ctx);
    await approveBulkTemplatesTool.handler({ jobId: "1", mode: "all" }, ctx);
    await createBulkCampaignDraftTool.handler({ jobId: "1", smtpSettingsId: 7 }, ctx);
    expect(ctx.mailflow.selectBulkTemplateStrategy).toHaveBeenCalled();
    expect(ctx.mailflow.approveBulkTemplates).toHaveBeenCalled();
    expect(ctx.mailflow.createBulkCampaignDraft).toHaveBeenCalled();
    expect(startCampaign).not.toHaveBeenCalled();
  });

  it("runs campaign readiness repair through the shared MailFlow API client without starting", async () => {
    const startCampaign = vi.fn();
    const ctx = context({ startCampaign } as never);
    const result = await repairBulkCampaignReadinessTool.handler({ campaignId: "37" }, ctx);
    expect(result.success).toBe(true);
    expect(ctx.mailflow.repairBulkCampaignReadiness).toHaveBeenCalledWith({ campaignId: "37" });
    expect(startCampaign).not.toHaveBeenCalled();
  });
});
