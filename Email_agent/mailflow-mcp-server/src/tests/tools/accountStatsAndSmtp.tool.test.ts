/**
 * src/tests/tools/accountStatsAndSmtp.tool.test.ts
 *
 * QA bugs A-05 (account totals), A-08 (campaign name on stats) and A-09 (all SMTP accounts).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { getAccountStatsTool } from "../../mcp/tools/analytics/getAccountStats.tool.js";
import { getCampaignStatsTool } from "../../mcp/tools/analytics/getCampaignStats.tool.js";
import { getSmtpSettingsTool } from "../../mcp/tools/settings/getSmtpSettings.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";

beforeEach(() => vi.clearAllMocks());

const totals = {
  totalCampaigns: 3, activeCampaigns: 0, sent: 20, delivered: 18, opened: 5,
  replied: 2, bounced: 2, failed: 0, unsubscribed: 0, recipients: 25,
};

describe("get_account_stats (A-05)", () => {
  it("returns totals, campaign counts per status and rates", async () => {
    const mailflow = createMockMailflowClient({
      getDashboardStats: vi.fn().mockResolvedValue(totals),
      getAllCampaigns: vi.fn().mockResolvedValue([{ status: "draft" }, { status: "draft" }, { status: "completed" }]),
    });
    const result = await getAccountStatsTool.handler({}, createMockToolContext({ mailflow }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.campaignsByStatus).toEqual({ draft: 2, completed: 1 });
      expect(result.data.sent).toBe(20);
      expect(result.data.replyRate).toBeCloseTo(0.1);
    }
  });

  it("backend failure → tool failure", async () => {
    const mailflow = createMockMailflowClient({
      getDashboardStats: vi.fn().mockRejectedValue(new Error("down")),
      getAllCampaigns: vi.fn().mockResolvedValue([]),
    });
    const result = await getAccountStatsTool.handler({}, createMockToolContext({ mailflow }));
    expect(result.success).toBe(false);
  });
});

describe("get_campaign_stats adds the campaign name (A-08)", () => {
  it("name from the campaign list; stats still return when the list fails", async () => {
    const stats = { campaignId: "20", sent: 4, replied: 1 };
    const named = createMockMailflowClient({
      getCampaignStats: vi.fn().mockResolvedValue(stats),
      getAllCampaigns: vi.fn().mockResolvedValue([{ id: "20", name: "BM AI Services" }]),
    });
    const r1 = await getCampaignStatsTool.handler({ campaignId: "20" }, createMockToolContext({ mailflow: named }));
    expect(r1.success && r1.data.campaignName).toBe("BM AI Services");

    const unnamed = createMockMailflowClient({
      getCampaignStats: vi.fn().mockResolvedValue(stats),
      getAllCampaigns: vi.fn().mockRejectedValue(new Error("down")),
    });
    const r2 = await getCampaignStatsTool.handler({ campaignId: "20" }, createMockToolContext({ mailflow: unnamed }));
    expect(r2.success).toBe(true);
    expect(r2.success && r2.data.campaignName).toBeUndefined();
  });
});

describe("get_smtp_settings lists every account (A-09)", () => {
  it("adds accounts from the SMTP list", async () => {
    const accounts = [
      { id: 3, fromEmail: "a@x.com", fromName: "A", host: "smtp.gmail.com", port: 587 },
      { id: 4, fromEmail: "b@x.com", fromName: "B", host: "smtp.gmail.com", port: 587 },
    ];
    const mailflow = createMockMailflowClient({
      getSmtpSettings: vi.fn().mockResolvedValue({ host: "smtp.gmail.com", port: 587, username: "a@x.com", fromEmail: "a@x.com" }),
      listSmtpProfiles: vi.fn().mockResolvedValue(accounts),
    });
    const result = await getSmtpSettingsTool.handler({}, createMockToolContext({ mailflow }));
    expect(result.success && result.data.accounts).toEqual(accounts);
  });
});
