import { describe, expect, it, vi } from "vitest";
import {
  getCrmContactTool,
  getCrmSummaryTool,
  listCrmContactsTool,
  listCrmNeedsReplyTool,
  listCrmPipelinesTool,
  normalizeName,
} from "../../mcp/tools/crm/crm.tools.js";
import { GetCrmContactSchema, ListCrmContactsSchema } from "../../schemas/crm.schemas.js";
import { MailFlowApiError } from "../../lib/errors.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";

const stages = [
  { id: 11, pipelineId: 1, name: "Interested", color: "#22c55e", position: 3, type: "normal", manualOnly: false, stopFollowUps: true, contactCount: 2 },
  { id: 12, pipelineId: 1, name: "Meeting Booked", color: "#a855f7", position: 4, type: "normal", manualOnly: false, stopFollowUps: true, contactCount: 0 },
];
const pipelines = [{ id: 1, name: "Sales", isDefault: true, createdAt: "", stageCount: 2, ruleCount: 0, contactCount: 2 }];
const emptyList = { contacts: [], total: 0, limit: 10, offset: 0, page: 1 };

function ctx(overrides: Parameters<typeof createMockMailflowClient>[0] = {}) {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      listCrmPipelines: vi.fn().mockResolvedValue(pipelines),
      listCrmStages: vi.fn().mockResolvedValue(stages),
      listCrmContacts: vi.fn().mockResolvedValue(emptyList),
      listCrmTags: vi.fn().mockResolvedValue([
        { id: 5, name: "VIP", color: "#000000", scope: "both", contactCount: 1, campaignCount: 0, createdAt: "" },
        { id: 6, name: "Q4 push", color: "#000000", scope: "campaign", contactCount: 0, campaignCount: 1, createdAt: "" },
      ]),
      ...overrides,
    }),
  });
}

describe("normalizeName", () => {
  it("ignores case, spaces, underscores and dashes", () => {
    expect(normalizeName("Meeting  Booked")).toBe(normalizeName("meeting_booked"));
    expect(normalizeName("meeting-booked")).toBe("meetingbooked");
  });
});

describe("list_crm_contacts", () => {
  it("resolves a stage name to its id", async () => {
    const c = ctx();
    const result = await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ stage: "meeting booked" }), c);
    expect(c.mailflow.listCrmContacts).toHaveBeenCalledWith(expect.objectContaining({ stageId: 12, limit: 10 }));
    expect(result).toEqual({ success: true, data: expect.objectContaining({ appliedFilters: { stageName: "Meeting Booked" } }) });
  });

  it("returns the stage list instead of searching when the stage is unknown", async () => {
    const c = ctx();
    const result = await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ stage: "Negotiation" }), c);
    expect(c.mailflow.listCrmContacts).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ unknownStage: "Negotiation", availableStages: ["Interested", "Meeting Booked"], total: 0 }),
    });
  });

  it("resolves tag names and never uses campaign-only tags", async () => {
    const c = ctx();
    await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ tags: ["vip"] }), c);
    expect(c.mailflow.listCrmContacts).toHaveBeenCalledWith(expect.objectContaining({ tagIds: [5] }));

    const c2 = ctx();
    const result = await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ tags: ["Q4 push"] }), c2);
    expect(c2.mailflow.listCrmContacts).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: expect.objectContaining({ unknownTags: ["Q4 push"], availableTags: ["VIP"] }) });
  });

  it("passes plain filters through", async () => {
    const c = ctx();
    await listCrmContactsTool.handler(
      ListCrmContactsSchema.parse({ labels: ["interested"], scoreTiers: ["hot"], needsReply: true, sort: "score", limit: 5 }),
      c,
    );
    expect(c.mailflow.listCrmContacts).toHaveBeenCalledWith({
      labels: ["interested"], scoreTiers: ["hot"], needsReply: true, sort: "score", limit: 5,
    });
  });

  it("rejects unknown labels at the schema", () => {
    expect(ListCrmContactsSchema.safeParse({ labels: ["maybe"] }).success).toBe(false);
  });
});

describe("campaign by name", () => {
  const campaigns = [
    { id: "3", name: "Black Friday" },
    { id: "4", name: "Black Friday Follow-up" },
    { id: "5", name: "Summer Sale" },
  ];

  it("resolves an exact name even when another name contains it", async () => {
    const c = ctx({ getAllCampaigns: vi.fn().mockResolvedValue(campaigns) });
    const result = await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ campaign: "black friday" }), c);
    expect(c.mailflow.listCrmContacts).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 3 }));
    expect(result).toEqual({ success: true, data: expect.objectContaining({ appliedFilters: { campaignName: "Black Friday" } }) });
  });

  it("uses a numeric id directly", async () => {
    const c = ctx({ getAllCampaigns: vi.fn() });
    await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ campaign: 42 }), c);
    expect(c.mailflow.getAllCampaigns).not.toHaveBeenCalled();
    expect(c.mailflow.listCrmContacts).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 42 }));
  });

  it("does not guess when several campaigns match partly", async () => {
    const c = ctx({ getAllCampaigns: vi.fn().mockResolvedValue(campaigns) });
    const result = await listCrmContactsTool.handler(ListCrmContactsSchema.parse({ campaign: "black" }), c);
    expect(c.mailflow.listCrmContacts).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ unknownCampaign: "black", availableCampaigns: ["Black Friday", "Black Friday Follow-up"] }),
    });
  });

  it("summary for a named campaign", async () => {
    const summary = { pipeline: { id: 1, name: "Sales" }, kpis: null, stages: [], labels: {}, funnel: [] };
    const c = ctx({ getAllCampaigns: vi.fn().mockResolvedValue(campaigns), getCrmSummary: vi.fn().mockResolvedValue(summary) });
    const result = await getCrmSummaryTool.handler({ campaign: "summer" }, c);
    expect(c.mailflow.getCrmSummary).toHaveBeenCalledWith({ pipelineId: undefined, campaignId: 5 });
    expect(result).toEqual({ success: true, data: { ...summary, campaignName: "Summer Sale" } });
  });
});

describe("get_crm_contact", () => {
  const detail = { contact: { id: 7, email: "ali@shop.com", name: "Ali", stageName: "Interested" } };

  it("needs a contactId or a query", () => {
    expect(GetCrmContactSchema.safeParse({}).success).toBe(false);
    expect(GetCrmContactSchema.safeParse({ query: "ali" }).success).toBe(true);
  });

  it("opens the lead when exactly one matches", async () => {
    const c = ctx({
      lookupCrmContacts: vi.fn().mockResolvedValue([{ id: 7, email: "ali@shop.com", name: "Ali", stageName: "Interested" }]),
      getCrmContact: vi.fn().mockResolvedValue(detail),
    });
    const result = await getCrmContactTool.handler({ query: "ali" }, c);
    expect(c.mailflow.getCrmContact).toHaveBeenCalledWith(7);
    expect(result).toEqual({ success: true, data: expect.objectContaining({ detail }) });
  });

  it("returns the matches without detail when several leads match", async () => {
    const matches = [
      { id: 7, email: "ali@shop.com", name: "Ali", stageName: null },
      { id: 8, email: "ali@xyz.com", name: "Ali R", stageName: null },
    ];
    const c = ctx({ lookupCrmContacts: vi.fn().mockResolvedValue(matches), getCrmContact: vi.fn() });
    const result = await getCrmContactTool.handler({ query: "ali" }, c);
    expect(c.mailflow.getCrmContact).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { detail: null, matches, query: "ali" } });
  });

  it("prefers an exact email match among several", async () => {
    const matches = [
      { id: 7, email: "ali@shop.com", name: "Ali", stageName: null },
      { id: 8, email: "ali@shop.com.pk", name: "Ali R", stageName: null },
    ];
    const c = ctx({ lookupCrmContacts: vi.fn().mockResolvedValue(matches), getCrmContact: vi.fn().mockResolvedValue(detail) });
    await getCrmContactTool.handler({ query: "ALI@shop.com" }, c);
    expect(c.mailflow.getCrmContact).toHaveBeenCalledWith(7);
  });
});

describe("other CRM tools", () => {
  it("list_crm_needs_reply keeps the counts but limits the list", async () => {
    const leads = Array.from({ length: 5 }, (_, i) => ({ contactId: i }));
    const c = ctx({ listCrmNeedsReply: vi.fn().mockResolvedValue({ leads, counts: { waiting: 5, overdue: 2, snoozed: 0 } }) });
    const result = await listCrmNeedsReplyTool.handler({ includeSnoozed: false, limit: 2 }, c);
    expect(result).toEqual({ success: true, data: { leads: leads.slice(0, 2), counts: { waiting: 5, overdue: 2, snoozed: 0 } } });
  });

  it("list_crm_pipelines adds the stages to each pipeline", async () => {
    const c = ctx();
    const result = await listCrmPipelinesTool.handler({}, c);
    expect(result).toEqual({ success: true, data: { pipelines: [{ ...pipelines[0], stages }] } });
  });

  it("returns the plan error as a tool failure, with the backend details", async () => {
    const body = { error: "Your current plan (Basic) does not include this feature.", code: "PLAN_FEATURE_REQUIRED" };
    const c = ctx({ getCrmSummary: vi.fn().mockRejectedValue(new MailFlowApiError(403, "MailFlow API error on /crm/summary", body)) });
    const result = await getCrmSummaryTool.handler({}, c);
    expect(result).toEqual({ success: false, error: expect.objectContaining({ details: body }) });
  });
});
