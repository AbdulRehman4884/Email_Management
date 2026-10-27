import { describe, expect, it, vi } from "vitest";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { campaignNameFrom, lookupCampaignByName, matchCampaigns } from "../campaignLookup.js";
import { analyticsAgent } from "../../agents/AnalyticsAgent.js";
import { finalResponseNode } from "../../graph/nodes/finalResponse.node.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

const campaigns = [
  { id: "434", name: "DRY RUN", status: "completed" },
  { id: "12", name: "ok", status: "completed" },
  { id: "13", name: "ok", status: "paused" },
  { id: "20", name: "Campaign 3", status: "completed" },
];
const listResult = { data: { success: true, data: campaigns }, isToolError: false, rawContent: [] };

describe("campaignNameFrom (bug A-01)", () => {
  it("reads the name from the LLM, quotes or 'campaign X'", () => {
    expect(campaignNameFrom({ campaignId: "DRY RUN" }, "")).toBe("DRY RUN");
    expect(campaignNameFrom(undefined, 'Show me the stats for the campaign "DRY RUN"')).toBe("DRY RUN");
    expect(campaignNameFrom(undefined, "Show stats for campaign ok")).toBe("ok");
    expect(campaignNameFrom(undefined, "who replied to the Black Friday campaign?")).toBe("Black Friday");
    expect(campaignNameFrom(undefined, "stats of BM AI Services")).toBe("BM AI Services");
    expect(campaignNameFrom(undefined, "show stats for all campaigns")).toBeUndefined();
    expect(campaignNameFrom(undefined, "stats of my campaigns")).toBeUndefined();
    // Roman Urdu and "campaign" misspellings
    expect(campaignNameFrom(undefined, "compain BM AI services pa kitna replies aya han")).toBe("BM AI services");
    expect(campaignNameFrom(undefined, "Proving AI Services pa kitna replies han")).toBe("Proving AI Services");
    expect(campaignNameFrom(undefined, "DRY RUN campaign ke kitne replies hain")).toBe("DRY RUN");
    expect(campaignNameFrom(undefined, "Damo campaign ke replies dikhao")).toBe("Damo");
    expect(campaignNameFrom(undefined, "campaign ke replies dikhao")).toBeUndefined();
  });

  it("ignores ids and non-names", () => {
    expect(campaignNameFrom({ campaignId: "434" }, "")).toBeUndefined();
    expect(campaignNameFrom(undefined, "Show stats for campaign id 434")).toBeUndefined();
    expect(campaignNameFrom(undefined, "show stats for all campaigns")).toBeUndefined();
  });
});

describe("matchCampaigns", () => {
  it("exact first, then partial; duplicates stay together", () => {
    expect(matchCampaigns("dry run", campaigns).map((c) => c.id)).toEqual(["434"]);
    expect(matchCampaigns("ok", campaigns).map((c) => c.id)).toEqual(["12", "13"]);
    expect(matchCampaigns("campaign 3", campaigns).map((c) => c.id)).toEqual(["20"]);
    expect(matchCampaigns("Black Friday 2026", campaigns)).toEqual([]);
  });
});

function agentState(partial: Partial<AgentGraphStateType>): AgentGraphStateType {
  return { intent: "get_campaign_stats", userId: "1", rawToken: "tok", toolArgs: {}, userMessage: "", ...partial } as AgentGraphStateType;
}

describe("AnalyticsAgent resolves campaign names (bug A-01)", () => {
  it("one match → stats for that campaign right away", async () => {
    mockDispatch.mockResolvedValueOnce(listResult);
    const patch = await analyticsAgent.handle(agentState({ userMessage: 'Show me the stats for the campaign "DRY RUN"' }));
    expect(patch.toolName).toBe("get_campaign_stats");
    expect(patch.toolArgs).toEqual({ campaignId: "434" });
  });

  it("duplicate names → only the matching campaigns, with ids", async () => {
    mockDispatch.mockResolvedValueOnce(listResult);
    const patch = await analyticsAgent.handle(agentState({ userMessage: "Show stats for campaign ok" }));
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("I found 2 campaigns named **ok**");
    expect(msg).toContain("1. **ok** (completed) · #12");
    expect(msg).not.toContain("DRY RUN");
    expect(patch.campaignSelectionList).toHaveLength(2);
    expect(patch.pendingCampaignAction).toBe("get_campaign_stats");
  });

  it("unknown name → says so (bug A-16) and lists the campaigns", async () => {
    mockDispatch.mockResolvedValueOnce(listResult);
    const patch = await analyticsAgent.handle(agentState({ userMessage: 'Show stats for my campaign named "Black Friday 2026"' }));
    expect(JSON.parse(String(patch.formattedResponse)).message).toContain("I couldn't find a campaign named **Black Friday 2026**");
  });

  it("a named campaign wins over the session's active campaign", async () => {
    mockDispatch.mockResolvedValueOnce(listResult);
    const patch = await analyticsAgent.handle(agentState({ userMessage: 'stats of "DRY RUN"', activeCampaignId: "20" }));
    expect(patch.toolArgs).toEqual({ campaignId: "434" });
  });

  it("list unavailable → old behaviour (campaign picker)", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("MCP down"));
    expect(await lookupCampaignByName("x", { userId: "1" as never, rawToken: "t" })).toBeUndefined();
  });
});

describe("InboxAgent: replies belong to the campaign the user named", () => {
  it("named campaign replaces the active campaign from an earlier turn", async () => {
    const { inboxAgent } = await import("../../agents/InboxAgent.js");
    mockDispatch.mockResolvedValueOnce({
      data: { success: true, data: [{ id: "20", name: "BM AI Services", status: "completed" }, { id: "16", name: "Proving AI Services", status: "paused" }] },
      isToolError: false, rawContent: [],
    });
    const patch = await inboxAgent.handle(agentState({
      intent: "list_replies", activeCampaignId: "20",
      userMessage: "Proving AI Services pa kitna replies han",
      llmExtractedArgs: { campaignId: "Proving AI Services" },
    }));
    expect(patch.toolName).toBe("list_replies");
    expect(patch.toolArgs).toMatchObject({ campaignId: "16" });
  });

  it("unknown campaign name → says so instead of showing other replies", async () => {
    const { inboxAgent } = await import("../../agents/InboxAgent.js");
    mockDispatch.mockResolvedValueOnce(listResult);
    const patch = await inboxAgent.handle(agentState({
      intent: "list_replies", activeCampaignId: "20", userMessage: 'replies of "Black Friday 2026"',
    }));
    expect(patch.toolName).toBeUndefined();
    expect(JSON.parse(String(patch.formattedResponse)).message).toContain("I couldn't find a campaign named **Black Friday 2026**");
  });
});

describe("tool failures are never shown as success (bug A-03)", () => {
  it("stats of a campaign that is not found → clear message, no zero stats", async () => {
    const out = await finalResponseNode({
      intent: "get_campaign_stats",
      toolName: "get_campaign_stats",
      toolArgs: { campaignId: "100" },
      userMessage: "Show stats for campaign id 100",
      toolResult: {
        data: { success: false, error: { code: "MAILFLOW_NOT_FOUND", message: "MailFlow API error on /campaigns/100/stats", details: { error: "Campaign not found" } } },
        isToolError: false,
        rawContent: [],
      },
    } as unknown as AgentGraphStateType);
    const body = JSON.parse(String(out.finalResponse)) as { status: string; message: string };
    expect(body.status).toBe("error");
    expect(body.message).toContain("couldn't find campaign **#100**");
    expect(body.message).not.toContain("Sent");
  });

  it("create campaign failure shows the backend reason (bug A-12)", async () => {
    const out = await finalResponseNode({
      intent: "create_ai_campaign",
      toolName: "create_campaign",
      toolArgs: {},
      userMessage: "confirm",
      toolResult: {
        data: { success: false, error: { code: "MAILFLOW_API_ERROR", message: "MailFlow API error on /campaigns", details: { error: "Subject must be at most 255 characters" } } },
        isToolError: false,
        rawContent: [],
      },
    } as unknown as AgentGraphStateType);
    const msg = JSON.parse(String(out.finalResponse)).message as string;
    expect(msg).toBe("I couldn't create the campaign: Subject must be at most 255 characters. Please fix it and try again.");
  });
});

describe("replies inside a plan show the replies (bug A-02)", () => {
  it("list_replies step lists sender and text; summarize step counts totalReplies", async () => {
    const out = await finalResponseNode({
      intent: "list_replies",
      userMessage: "replies",
      planResults: [
        {
          stepIndex: 0, toolName: "list_replies", toolArgs: {}, executedAt: "",
          toolResult: { data: { success: true, data: { items: [{ fromEmail: "ali@shop.com", subject: "Re: hi", bodyText: "Sounds good" }], total: 1 } }, isToolError: false, rawContent: [] },
        },
        {
          stepIndex: 1, toolName: "summarize_replies", toolArgs: {}, executedAt: "",
          toolResult: { data: { success: true, data: { totalReplies: 9 } }, isToolError: false, rawContent: [] },
        },
      ],
    } as unknown as AgentGraphStateType);
    const text = String(out.finalResponse);
    expect(text).toContain("ali@shop.com");
    expect(text).toContain("Sounds good");
    expect(text).toContain("9 replies retrieved");
  });
});
