import { describe, expect, it, vi } from "vitest";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { formatAccountStatsMessage, isAccountLevelQuestion } from "../accountStats.js";
import { approvalFactLines } from "../approvalFacts.js";
import { selectableCampaigns } from "../campaignLookup.js";
import { analyticsAgent } from "../../agents/AnalyticsAgent.js";
import { campaignAgent } from "../../agents/CampaignAgent.js";
import { finalResponseNode } from "../../graph/nodes/finalResponse.node.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

function state(partial: Partial<AgentGraphStateType>): AgentGraphStateType {
  return { userId: "2", rawToken: "tok", toolArgs: {}, userMessage: "", ...partial } as AgentGraphStateType;
}

const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });

async function message(partial: Partial<AgentGraphStateType>): Promise<string> {
  const out = await finalResponseNode(state(partial));
  const text = String(out.finalResponse);
  try { return (JSON.parse(text) as { message: string }).message; } catch { return text; }
}

describe("A-05 account-level questions", () => {
  it("recognises account-wide questions, not single-campaign ones", () => {
    expect(isAccountLevelQuestion("What is the total number of emails sent across all my campaigns?")).toBe(true);
    expect(isAccountLevelQuestion("Show my overall analytics: open rate and reply rate")).toBe(true);
    expect(isAccountLevelQuestion("How many draft campaigns do I have?")).toBe(true);
    expect(isAccountLevelQuestion("Show stats for campaign id 20")).toBe(false);
    expect(isAccountLevelQuestion("list all my campaigns")).toBe(false);
    expect(isAccountLevelQuestion("how many people replied to it?")).toBe(false);
  });

  it("stats agent uses get_account_stats even when a campaign is active in the session", async () => {
    const patch = await analyticsAgent.handle(state({
      intent: "get_campaign_stats", activeCampaignId: "20",
      userMessage: "Show my overall analytics: open rate and reply rate",
    }));
    expect(patch.toolName).toBe("get_account_stats");
  });

  it("'how many draft campaigns' answers with the count first", () => {
    const msg = formatAccountStatsMessage(
      { totalCampaigns: 12, campaignsByStatus: { completed: 5, paused: 4, draft: 3 }, sent: 26, delivered: 24, opened: 3, replied: 3, bounced: 2, openRate: 3 / 26, replyRate: 3 / 26, bounceRate: 2 / 26 },
      "How many draft campaigns do I have?",
    );
    expect(msg.startsWith("You have **3 draft campaigns** (out of 12).")).toBe(true);
    expect(msg).toContain("**Emails sent:** 26");
    expect(msg).toContain("**Replied:** 3 (11.5%)");
  });
});

describe("A-06 'Script generation' without a file", () => {
  it("explains how to start instead of the generic fallback", async () => {
    const msg = await message({ intent: "general_help", userMessage: "Script generation" });
    expect(msg).toContain("CSV or Excel");
    expect(msg).toContain("Company Name");
  });
});

describe("A-07 / A-08 stats name the campaign, include replies, and are remembered", () => {
  it("stats by id set the active campaign for the next 'it'", async () => {
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage: "Show stats for campaign id 20", llmExtractedArgs: { campaignId: "20" } }));
    expect(patch.toolArgs).toEqual({ campaignId: "20" });
    expect(patch.activeCampaignId).toBe("20");
  });

  it("stats message has the campaign name and Replied", async () => {
    const msg = await message({
      intent: "get_campaign_stats", toolName: "get_campaign_stats", toolArgs: { campaignId: "20" },
      toolResult: ok({ campaignId: "20", campaignName: "BM AI Services", sent: 4, delivered: 3, opened: 1, replied: 1, bounced: 1, openRate: 0.25, replyRate: 0.25, bounceRate: 0.25 }),
    });
    expect(msg).toContain("**BM AI Services** (#20)");
    expect(msg).toContain("**Replied:** 1 (25.0%)");
  });

  it("replies count people, not bounce notices", async () => {
    const msg = await message({
      intent: "list_replies", toolName: "list_replies",
      toolResult: ok({ items: [
        { fromEmail: "ali@shop.com", subject: "Re: hi", bodyText: "ok" },
        { fromEmail: "ali@shop.com", subject: "Re: hi", bodyText: "thanks" },
        { fromEmail: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification", bodyText: "failed" },
      ], total: 3 }),
    });
    expect(msg).toContain("3 replies — 1 person + 1 automatic notice:");
  });
});

describe("A-09 SMTP shows every account", () => {
  it("lists all accounts and marks the default", async () => {
    const msg = await message({
      intent: "check_smtp", toolName: "get_smtp_settings",
      toolResult: ok({ host: "smtp.gmail.com", port: 587, fromEmail: "a@x.com", accounts: [
        { id: 3, fromEmail: "a@x.com", fromName: "A", host: "smtp.gmail.com", port: 587 },
        { id: 4, fromEmail: "b@x.com", fromName: "B", host: "smtp.gmail.com", port: 587 },
      ] }),
    });
    expect(msg).toContain("You have **2 SMTP accounts**");
    expect(msg).toContain("**a@x.com** (A) · smtp.gmail.com:587 · default");
    expect(msg).toContain("**b@x.com**");
  });
});

describe("A-11 AI wizard body draft", () => {
  it("no '<campaign> Team' sign-off and no button without a link", async () => {
    const patch = await campaignAgent.handle(state({
      intent: "create_ai_campaign", userMessage: "2",
      pendingAiCampaignStep: "template_selection",
      pendingAiCampaignData: { campaignName: "Medium repro", subject: "Monthly update" },
    }));
    const body = String(patch.error);
    expect(body).toContain("Hi {{first_name}},");
    expect(body).not.toContain("Medium repro Team");
    expect(body).not.toMatch(/\[(Read More|Shop Now|Learn More|RSVP Now|Get in Touch)\]/);
  });
});

describe("A-13 start approval", () => {
  const list = [
    { id: "20", name: "BM AI Services", status: "completed" },
    { id: "18", name: "Nothing", status: "draft" },
    { id: "17", name: "Damo", status: "paused" },
  ];

  it("'1' starts the campaign shown as 1, not the first of the unfiltered list", async () => {
    expect(selectableCampaigns(list, "start_campaign").map((c) => c.id)).toEqual(["18", "17"]);
    const patch = await campaignAgent.handle(state({
      intent: "general_help", userMessage: "1",
      pendingCampaignAction: "start_campaign", campaignSelectionList: list,
    }));
    expect(patch.toolName).toBe("start_campaign");
    expect(patch.toolArgs).toEqual({ campaignId: "18" });
  });

  it("card names the campaign and its recipients, no API text", async () => {
    mockDispatch.mockResolvedValueOnce(ok([{ id: "18", name: "Nothing", status: "draft", recipientCount: 0 }]));
    const msg = await message({
      intent: "start_campaign", toolName: "start_campaign", toolArgs: { campaignId: "18" },
      requiresApproval: true, pendingActionId: "pa-1",
    });
    expect(msg).toContain("**Campaign:** Nothing (#18)");
    expect(msg).toContain("**Recipients:** 0");
    expect(msg).toContain("nothing would be sent");
    expect(msg).toContain("Press **Confirm**");
    expect(msg).not.toContain("/api/agent");
    expect(msg).not.toContain("pa-1");
  });

  it("facts are optional", () => {
    expect(approvalFactLines(undefined)).toEqual([]);
    expect(approvalFactLines({ campaignId: "5", name: "X", recipients: 40 })).toEqual(["**Campaign:** X (#5)", "**Recipients:** 40"]);
  });
});
