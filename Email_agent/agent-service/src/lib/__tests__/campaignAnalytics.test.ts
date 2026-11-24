/**
 * QA batch 15 Nov 2026 — analytics questions answered from real numbers (lib/campaignAnalytics.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));

import {
  analyticsIntentFor,
  campaignFactAnswer,
  campaignsCreatedAnswer,
  campaignsInMessage,
  isCampaignFactQuestion,
  isMultiCampaignStatsRequest,
  multiCampaignStatsAnswer,
  periodIn,
  periodStatsAnswer,
  rankingAnswer,
  rankingMetric,
} from "../campaignAnalytics.js";

const ok = (data: unknown) => ({ isToolError: false, data: { success: true, data } });
const CAMPAIGNS = [
  { id: 434, name: "DRY RUN", status: "completed", createdAt: "2026-10-16T02:00:00.000Z" },
  { id: 431, name: "Campaign 3", status: "completed", createdAt: "2026-10-01T10:00:00.000Z" },
  { id: 449, name: "ALL", status: "paused", createdAt: "2026-10-28T10:00:00.000Z" },
  { id: 441, name: "QA-TEST Daily limit 1 - do not use", status: "paused", pauseReason: "daily_campaign_cap", dailySendLimit: 1, createdAt: "2026-10-20T10:00:00.000Z" },
  { id: 3, name: "ok", status: "completed", createdAt: "2026-05-09T10:00:00.000Z" },
  { id: 452, name: "QA TEST AGENT DRAFT 2", status: "draft", recipientCount: 0, createdAt: "2026-11-15T10:00:00.000Z" },
];
const STATS: Record<string, unknown> = {
  "434": { sent: 2, delivered: 2, opened: 1, openRate: 0.5, replied: 2, replyRate: 1, bounced: 0 },
  "431": { sent: 25, delivered: 25, opened: 0, openRate: 0, replied: 0, replyRate: 0, bounced: 0 },
  "449": { sent: 4, delivered: 4, opened: 1, openRate: 0.25, replied: 0, replyRate: 0, bounced: 0 },
  "441": { sent: 1, delivered: 1, opened: 0, openRate: 0, replied: 0, replyRate: 0, bounced: 0 },
  "3": { sent: 1, delivered: 1, opened: 0, openRate: 0, replied: 1, replyRate: 1, bounced: 0 },
};
const STATE = { rawToken: "t", userId: "5" };

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "get_all_campaigns") return ok(CAMPAIGNS);
    if (tool === "get_campaign_stats") return ok(STATS[String(args.campaignId)]);
    if (tool === "get_account_stats") {
      return ok({
        sent: 79, opened: 26, replied: 3, bounced: 1, totalCampaigns: 38,
        months: [{ month: "Sep", sent: 0, delivered: 0, opened: 0, replied: 0 }, { month: "Oct", sent: 52, delivered: 51, opened: 20, replied: 2 }],
      });
    }
    throw new Error(`unexpected ${tool}`);
  });
});

describe("several campaigns (QA bug 1 / 18)", () => {
  it("'Show stats for campaigns 434 and 431' gives each campaign's OWN numbers with its name", async () => {
    const answer = await multiCampaignStatsAnswer({ ...STATE, userMessage: "Show stats for campaigns 434 and 431" });
    expect(answer).toContain("**DRY RUN** (#434");
    expect(answer).toContain("Sent 2 · Delivered 2 · Opened 1 (50.0%)");
    expect(answer).toContain("**Campaign 3** (#431");
    expect(answer).toContain("Sent 25 · Delivered 25 · Opened 0 (0.0%)");
    expect(answer).toContain("**DRY RUN** has the best open rate");
  });

  it("'Compare DRY RUN and Campaign 3' — names, and 'Campaign 3' is the name, not id 3", async () => {
    expect(analyticsIntentFor("Compare DRY RUN and Campaign 3")).toBe("get_campaign_stats");
    const answer = await multiCampaignStatsAnswer({ ...STATE, userMessage: "Compare DRY RUN and Campaign 3" });
    expect(answer).toContain("#434");
    expect(answer).toContain("#431");
    expect(answer).not.toContain("**ok**");
  });

  it("one campaign is not a several-campaign question", async () => {
    expect(isMultiCampaignStatsRequest("Show stats for campaign id 434")).toBe(false);
    expect(await multiCampaignStatsAnswer({ ...STATE, userMessage: "Show stats for DRY RUN and replies" })).toBeUndefined();
  });

  it("numbers in dates are not campaign ids when namesOnly is asked", () => {
    const refs = CAMPAIGNS.map((c) => ({ id: String(c.id), name: c.name, status: c.status }));
    expect(campaignsInMessage("schedule QA TEST AGENT DRAFT 2 for 31 December 2026 at 3", refs, { namesOnly: true }).map((c) => c.id)).toEqual(["452"]);
  });
});

describe("routing of analytics questions", () => {
  it.each([
    ["how are my campaigns doing?", "get_campaign_stats"],
    ["Why is my open rate low?", "get_campaign_stats"],
    ["How can I improve my open rate?", "get_campaign_stats"],
    ["Which campaign has the best open rate?", "get_campaign_stats"],
    ["Which campaign had the most replies?", "get_campaign_stats"],
    ["How many emails did I send in October?", "get_campaign_stats"],
    ["Show stats for the last campaign I created", "get_campaign_stats"],
    ["What is the open rate of my most recent campaign?", "get_campaign_stats"],
    ["Show me campaigns created this week", "list_campaigns"],
    ["is ALL still running?", "get_campaign_stats"],
    ["why is campaign 441 paused?", "get_campaign_stats"],
    ["When was DRY RUN created?", "get_campaign_stats"],
  ])("%s → %s", (msg, intent) => {
    expect(analyticsIntentFor(msg)).toBe(intent);
  });

  it.each(["Show all campaigns", "create campaign", "pause campaign 434", "What is 2+2?", "may I create a campaign"])("not analytics: %s", (msg) => {
    expect(analyticsIntentFor(msg)).toBeUndefined();
  });

  it("ranking metric and period parsing", () => {
    expect(rankingMetric("Which campaign has the best open rate?")).toEqual({ metric: "openRate", lowest: false });
    expect(rankingMetric("Which campaign had the most replies?")).toEqual({ metric: "replied", lowest: false });
    const now = new Date(2026, 10, 16, 12);
    expect(periodIn("emails in October", now)?.label).toBe("October 2026");
    expect(periodIn("campaigns created this week", now)?.label).toBe("this week");
    expect(periodIn("may I see it", now)).toBeUndefined();
  });
});

describe("answers", () => {
  it("best open rate = from every sent campaign's real numbers, not a name lookup", async () => {
    const answer = await rankingAnswer({ ...STATE, userMessage: "Which campaign has the best open rate?" });
    expect(answer).toContain("**DRY RUN** (#434) has the highest open rate: **50.0%**");
    expect(mockDispatch).not.toHaveBeenCalledWith("get_campaign_stats", { campaignId: "452" }, expect.anything());
  });

  it("most replies", async () => {
    const answer = await rankingAnswer({ ...STATE, userMessage: "Which campaign had the most replies?" });
    expect(answer).toContain("**DRY RUN** (#434) has the most replies: **2**");
  });

  it("emails sent in October = the October month of the account", async () => {
    const answer = await periodStatsAnswer({ ...STATE, userMessage: "How many emails did I send in October?" });
    expect(answer).toContain("you sent **52** emails");
    expect(mockDispatch).toHaveBeenCalledWith("get_account_stats", { view: "yearly" }, expect.anything());
  });

  it("campaigns created this week — only those (or a plain 'none')", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12)); // Wednesday; the week started Monday 16 Nov
    mockDispatch.mockImplementation(async () => ok([...CAMPAIGNS, { id: 470, name: "Fresh one", status: "draft", createdAt: "2026-11-17T09:00:00" }]));
    const answer = await campaignsCreatedAnswer({ ...STATE, userMessage: "Show me campaigns created this week" });
    vi.useRealTimers();
    expect(answer).toContain("**1 campaign**");
    expect(answer).toContain("Fresh one");
    expect(answer).not.toContain("DRY RUN");
    expect(answer).not.toContain("QA TEST AGENT DRAFT 2"); // Sunday 15 Nov = last week
  });

  it("'is ALL still running?' → No, paused (never a pause request)", async () => {
    expect(isCampaignFactQuestion("is ALL still running?")).toBe(true);
    const answer = await campaignFactAnswer({ ...STATE, userMessage: "is ALL still running?" });
    expect(answer).toMatch(/^No — \*\*ALL\*\* \(#449\) is \*\*paused\*\*/);
  });

  it("'why is campaign 441 paused?' → the daily limit reason", async () => {
    const answer = await campaignFactAnswer({ ...STATE, userMessage: "why is campaign 441 paused?" });
    expect(answer).toContain("daily send limit of **1** email a day");
  });

  it("'When was DRY RUN created?' → its date", async () => {
    const answer = await campaignFactAnswer({ ...STATE, userMessage: "When was DRY RUN created?" });
    expect(answer).toContain("**DRY RUN** (#434) was created on **2026-10-16");
  });

  it("routes Roman Urdu campaign metrics, casual summaries, and paused-campaign stats to analytics", () => {
    expect(analyticsIntentFor("DRY RUN ka open rate kya hai?")).toBe("get_campaign_stats");
    expect(analyticsIntentFor("DRY RUN ki stats dikhao")).toBe("get_campaign_stats");
    expect(analyticsIntentFor("how am I doing?")).toBe("get_campaign_stats");
    expect(analyticsIntentFor("list my paused campaigns with their stats")).toBe("get_campaign_stats");
  });

  it("answers who opened without replying from campaign analytics when nobody opened", async () => {
    expect(isCampaignFactQuestion("Who opened but didn't reply in Campaign 3?")).toBe(true);
    const answer = await campaignFactAnswer({ ...STATE, userMessage: "Who opened but didn't reply in Campaign 3?" });
    expect(answer).toContain("Nobody in **Campaign 3** (#431) has opened");
  });
});
