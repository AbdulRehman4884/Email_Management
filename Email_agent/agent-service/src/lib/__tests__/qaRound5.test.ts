/** QA P3 batch 2 (bugs 1-30 of the second list) — full graph, fake MCP, nothing is sent. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({ getOpenAIService: () => undefined, OpenAIServiceError: class extends Error {} }));
import { agentGraph } from "../../graph/workflow/agent.workflow.js";

type C = Record<string, unknown>;
const ok = (data: unknown) => ({ isToolError: false, data: { success: true, data } });
let campaigns: C[] = [];
let replies: C[] = [];
const calls: Array<[string, C]> = [];
const contacts = [
  { id: 1, name: "TAYYAB", email: "tayyab@x.com", score: 60, tier: "warm", stageName: "Interested" },
  { id: 2, name: "Cold One", email: "c1@x.com", score: 5, tier: "cold", stageName: "New" },
];

function fake(tool: string, args: C) {
  calls.push([tool, args]);
  const id = String(args.campaignId ?? "");
  switch (tool) {
    case "get_all_campaigns": return ok(campaigns);
    case "get_campaign_stats": return ok({ campaignId: id, campaignName: campaigns.find((c) => String(c.id) === id)?.name, sent: 2, delivered: 2, opened: 1, openRate: 0.5, clicked: 0, bounced: 0, replied: 2 });
    case "get_account_stats": return ok({ totalCampaigns: campaigns.length, campaignsByStatus: { draft: 4, completed: 2 }, sent: 79, delivered: 78, opened: 26, replied: 3, bounced: 1, openRate: 0.33, replyRate: 0.04, bounceRate: 0.01 });
    case "list_replies": return ok({ items: replies, total: replies.length });
    case "list_crm_contacts": {
      const tiers = (args.tiers ?? args.tier) as unknown;
      const t = Array.isArray(tiers) ? tiers[0] : tiers;
      const list = t ? contacts.filter((c) => c.tier === t) : contacts;
      return ok({ contacts: list, total: list.length, limit: 10, offset: 0, page: 1 });
    }
    case "get_crm_summary": return ok({ pipeline: { name: "Sales" }, kpis: { total: 23, winRate: 25, interested: 1, meetings: 0, won: 1, lost: 3, needsReply: 1, hot: 0 }, stages: [], labels: {}, funnel: [] });
    case "list_crm_forms": return ok({ forms: [{ id: 1, name: "New form" }] });
    case "get_smtp_settings": return ok({ accounts: [{ id: 1, fromEmail: "t@x.com", fromName: "testing" }], quotas: [{ smtpSettingsId: 1, fromEmail: "t@x.com", dailyLimit: 20, sentToday: 8, remaining: 12 }] });
    case "list_search_schedules": return { isToolError: true, data: { success: false, error: { code: "PLAN_FEATURE_REQUIRED", message: "Your plan does not include the Lead Finder" } } };
    default: return ok({});
  }
}

async function say(userMessage: string, sessionId = randomUUID()) {
  const out = (await agentGraph.invoke({ userMessage, sessionId, userId: "2", rawToken: "t", messages: [], clientTimezone: "Asia/Karachi" } as never)) as C;
  const raw = String(out.finalResponse ?? "");
  let text = raw;
  try { const j = JSON.parse(raw); if (j && typeof j.message === "string") text = j.message; } catch { /* plain */ }
  return { out, text, sessionId, tool: out.toolName as string | undefined, args: (out.toolArgs ?? {}) as C, approval: !!out.requiresApproval };
}

beforeEach(() => {
  campaigns = [
    { id: 434, name: "DRY RUN", status: "completed", recipientCount: 2 },
    { id: 431, name: "Campaign 3", status: "completed", recipientCount: 2 },
    { id: 441, name: "QA-TEST Daily limit 1", status: "paused", recipientCount: 2 },
    { id: 449, name: "ALL", status: "paused", recipientCount: 2 },
    { id: 405, name: "ok", status: "completed", recipientCount: 1 },
    { id: 355, name: "ok", status: "completed", recipientCount: 1 },
    { id: 1, name: "Draft A", status: "draft", recipientCount: 0 },
    { id: 2, name: "Draft B", status: "draft", recipientCount: 0 },
    { id: 3, name: "Draft C", status: "draft", recipientCount: 5 },
  ];
  replies = [
    { id: 1, fromName: "Saeed", fromEmail: "saeed@x.com", subject: "Re: HELLO", bodyText: "YES BUDDY\n\nOn Fri, Oct 16, 2026, 2:28 AM testing <t@x.com> wrote:\n> HOW ARE YOU", receivedAt: "2026-10-16T02:32:00Z", campaignId: 434 },
    { id: 2, fromName: "Osama", fromEmail: "osama@x.com", subject: "Re: HELLO", bodyText: "Yes", receivedAt: "2026-10-16T03:00:00Z", campaignId: 434 },
    { id: 3, fromName: "Zed", fromEmail: "zed@x.com", subject: "Re: ok", bodyText: "Maybe", receivedAt: "2026-05-09T03:43:00Z", campaignId: 405 },
  ];
  calls.length = 0;
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async (t: string, a: C) => fake(t, a ?? {}));
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
});

const noPlanner = (t: string) => expect(t).not.toMatch(/Completed \d+ steps?|Step \d+ |Step completed|couldn't finish the remaining step/i);

describe("P3-2 #1/#2/#24/#29 no planner wording", () => {
  it.each([
    "List campaigns with 0 recipients", "Which campaigns have no recipients?",
    "list my paused campaigns with their stats", "Who is my hottest lead?",
    "<b>show my campaigns</b><script>alert(1)</script>", "Show stats for campaigns 434 and 431",
  ])("%s", async (m) => {
    const r = await say(m);
    noPlanner(r.text);
    expect(r.text).not.toMatch(/something went wrong/i);
  });
  it("#1 lists the campaigns with no recipients", async () => {
    const r = await say("Which campaigns have no recipients?");
    expect(r.text).toContain("Draft A");
    expect(r.text).toContain("Draft B");
    expect(r.text).not.toContain("Draft C");
  });
});

describe("P3-2 #3 direct answers", () => {
  it.each([
    ["Can you delete a campaign?", /delete/i],
    ["What does bounce rate mean?", /percentage of sent emails/i],
    ["How many emails can I still send today?", /left/i],
    ["Show me the email content of DRY RUN", /Campaigns page/i],
    ["Who are the recipients of DRY RUN?", /recipient/i],
  ])("%s", async (m, re) => {
    const r = await say(m);
    expect(r.text).toMatch(re);
    expect(r.text).not.toMatch(/Which part would you like to work on/);
  });
});

describe("P3-2 #4/#16 replies: quoted text stripped, local time", () => {
  it("shows only what the person wrote, in the account's time", async () => {
    const r = await say("Show inbox replies");
    expect(r.text).toContain("YES BUDDY");
    expect(r.text).not.toMatch(/wrote:|HOW ARE YOU/);
    expect(r.text).toContain("07:32 AM");
  });
});

describe("P3-2 #5 pick lists show ids", () => {
  it("stats pick list", async () => {
    const r = await say("Show stats");
    expect(r.text).toMatch(/ok.*#405/);
    expect(r.text).toMatch(/ok.*#355/);
  });
});

describe("P3-2 #6 replies after a stats question say they are filtered", () => {
  it("note or all", async () => {
    const a = await say("Show stats for campaign id 434");
    const b = await say("Show inbox replies", a.sessionId);
    expect(b.text).toMatch(/3 replies|only|of 3/i);
  });
});

describe("P3-2 #10/#11/#18 AI wizard (steps seeded)", () => {
  const at = async (step: string, userMessage: string, data: C = { campaignName: "Diwali offer test", subject: "Monthly update" }) => {
    const { campaignAgent } = await import("../../agents/CampaignAgent.js");
    return campaignAgent.handle({ intent: "create_ai_campaign", userMessage, messages: [], userId: "2", rawToken: "t", pendingAiCampaignStep: step, pendingAiCampaignData: data } as never);
  };
  it("#10 back at the subject step returns to the name", async () => {
    const p = await at("campaign_subject", "back", { campaignName: "Diwali offer test" });
    expect(p.pendingAiCampaignStep).toBe("campaign_name");
    expect(String(p.error)).not.toMatch(/Subject set: back/);
  });
  it("#10 the wizard tells how to go back / stop", async () => {
    const p = await at("campaign_name", "Diwali offer test", {});
    expect(String(p.error)).toMatch(/back/i);
    expect(String(p.error)).toMatch(/stop/i);
  });
  it("#11 a stray message mid-wizard says how to leave", async () => {
    const p = await at("template_selection", "Hello");
    expect(String(p.error)).toMatch(/stop|cancel/i);
  });
  it("#18 asking for subject help is not saved as the subject; ideas are offered", async () => {
    for (const m of ["Can you suggest a good subject line for me?", "aap khud acha sa subject likh do"]) {
      const p = await at("campaign_subject", m, { campaignName: "Diwali offer test" });
      expect(String(p.error)).not.toMatch(/Subject set:/);
      expect(String(p.error)).toMatch(/1\./);
      expect(p.pendingAiCampaignStep).toBe("campaign_subject");
    }
  });
});

describe("P3-2 #12/#13 Lead Finder plan check first, English only", () => {
  it("first message already says the plan does not include it", async () => {
    const r = await say("Find new leads");
    expect(r.text).toMatch(/does not include the Lead Finder/i);
    expect(r.text).not.toMatch(/shehar/i);
  });
  it("file error is English", async () => {
    const { parseCompanyFile } = await import("../parseCompanyFile.js");
    const r = parseCompanyFile(Buffer.from("foo,bar\n1,2\n").toString("base64"));
    expect(JSON.stringify(r)).not.toMatch(/nahi mila/);
  });
});

describe("P3-2 #17 warm leads", () => {
  it("lists warm leads", async () => {
    const r = await say("Show warm leads");
    expect(r.text).toContain("TAYYAB");
    expect(r.text).not.toMatch(/No hot leads/);
  });
});

describe("P3-2 #19 replies from one person", () => {
  it.each([["What did Saeed reply?", "Saeed", "Osama"], ["Show me replies from Osama", "Osama", "Saeed"]])("%s", async (m, yes, no) => {
    const r = await say(m);
    expect(r.text.toLowerCase()).toContain(yes.toLowerCase());
    expect(r.text).not.toContain(no);
  });
});

describe("P3-2 #20/#21/#28 follow-ups after a stats question", () => {
  it.each(["and the same for campaign 431", "no, I meant Campaign 3", "sorry, I meant Campaign 3", "no I meant ALL"])("%s", async (m) => {
    const a = await say("Show stats for DRY RUN");
    const b = await say(m, a.sessionId);
    expect(b.tool).toBe("get_campaign_stats");
    expect(b.text).not.toMatch(/Which field|currently working on/);
  });
});

describe("P3-2 #22/#26 stats phrasing", () => {
  it.each([
    "DRY RUN ka open rate kya hai?", "What is the open rate of DRY RUN?", "DRY RUN stats please", "dry run stats",
    "Can you show me DRY RUN numbers?", "Could you please, if it's not too much trouble, tell me how my DRY RUN campaign did?",
    "Hey, can you quickly tell me how my DRY RUN campaign did? I want to know opens and replies.",
  ])("%s", async (m) => {
    const r = await say(m);
    expect(r.args).toEqual({ campaignId: "434" });
  });
});

describe("P3-2 #23 CRM questions", () => {
  it("leads / win rate / forms", async () => {
    expect((await say("How many leads do I have in my CRM?")).text).toContain("23");
    expect((await say("What is my win rate?")).text).toContain("25");
    expect((await say("How many forms do I have?")).text).toMatch(/\b1\b/);
  });
});

describe("P3-2 #25 pause on a campaign that is not running", () => {
  it("no approval card", async () => {
    const r = await say("Pause campaign 441");
    expect(r.approval).toBe(false);
    expect(r.text).toMatch(/paused/i);
  });
});

describe("P3-2 #27 overview", () => {
  it.each(["how am I doing?", "give me an overview", "how are my campaigns doing?"])("%s", async (m) => {
    const r = await say(m);
    expect(r.text).toMatch(/79/);
    noPlanner(r.text);
  });
});
