/**
 * QA batch 17 Nov 2026 (P4 list) — one describe per bug.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({ getOpenAIService: () => undefined, OpenAIServiceError: class extends Error {} }));

import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

const state = (p: Partial<AgentGraphStateType>) =>
  ({ messages: [], userMessage: "", toolArgs: {}, rawToken: "t", userId: "u1", ...p }) as unknown as AgentGraphStateType;

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockRejectedValue(new Error("no MCP in this test"));
});

describe("Bug 1 — an id that can't exist gets the friendly not-found answer", () => {
  it.each([
    ["Show stats for campaign 0", "0"],
    ["Show stats for campaign id 99999999999999999999", "99999999999999999999"],
    ["Show stats for campaign -5", "-5"],
    ["Show stats for campaign 4.34", "4.34"],
  ])("%s", async (userMessage, id) => {
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage }));
    expect(patch.toolName).toBeUndefined();
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain(`I couldn't find campaign **#${id}** in your account`);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("finalResponse: a 400 'Invalid campaign id' / a 500 for a huge id read as not found", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({
      intent: "get_campaign_stats", toolName: "get_campaign_stats", toolArgs: { campaignId: "0" },
      toolResult: { isToolError: false, data: { success: false, error: { code: "MAILFLOW_ERROR", message: "x", details: { error: "Invalid campaign id" } } } } as never,
    }));
    expect(JSON.parse(String(out.finalResponse)).message).toContain("I couldn't find campaign **#0**");
  });

  it("a normal id still goes to the stats tool", async () => {
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage: "Show stats for campaign id 434", llmExtractedArgs: { campaignId: "434" } as never }));
    expect(patch.toolName).toBe("get_campaign_stats");
    expect(patch.toolArgs).toEqual({ campaignId: "434" });
  });
});

describe("Bug 2 — 'thanks' / 'cancel' with nothing running get a short human answer", () => {
  it.each([
    ["thanks", "You're welcome!"],
    ["Thank you!", "You're welcome!"],
    ["cancel", "There's nothing to cancel right now."],
    ["stop", "There's nothing to cancel right now."],
  ])("%s", async (userMessage, expected) => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({ intent: "general_help", userMessage }));
    expect(String(out.finalResponse)).toContain(expected);
    expect(String(out.finalResponse)).not.toContain("Which part would you like to work on");
  });

  it("other text is not small talk", async () => {
    const { smallTalkReply } = await import("../../graph/nodes/finalResponse.node.js");
    expect(smallTalkReply("cancel campaign 441")).toBeUndefined();
    expect(smallTalkReply("thanks, now show stats for DRY RUN")).toBeUndefined();
  });
});

describe("Bug 3 — clicks: said plainly (not tracked), click-rate question answered at account level", () => {
  it("the account summary has a Clicked line", async () => {
    const { formatAccountStatsMessage } = await import("../accountStats.js");
    const msg = formatAccountStatsMessage({ totalCampaigns: 38, sent: 79, delivered: 78, opened: 26, replied: 3, bounced: 1, openRate: 0.329 }, "How many campaigns do I have?");
    expect(msg).toContain("**Clicked:** not tracked yet");
  });

  it("'What is my click rate?' → the stats agent → 'not tracked' + the real open / reply rates (no pick list)", async () => {
    const { analyticsIntentFor } = await import("../campaignAnalytics.js");
    expect(analyticsIntentFor("What is my click rate?")).toBe("get_campaign_stats");
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_account_stats"
        ? { isToolError: false, data: { success: true, data: { sent: 79, opened: 26, replied: 3, openRate: 0.329, replyRate: 0.038 } } }
        : { isToolError: false, data: { success: true, data: [] } });
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage: "What is my click rate?" }));
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("does not track link clicks");
    expect(msg).toContain("**Opened:** 26 of 79 sent (32.9%)");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("per-campaign stats say 'not tracked' instead of 'Clicked: 0 (0.0%)'", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({
      intent: "get_campaign_stats", toolName: "get_campaign_stats", toolArgs: { campaignId: "434" },
      toolResult: { isToolError: false, data: { success: true, data: { campaignId: "434", campaignName: "DRY RUN", sent: 2, delivered: 2, opened: 1, openRate: 0.5, clicked: 0, clickRate: 0, bounced: 0, replied: 2 } } } as never,
    }));
    expect(JSON.parse(String(out.finalResponse)).message).toContain("**Clicked:** not tracked yet");
  });
});

describe("Bug 4 — a typo in the campaign name gets 'Did you mean …?' (not all campaigns)", () => {
  const campaigns = [
    { id: "449", name: "ALL", status: "paused" },
    { id: "434", name: "DRY RUN", status: "completed" },
    { id: "435", name: "NEW", status: "draft" },
    { id: "420", name: "BM AI Services", status: "completed" },
  ];

  it("closeCampaignMatches finds names one or two letters away, nothing for unrelated text", async () => {
    const { closeCampaignMatches } = await import("../campaignLookup.js");
    expect(closeCampaignMatches("dry rn", campaigns).map((c) => c.id)).toEqual(["434"]);
    expect(closeCampaignMatches("bm ai servces", campaigns).map((c) => c.id)).toEqual(["420"]);
    expect(closeCampaignMatches("holiday promo", campaigns)).toEqual([]);
  });

  it("'shwo stats for dry rn' → Did you mean DRY RUN (#434)? with only that choice", async () => {
    mockDispatch.mockResolvedValue({ isToolError: false, data: { success: true, data: campaigns } });
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage: "shwo stats for dry rn" }));
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("Did you mean **DRY RUN** (#434)?");
    expect(msg).not.toContain("BM AI Services");
    expect(patch.campaignSelectionList).toEqual([campaigns[1]]);
  });
});

describe("Bug 8 — AI wizard campaign name: real text, no HTML, no canned praise", () => {
  const atName = (userMessage: string) =>
    state({ intent: "create_ai_campaign", pendingAiCampaignStep: "campaign_name", pendingAiCampaignData: {}, userMessage } as never);

  it.each([
    ["😀🚀", "real words or numbers"],
    ['<b>Test</b><img src=x onerror="alert(1)">', "can't contain HTML tags"],
  ])("%s is rejected and the same step is asked again", async (name, expected) => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(atName(name));
    expect(String(patch.error)).toContain(expected);
    expect(patch.pendingAiCampaignStep).toBe("campaign_name");
    expect(patch.pendingAiCampaignData).toEqual({});
  });

  it("a real name moves on without 'great name!'", async () => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(atName("Summer Sale 2026 🚀"));
    expect(patch.pendingAiCampaignStep).toBe("campaign_subject");
    expect(String(patch.error)).toContain("Campaign name: **Summer Sale 2026 🚀**");
    expect(String(patch.error)).not.toContain("great name");
  });
});

describe("Bug 9 — leads per run outside 1-100 is asked again", () => {
  it.each(["150", "0", "-5", "many"])("'%s' → same question with 'between 1 and 100'", async (answer) => {
    const { applyAnswer, missingLeadSearchDetail } = await import("../leadgenArgs.js");
    const r = applyAnswer({ category: "real estate agencies", city: "Lahore", asked: ["focus", "perRun"] }, "perRun", answer)!;
    expect(r.targetPerRun).toBeUndefined();
    const next = missingLeadSearchDetail(r)!;
    expect(next.field).toBe("perRun");
    expect(next.question).toContain("between **1** and **100**");
  });

  it("valid numbers and skip still work", async () => {
    const { applyAnswer } = await import("../leadgenArgs.js");
    const base = { category: "dentists", city: "Lahore", asked: ["focus"] };
    expect(applyAnswer(base, "perRun", "100")!.targetPerRun).toBe(100);
    expect(applyAnswer(base, "perRun", "35 leads")!.targetPerRun).toBe(35);
    expect(applyAnswer(base, "perRun", "skip")!.targetPerRun).toBe(20);
  });
});

describe("Bug 10 — the focus question fits every industry", () => {
  it.each(["dental clinics", "real estate agencies"])("%s", async (category) => {
    const { missingLeadSearchDetail } = await import("../leadgenArgs.js");
    const q = missingLeadSearchDetail({ category, city: "Karachi" })!.question;
    expect(q).toContain(`Any special focus or niche for these **${category}**?`);
    expect(q).not.toMatch(/app development|e-commerce/);
  });
});

describe("Bug 11 — a non-CSV/Excel attachment gets a clear 400 (not dropped silently)", () => {
  it("notes.txt → ValidationError naming the file; data.csv / list.xlsx accepted", async () => {
    const { agentFileFilter } = await import("../agentFileFilter.js");
    const calls: Array<[Error | null, boolean | undefined]> = [];
    const cb = (e: Error | null, ok?: boolean) => { calls.push([e, ok]); };
    agentFileFilter({}, { originalname: "notes.txt" }, cb);
    agentFileFilter({}, { originalname: "data.csv" }, cb);
    agentFileFilter({}, { originalname: "list.XLSX" }, cb);
    expect(calls[0]![0]).toMatchObject({ statusCode: 400 });
    expect(calls[0]![0]!.message).toContain('Only CSV or Excel files (.csv, .xlsx, .xls) are supported — "notes.txt" was not used');
    expect(calls[1]).toEqual([null, true]);
    expect(calls[2]).toEqual([null, true]);
  });
});

describe("Bug 12 — empty file and wrong columns get their own clear messages", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("empty.csv (0 bytes) → 'The file is empty'", async () => {
    const { parseCompanyFile } = await import("../parseCompanyFile.js");
    const r = parseCompanyFile(b64(""));
    expect(r.ok === false && r.error).toContain("The file is empty");
  });

  it("wrong-columns.csv (foo,bar) → both missing columns named + the columns found", async () => {
    const { parseCompanyFile } = await import("../parseCompanyFile.js");
    const r = parseCompanyFile(b64("foo,bar\n1,2\n"));
    const error = r.ok === false ? r.error : "";
    expect(error).toContain("missing the required **Company Name** and **Website** columns");
    expect(error).toContain('Columns found: "foo", "bar"');
  });

  it("header only → 'no companies below them'", async () => {
    const { parseCompanyFile } = await import("../parseCompanyFile.js");
    const r = parseCompanyFile(b64("Company Name,Website\n"));
    expect(r.ok === false && r.error).toContain("no companies below them");
  });
});

describe("Bug 17 — a long campaign list: summary + 10 per page with links, how to see more", () => {
  const many = Array.from({ length: 38 }, (_, i) => ({ id: String(400 + i), name: `C${i + 1}`, status: i < 19 ? "completed" : i < 29 ? "paused" : "draft", recieptCount: 5 }));

  it("page 1: status summary, items 1-10 as links, page-2 hint", async () => {
    const { formatCampaignList } = await import("../../graph/nodes/finalResponse.node.js");
    const text = formatCampaignList(many, undefined);
    expect(text).toContain("**38 campaigns** (19 completed · 10 paused · 9 draft). Showing 1-10:");
    expect(text).toContain("1. [C1](/campaigns/400) (#400) — completed");
    expect(text).not.toContain("[C11]");
    expect(text).toContain("Say **show campaigns page 2** for the next 10");
  });

  it("'show campaigns page 4' → 31-38 and no next-page hint", async () => {
    const { formatCampaignList, campaignListPage } = await import("../../graph/nodes/finalResponse.node.js");
    const text = formatCampaignList(many, undefined, { page: campaignListPage("show campaigns page 4") });
    expect(text).toContain("Showing 31-38:");
    expect(text).toContain("31. [C31](/campaigns/430)");
    expect(text).not.toContain("page 5");
  });

  it("a short list stays as it was (all items)", async () => {
    const { formatCampaignList } = await import("../../graph/nodes/finalResponse.node.js");
    expect(formatCampaignList(many.slice(0, 3), undefined)).toContain("3. [C3](/campaigns/402)");
  });
});

describe("Bug 17 — 'show campaigns page 2' goes to the campaign list", () => {
  it.each(["show campaigns page 2", "show paused campaigns page 2"])("%s", async (userMessage) => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    const out = await detectIntentNode(state({ userMessage }));
    expect(out.intent).toBe("list_campaigns");
  });
});

describe("Bug 23 — a cancellation is a plain reply, not a 'More information needed' card", () => {
  it.each([
    "AI campaign wizard cancelled — nothing was created.",
    "Okay, cancelled — no lead search was started.",
    "Update cancelled. Let me know when you'd like to try again.",
  ])("%s", async (message) => {
    const { parseAgentResponse } = await import("../agentResponseFormatter.js");
    const out = parseAgentResponse(JSON.stringify({ status: "needs_input", intent: "create_ai_campaign", message })) as { status?: string; message: string };
    expect(out.status).toBeUndefined();
    expect(out.message).toBe(message);
  });

  it("the wizard 'stop' end-to-end through the clarification node gives a plain reply", async () => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const { clarificationNode } = await import("../../graph/nodes/clarification.node.js");
    const { parseAgentResponse } = await import("../agentResponseFormatter.js");
    const s = state({ intent: "create_ai_campaign", pendingAiCampaignStep: "campaign_name", pendingAiCampaignData: {}, userMessage: "stop" } as never);
    const patch = await campaignAgent.handle(s);
    const out = await clarificationNode({ ...s, ...patch } as never);
    const result = parseAgentResponse(String(out.finalResponse)) as { status?: string; message: string };
    expect(result.status).toBeUndefined();
    expect(result.message).toContain("cancelled — nothing was created");
  });

  it("a real question still gets the card", async () => {
    const { parseAgentResponse } = await import("../agentResponseFormatter.js");
    const out = parseAgentResponse(JSON.stringify({ status: "needs_input", intent: "x", message: "Which campaign do you mean?" })) as { status?: string };
    expect(out.status).toBe("needs_input");
  });
});

describe("Bug 18 — 'Show campaigns tagged QA-Auto' filters by tag", () => {
  it("campaignTagFrom reads the tag", async () => {
    const { campaignTagFrom } = await import("../../agents/CampaignAgent.js");
    expect(campaignTagFrom("Show campaigns tagged QA-Auto")).toBe("QA-Auto");
    expect(campaignTagFrom("list campaigns with tag VIP?")).toBe("VIP");
    expect(campaignTagFrom("campaigns with the 'QA E2E' tag")).toBe("QA E2E");
    expect(campaignTagFrom("Show all campaigns")).toBeUndefined();
  });

  it("the agent sends the tag to get_all_campaigns", async () => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(state({ intent: "list_campaigns", userMessage: "Show campaigns tagged QA-Auto" }));
    expect(patch.toolName).toBe("get_all_campaigns");
    expect(patch.toolArgs).toEqual({ tag: "QA-Auto" });
  });

  it("no campaign has the tag → says so (not the whole list)", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({
      intent: "list_campaigns", toolName: "get_all_campaigns", toolArgs: { tag: "QA-Auto" }, userMessage: "Show campaigns tagged QA-Auto",
      toolResult: { isToolError: false, data: { success: true, data: [] } } as never,
    }));
    expect(String(out.finalResponse)).toContain("No campaigns have the tag **QA-Auto**");
  });

  it("tagged campaigns are listed under a tag title", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({
      intent: "list_campaigns", toolName: "get_all_campaigns", toolArgs: { tag: "QA-E2E" }, userMessage: "Show campaigns tagged QA-E2E",
      toolResult: { isToolError: false, data: { success: true, data: [{ id: 446, name: "QA-TEST CRM E2E", status: "completed" }] } } as never,
    }));
    expect(String(out.finalResponse)).toContain("Campaigns tagged **QA-E2E** (1):");
    expect(String(out.finalResponse)).toContain("[QA-TEST CRM E2E](/campaigns/446)");
  });
});

describe("Bug 19 — 'Which SMTP account sent Campaign 3?' names that campaign's account", () => {
  it("routes to the stats agent only when a campaign is mentioned", async () => {
    const { analyticsIntentFor } = await import("../campaignAnalytics.js");
    expect(analyticsIntentFor("Which SMTP account sent Campaign 3?")).toBe("get_campaign_stats");
    expect(analyticsIntentFor("Which SMTP account is my default?")).toBeUndefined();
  });

  it("answers with the campaign's From email and account", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_all_campaigns"
        ? { isToolError: false, data: { success: true, data: [
            { id: 431, name: "Campaign 3", status: "completed", fromEmail: "testing@x.com", smtpSettingsId: 1 },
            { id: 434, name: "DRY RUN", status: "completed", fromEmail: "noor@x.com", smtpSettingsId: 2 },
          ] } }
        : tool === "get_smtp_settings"
          ? { isToolError: false, data: { success: true, data: { accounts: [
              { id: 1, fromEmail: "testing@x.com", fromName: "testing" },
              { id: 2, fromEmail: "noor@x.com", fromName: "Noor" },
            ] } } }
          : { isToolError: false, data: { success: true, data: [] } });
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage: "Which SMTP account sent Campaign 3?" }));
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toBe("**Campaign 3** (#431) was sent from **testing@x.com** (**testing**) — SMTP account #1.");
  });
});

describe("Bug 19 — detectIntent", () => {
  it("'Which SMTP account sent Campaign 3?' → get_campaign_stats", async () => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    const out = await detectIntentNode(state({ userMessage: "Which SMTP account sent Campaign 3?" }));
    expect(out.intent).toBe("get_campaign_stats");
  });
});

describe("Bug 20 — 'Which files did I upload for script generation?' lists the saved files", () => {
  it("routes to general_help (not the script-generation guide)", async () => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    const out = await detectIntentNode(state({ userMessage: "Which files did I upload for script generation?" }));
    expect(out.intent).toBe("general_help");
    const { generalTopicOf } = await import("../generalAnswers.js");
    expect(generalTopicOf("Save this file for script generation")).toBeUndefined();
  });

  it("answers with each file (name, companies, scripts, date) linked to its page", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "list_script_files"
        ? { isToolError: false, data: { success: true, data: { files: [
            { id: 9, filename: "cold_call_testing_companies.xlsx", companyCount: 6, totalRows: 6, scriptCount: 0, createdAt: "2026-10-27T10:00:00Z" },
            { id: 5, filename: "DRY RUN (1).xlsx", companyCount: 1, totalRows: 1, scriptCount: 3, createdAt: "2026-10-16T10:00:00Z" },
          ] } } }
        : { isToolError: false, data: { success: true, data: [] } });
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({ intent: "general_help", userMessage: "Which files did I upload for script generation?" }));
    const text = String(out.finalResponse);
    expect(text).toContain("You have saved **2 files** for script generation:");
    expect(text).toContain("1. [cold_call_testing_companies.xlsx](/scripts/files/9) — 6 companies, 0 scripts, saved 27 Oct 2026");
    expect(text).toContain("2. [DRY RUN (1).xlsx](/scripts/files/5) — 1 company, 3 scripts, saved 16 Oct 2026");
  });
});

describe("Bug 21 — the help card covers CRM, Lead Finder and Scripts", () => {
  it("'what can you do?' lists every area the chips offer", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const text = String((await finalResponseNode(state({ intent: "general_help", userMessage: "what can you do?" }))).finalResponse);
    for (const s of ["**AI Campaigns**", "**Campaigns**", "**Analytics**", "**Inbox**", "**CRM leads**", "**Lead Finder**", "**Scripts**", "**Settings**"]) {
      expect(text).toContain(s);
    }
    expect(text).toContain("- Show hot leads");
    expect(text).toContain("- Find new leads (business type + city)");
    expect(text).toContain("- Generate personalized emails from recipient CSV fields");
  });
});

describe("Bug 22 — automations, best time to send, plan: answered from the account", () => {
  it.each([
    ["Do I have any automations?", "automations"],
    ["What is the best time to send my emails?", "general_help"],
    ["Which plan am I on?", "general_help"],
  ])("%s → %s", async (userMessage, intent) => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    expect((await detectIntentNode(state({ userMessage }))).intent).toBe(intent);
  });

  it("best time: the hour the leads open most, in the user's time zone", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) =>
      tool === "get_best_send_time"
        ? { isToolError: false, data: { success: true, data: { timezone: args.timezone, totalOpens: 26, bestHour: 3, hours: [{ hour: 3, opens: 12 }, { hour: 15, opens: 8 }, { hour: 9, opens: 6 }] } } }
        : { isToolError: false, data: { success: true, data: {} } });
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const text = String((await finalResponseNode(state({ intent: "general_help", userMessage: "What is the best time to send my emails?", clientTimezone: "Asia/Karachi" } as never))).finalResponse);
    expect(text).toContain("Your leads open emails most around **3 AM** (Asia/Karachi time), based on 26 opens.");
    expect(text).toContain("Busiest hours: 3 AM (12), 3 PM (8), 9 AM (6).");
  });

  it("plan: the name and what it includes", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_account_plan"
        ? { isToolError: false, data: { success: true, data: { plan: { code: "standard", name: "Standard", smtpLimit: 3, dailyEmailLimit: 500, inboxEnabled: true, followUpEnabled: true, crmEnabled: true, leadGenEnabled: false } } } }
        : { isToolError: false, data: { success: true, data: {} } });
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const text = String((await finalResponseNode(state({ intent: "general_help", userMessage: "Which plan am I on?" }))).finalResponse);
    expect(text).toContain("You're on the **Standard** plan:");
    expect(text).toContain("- Email accounts (SMTP): up to **3**");
    expect(text).toContain("- Lead Finder: ✗ not included");
  });
});

describe("Bug 25 — an out-of-range pick number gets a short answer; a campaign ID works", () => {
  const list = Array.from({ length: 38 }, (_, i) => ({ id: String(400 + i), name: `C${i + 1}`, status: "completed" }));
  list[34] = { id: "434", name: "DRY RUN", status: "completed" };
  const picking = (userMessage: string) =>
    state({ intent: "get_campaign_stats", userMessage, pendingCampaignAction: "get_campaign_stats", campaignSelectionList: list } as never);

  it.each(["50", "0"])("'%s' → pick 1 to 38, no list posted again", async (n) => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(picking(n));
    expect(String(patch.error)).toContain(`There's no campaign **${n}** in the list. Please reply with a number from **1** to **38**`);
    expect(String(patch.error)).not.toContain("C1");
    expect(patch.pendingCampaignAction).toBe("get_campaign_stats");
  });

  it("'434' (an ID, not a list number) → stats for DRY RUN", async () => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(picking("434"));
    expect(patch.toolName).toBe("get_campaign_stats");
    expect(patch.toolArgs).toEqual({ campaignId: "434" });
  });

  it("'3' is still the 3rd item", async () => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    const patch = await campaignAgent.handle(picking("3"));
    expect(patch.toolArgs).toEqual({ campaignId: "402" });
  });
});

describe("Bug 26 — open / reply rate advice gets tips from the account numbers", () => {
  it.each([
    "How can I improve my open rate?",
    "Why is my open rate low?",
    "Give me tips to get more replies",
  ])("%s", async (userMessage) => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    expect((await detectIntentNode(state({ userMessage }))).intent).toBe("get_campaign_stats");
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_account_stats"
        ? { isToolError: false, data: { success: true, data: { totalCampaigns: 38, sent: 79, opened: 26, replied: 3, bounced: 1 } } }
        : { isToolError: false, data: { success: true, data: [] } });
    const { analyticsAgent } = await import("../../agents/AnalyticsAgent.js");
    const patch = await analyticsAgent.handle(state({ intent: "get_campaign_stats", userMessage }));
    const msg = JSON.parse(String(patch.formattedResponse)).message as string;
    expect(msg).toContain("**What you can do:**");
    expect(msg).toContain("For replies: short, personal emails");
    expect(patch.pendingCampaignAction).toBeUndefined();
  });
});

describe("Bug 29 — script file: same-website companies kept, skipped rows named, English words", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const csv = [
    "Company Name,Website",
    "QA Dup Co,example.com",
    "QA Dup Co,example.com",
    "اردو کمپنی,example.com",
    "QA Bad Site Co,not a website",
    "QA Empty Site Co,",
    ",nameless.com",
  ].join("\n");

  it("parse: the Urdu-named company at example.com is kept; each skipped row has its reason", async () => {
    const { parseCompanyFile, formatParseReport, formatSkippedRows } = await import("../parseCompanyFile.js");
    const r = parseCompanyFile(b64(csv));
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.companyName)).toEqual(["QA Dup Co", "اردو کمپنی"]);
    expect(formatParseReport(r.report)).toBe("6 rows: 2 valid, 1 missing website, 1 invalid website, 1 missing company name, 1 duplicate.");
    expect(formatSkippedRows(r.skipped)).toEqual([
      "Row 3 — QA Dup Co: duplicate",
      "Row 5 — QA Bad Site Co: invalid website",
      "Row 6 — QA Empty Site Co: missing website",
      "Row 7 — (no company name): missing company name",
    ]);
  });

  it("the agent reply and card data list the rows that were not saved", async () => {
    mockDispatch.mockResolvedValue({ isToolError: false, data: { success: true, data: { fileId: 7, filename: "dups.csv", companyCount: 2, totalRows: 6, report: {}, createdAt: "" } } });
    const { scriptFileAgent } = await import("../../agents/ScriptFileAgent.js");
    const patch = await scriptFileAgent.handle(state({ userMessage: "Save this file for script generation", pendingCsvFile: { filename: "dups.csv", fileContent: b64(csv) } } as never));
    const body = JSON.parse(String(patch.formattedResponse));
    expect(body.message).toContain("**Not saved:**\n- Row 3 — QA Dup Co: duplicate");
    expect(body.data.skippedRows).toContain("Row 5 — QA Bad Site Co: invalid website");
  });
});

describe("Bug 32 — common assistant requests get a useful answer or a clear 'not supported'", () => {
  const ask = async (userMessage: string) => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const d = await detectIntentNode(state({ userMessage }));
    const out = await finalResponseNode(state({ intent: d.intent, userMessage }));
    return { intent: d.intent, text: String(out.finalResponse) };
  };

  it("subject line ideas: 5 ideas for the topic (not a menu, not a campaign draft)", async () => {
    const { intent, text } = await ask("Give me 5 subject line ideas for a Black Friday sale email");
    expect(intent).toBe("general_help");
    expect(text).toContain("Here are 5 subject line ideas for **Black Friday sale**:");
    expect(text).toContain("5. ");
    expect(text).not.toContain("6. ");
  });

  it("spam check: names the signals", async () => {
    const { text } = await ask("Is this subject line spammy: FREE!!! WIN $$$ NOW");
    expect(text).toContain('**"FREE!!! WIN $$$ NOW"** is likely to look spammy:');
    expect(text).toContain('spam trigger words: "free"');
    expect(text).toContain("mostly CAPITAL letters");
    expect(text).toContain("several exclamation marks");
    expect(text).toContain("money symbols");
  });

  it("translate: a clear, same-every-time 'not supported yet'", async () => {
    const { intent, text } = await ask("Translate to Urdu: Thank you for joining our webinar");
    expect(intent).toBe("general_help");
    expect(text).toContain("Translating text isn't supported in the chat yet.");
  });

  it("what should I do today: a plan from the account", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "get_all_campaigns"
        ? { isToolError: false, data: { success: true, data: [
            { id: 441, name: "QA-TEST Daily limit 1", status: "paused", recipientCount: 3 },
            { id: 448, name: "Draft A", status: "draft", recipientCount: 0 },
          ] } }
        : tool === "list_crm_needs_reply"
          ? { isToolError: false, data: { success: true, data: { leads: [], counts: { waiting: 2, overdue: 1, snoozed: 0 } } } }
          : { isToolError: false, data: { success: true, data: {} } });
    const { text } = await ask("What should I do today?");
    expect(text).toContain("Here's what I'd do today:");
    expect(text).toContain("1. Answer **2 leads** waiting for your reply (1 overdue)");
    expect(text).toContain("**1 paused campaign** (e.g. **QA-TEST Daily limit 1**)");
    expect(text).toContain("Finish **1 draft** (1 still without recipients)");
  });

  it("draft a reply to TAYYAB's reply: a draft for that reply, nothing sent", async () => {
    mockDispatch.mockImplementation(async (tool: string) =>
      tool === "list_replies"
        ? { isToolError: false, data: { success: true, data: { items: [
            { id: 1, fromName: "Ali Khan", fromEmail: "ali@x.com", subject: "Re: Offer", bodyText: "No thanks" },
            { id: 2, fromName: "TAYYAB Ahmed", fromEmail: "tayyab@x.com", subject: "Re: Demo", bodyText: "Can we talk next week?" },
          ] } } }
        : { isToolError: false, data: { success: true, data: {} } });
    const { intent, text } = await ask("Draft a reply to TAYYAB's reply");
    expect(intent).toBe("general_help");
    expect(text).toContain("Here's a draft reply to **TAYYAB Ahmed** (re: Demo):");
    expect(text).toContain("> Hi TAYYAB,");
    expect(text).toContain("Nothing was sent.");
    expect(mockDispatch).not.toHaveBeenCalledWith("draft_reply_suggestion", expect.anything(), expect.anything());
  });

  it("revenue: stats plus 'revenue is not tracked' (no invented number)", async () => {
    const { finalResponseNode } = await import("../../graph/nodes/finalResponse.node.js");
    const out = await finalResponseNode(state({
      intent: "get_campaign_stats", toolName: "get_campaign_stats", toolArgs: { campaignId: "464" }, userMessage: "How much revenue did campaign 464 generate?",
      toolResult: { isToolError: false, data: { success: true, data: { campaignId: "464", campaignName: "X", sent: 2, delivered: 2, opened: 1, openRate: 0.5, clicked: 0, bounced: 0, replied: 0 } } } as never,
    }));
    const text = String(out.finalResponse);
    expect(text).toContain("MailFlow does not track revenue or sales from campaigns");
    expect(text).toContain("**Sent:** 2");
  });
});
