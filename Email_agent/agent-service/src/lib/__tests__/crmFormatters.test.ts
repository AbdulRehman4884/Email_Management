import { describe, expect, it } from "vitest";
import { CRM_PLAN_MESSAGE, formatCrmResult, hoursText } from "../crmFormatters.js";
import type { McpToolResult } from "../../types/mcp.js";

const ok = (data: unknown): McpToolResult => ({ data: { success: true, data }, isToolError: false, rawContent: [] });
const parse = (s: string) => JSON.parse(s) as { status: string; intent: string; message: string };

describe("formatCrmResult — failures", () => {
  it("turns the backend plan error into an upgrade message", () => {
    const result: McpToolResult = {
      data: {
        success: false,
        error: {
          code: "MAILFLOW_API_ERROR",
          httpStatus: 403,
          details: { error: "Your current plan (Basic) does not include this feature. Please upgrade to access it.", code: "PLAN_FEATURE_REQUIRED" },
        },
      },
      isToolError: false,
      rawContent: [],
    };
    const out = parse(formatCrmResult("crm_summary", "get_crm_summary", result));
    expect(out.status).toBe("error");
    expect(out.message).toBe(CRM_PLAN_MESSAGE);
  });

  it("shows the backend's not-found text", () => {
    const result: McpToolResult = {
      data: { success: false, error: { code: "MAILFLOW_NOT_FOUND", httpStatus: 404, details: { error: "Lead not found" } } },
      isToolError: true,
      rawContent: [],
    };
    expect(parse(formatCrmResult("crm_lead_details", "get_crm_contact", result)).message).toBe("Lead not found.");
  });
});

describe("formatCrmResult — summary", () => {
  it("lists KPIs, stages and the funnel", () => {
    const msg = parse(formatCrmResult("crm_summary", "get_crm_summary", ok({
      pipeline: { id: 1, name: "Sales Pipeline" },
      kpis: { total: 20, interested: 4, meetings: 2, won: 1, lost: 1, winRate: 50, needsReply: 3, hot: 5 },
      stages: [{ id: 1, name: "Contacted", count: 10, avgDaysInStage: 2.5 }, { id: 2, name: "Replied", count: 6, avgDaysInStage: 0 }],
      labels: { interested: 4, none: 10 },
      funnel: [{ name: "Contacted", reached: 20, conversionFromPrev: null }, { name: "Replied", reached: 8, conversionFromPrev: 40 }],
    }))).message;
    expect(msg).toContain("CRM overview — Sales Pipeline");
    expect(msg).toContain("Win rate: **50%**");
    expect(msg).toContain("- Contacted: **10** (avg 2.5 days in stage)");
    expect(msg).toContain("- Replied: **6**\n");
    expect(msg).toContain("**Funnel:** Contacted 20 → Replied 8 (40%)");
    expect(msg).toContain("🟢 Interested 4");
  });

  it("explains a missing pipeline and an unknown campaign", () => {
    expect(parse(formatCrmResult("crm_summary", "get_crm_summary", ok({ pipeline: null, kpis: null, stages: [], labels: {}, funnel: [] }))).message)
      .toContain("don't have a CRM pipeline yet");
    expect(parse(formatCrmResult("crm_summary", "get_crm_summary", ok({ pipeline: null, unknownCampaign: "Xmas", availableCampaigns: ["Summer"] }))).message)
      .toContain("**Xmas**");
  });
});

describe("formatCrmResult — leads", () => {
  const ali = {
    id: 1, email: "ali@shop.com", name: "Ali Khan", company: "Shop", stageName: "Interested", score: 75, scoreTier: "hot",
    lastReplyLabel: "interested", needsReply: true, tags: [{ id: 1, name: "VIP", color: "#000" }],
  };

  it("shows one line of facts per lead and says when the list is cut", () => {
    const msg = parse(formatCrmResult("crm_list_leads", "list_crm_contacts", ok({
      contacts: [ali], total: 12, appliedFilters: { stageName: "Interested" },
    }))).message;
    expect(msg).toContain("**12 leads** — stage **Interested**");
    expect(msg).toContain("1. **Ali Khan** — ali@shop.com · Shop");
    expect(msg).toContain("Stage: Interested · 🔥 Hot 75 · 🟢 Interested · ⏳ needs your reply · tags: VIP");
    expect(msg).toContain("Showing 1 of 12");
  });

  it("lists the real stages when the stage name is unknown", () => {
    const msg = parse(formatCrmResult("crm_list_leads", "list_crm_contacts", ok({
      contacts: [], total: 0, appliedFilters: {}, unknownStage: "Negotiation", availableStages: ["New Lead", "Won"],
    }))).message;
    expect(msg).toContain("no stage called **Negotiation**");
    expect(msg).toContain("New Lead, Won");
  });

  it("asks which lead when several match", () => {
    const msg = parse(formatCrmResult("crm_lead_details", "get_crm_contact", ok({
      detail: null, query: "ali",
      matches: [{ id: 1, email: "ali@shop.com", name: null, stageName: "New Lead" }, { id: 2, email: "ali@xyz.com", name: "Ali R", stageName: "Won" }],
    }))).message;
    expect(msg).toContain("I found 2 leads matching **ali**");
    expect(msg).toContain("1. **ali@shop.com** · New Lead");
    expect(msg).toContain("2. **Ali R** — ali@xyz.com · Won");
  });

  it("shows a lead with why-this-score and stage history", () => {
    const msg = parse(formatCrmResult("crm_lead_details", "get_crm_contact", ok({
      detail: {
        contact: { ...ali, pipelineName: "Sales", stageEnteredAt: "2026-10-01T10:00:00Z", openCount: 2, campaignCount: 1 },
        campaigns: [{ id: 3, name: "Black Friday" }],
        replies: [{ id: 9, direction: "inbound", label: "interested", subject: "Re: hi", snippet: "Sounds good", receivedAt: "2026-10-02T00:00:00Z" }],
        history: [{ fromName: "Replied", toName: "Interested", ruleName: "Interested reply", at: "2026-10-02T00:00:00Z" }],
        score: { events: [{ points: 40, reason: "Reply labeled Interested" }] },
      },
      matches: [],
    }))).message;
    expect(msg).toContain("- Stage: **Interested** (Sales) since 2026-10-01");
    expect(msg).toContain("- +40 Reply labeled Interested");
    expect(msg).toContain('2026-10-02: Replied → **Interested** (rule "Interested reply")');
    expect(msg).toContain("**Campaigns:** Black Friday");
  });
});

describe("formatCrmResult — needs reply, pipelines, tags", () => {
  it("needs reply: urgent first, with counts", () => {
    const msg = parse(formatCrmResult("crm_needs_reply", "list_crm_needs_reply", ok({
      leads: [{ name: "Ali", email: "ali@shop.com", waitingHours: 30, label: "question", priority: "high", overdue: true, snippet: "What is the price?" }],
      counts: { waiting: 4, overdue: 1, snoozed: 2 },
    }))).message;
    expect(msg).toContain("**4 leads are waiting for your reply** — 1 overdue");
    expect(msg).toContain("waiting 30h · 🔵 Question · high priority · ⚠️ overdue");
    expect(msg).toContain('"What is the price?"');
    expect(msg).toContain("2 more are snoozed");
  });

  it("needs reply: nobody waiting", () => {
    expect(parse(formatCrmResult("crm_needs_reply", "list_crm_needs_reply", ok({ leads: [], counts: { waiting: 0, overdue: 0, snoozed: 0 } }))).message)
      .toBe("Nobody is waiting for your reply right now.");
  });

  it("pipelines show stage flags", () => {
    const msg = parse(formatCrmResult("crm_list_pipelines", "list_crm_pipelines", ok({
      pipelines: [{ name: "Sales", isDefault: true, contactCount: 5, ruleCount: 8, stages: [
        { name: "Won", type: "won", manualOnly: true, stopFollowUps: true, contactCount: 1 },
      ] }],
    }))).message;
    expect(msg).toContain("**Sales** (default) — 5 leads, 8 rules");
    expect(msg).toContain("1. Won — 1 leads (Won, manual only, stops follow-ups)");
  });

  it("tags and empty tags", () => {
    expect(parse(formatCrmResult("crm_list_tags", "list_crm_tags", ok({ tags: [{ name: "VIP", scope: "both", contactCount: 3, campaignCount: 1 }] }))).message)
      .toContain("- **VIP** — 3 leads, 1 campaigns");
    expect(parse(formatCrmResult("crm_list_tags", "list_crm_tags", ok({ tags: [] }))).message).toContain("no tags yet");
  });
});

describe("hoursText", () => {
  it("uses hours under two days, then days", () => {
    expect(hoursText(0.4)).toBe("under 1h");
    expect(hoursText(30)).toBe("30h");
    expect(hoursText(72)).toBe("3 days");
  });
});
