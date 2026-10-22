import { describe, expect, it, vi } from "vitest";
import {
  bulkUpdateCrmLeadsTool,
  pickLead,
  prepareCrmActionTool,
  setCrmCampaignSettingsTool,
  tagCrmLeadTool,
} from "../../mcp/tools/crm/crmActions.tools.js";
import {
  BulkUpdateCrmLeadsSchema,
  PrepareCrmActionSchema,
  SetCrmCampaignSettingsSchema,
  SnoozeCrmLeadSchema,
} from "../../schemas/crm.schemas.js";
import { MailFlowApiError } from "../../lib/errors.js";
import { createMockMailflowClient, createMockToolContext } from "../helpers.js";

const stages = [
  { id: 11, pipelineId: 1, name: "Replied", color: "#000", position: 3, type: "normal", manualOnly: false, stopFollowUps: false, contactCount: 0 },
  { id: 17, pipelineId: 1, name: "Won", color: "#000", position: 6, type: "won", manualOnly: false, stopFollowUps: true, contactCount: 0 },
];
const detail = {
  contact: { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied", stageType: "normal", pipelineId: 1 },
  replies: [
    { id: 90, direction: "outbound", label: null, subject: "Re: hi", snippet: "our answer", receivedAt: "2026-10-03" },
    { id: 81, direction: "inbound", label: "neutral", subject: "Re: hi", snippet: "what is the price?", receivedAt: "2026-10-02" },
  ],
};

function ctx(overrides: Parameters<typeof createMockMailflowClient>[0] = {}) {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      lookupCrmContacts: vi.fn().mockResolvedValue([{ id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied" }]),
      getCrmContact: vi.fn().mockResolvedValue(detail),
      listCrmPipelines: vi.fn().mockResolvedValue([{ id: 1, name: "Sales Pipeline", isDefault: true }]),
      listCrmStages: vi.fn().mockResolvedValue(stages),
      listCrmTags: vi.fn().mockResolvedValue([{ id: 5, name: "VIP", color: "#000", scope: "both" }]),
      ...overrides,
    }),
  });
}

describe("pickLead", () => {
  const matches = [
    { id: 1, email: "ali@shop.com", name: "Ali", stageName: null },
    { id: 2, email: "ali.r@xyz.com", name: "Ali Raza", stageName: null },
  ];
  it("prefers an exact email, then an exact name, and never guesses between several", () => {
    expect(pickLead(matches, "ALI@shop.com")?.id).toBe(1);
    expect(pickLead(matches, "ali raza")?.id).toBe(2);
    expect(pickLead(matches, "al")).toBeUndefined();
    expect(pickLead([matches[0]!], "al")?.id).toBe(1);
  });
});

describe("prepare_crm_action", () => {
  it("resolves the lead, its latest inbound reply and a stage in the lead's pipeline", async () => {
    const c = ctx();
    const result = await prepareCrmActionTool.handler(PrepareCrmActionSchema.parse({ lead: "ali", toStage: "won", needLatestReply: true }), c);
    expect(c.mailflow.listCrmStages).toHaveBeenCalledWith(1);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        lead: { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied", stageType: "normal", pipelineId: 1 },
        stage: stages[1],
        latestReply: { id: 81, label: "neutral", subject: "Re: hi", snippet: "what is the price?", receivedAt: "2026-10-02" },
      }),
    });
  });

  it("returns the matches instead of a lead when the name is unclear", async () => {
    const matches = [
      { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: null },
      { id: 8, email: "ali@xyz.com", name: "Ali Raza", stageName: null },
    ];
    const c = ctx({ lookupCrmContacts: vi.fn().mockResolvedValue(matches) });
    const result = await prepareCrmActionTool.handler(PrepareCrmActionSchema.parse({ lead: "ali" }), c);
    expect(c.mailflow.getCrmContact).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { leadQuery: "ali", leadMatches: matches } });
  });

  it("reports unknown stages and tags with the real names", async () => {
    const result = await prepareCrmActionTool.handler(PrepareCrmActionSchema.parse({ toStage: "Negotiation", tags: ["VIP", "Gold"] }), ctx());
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({
        unknownStage: "Negotiation", availableStages: ["Replied", "Won"],
        unknownTags: ["Gold"], availableTags: ["VIP"],
      }),
    });
  });

  it("collects every target id across pages for bulk", async () => {
    const page = (n: number, start: number) => ({
      contacts: Array.from({ length: n }, (_, i) => ({ id: start + i, email: `l${start + i}@x.com`, name: null, stageName: "Replied" })),
      total: 150, limit: 100, offset: 0, page: 1,
    });
    const list = vi.fn().mockResolvedValueOnce(page(100, 1)).mockResolvedValueOnce(page(50, 101));
    const c = ctx({ listCrmContacts: list });
    const result = await prepareCrmActionTool.handler(PrepareCrmActionSchema.parse({ targets: { scoreTiers: ["hot"] }, toStage: "Won" }), c);
    expect(list).toHaveBeenNthCalledWith(1, { scoreTiers: ["hot"], limit: 100, page: 1 });
    expect(list).toHaveBeenNthCalledWith(2, { scoreTiers: ["hot"], limit: 100, page: 2 });
    const data = (result as { data: { targets: { total: number; ids: number[]; sample: unknown[]; truncated: boolean } } }).data;
    expect(data.targets.total).toBe(150);
    expect(data.targets.ids).toHaveLength(150);
    expect(data.targets.sample).toHaveLength(5);
    expect(data.targets.truncated).toBe(false);
  });

  it("does not search when a target filter name is unknown", async () => {
    const c = ctx({ listCrmContacts: vi.fn() });
    const result = await prepareCrmActionTool.handler(PrepareCrmActionSchema.parse({ targets: { stage: "Nowhere" } }), c);
    expect(c.mailflow.listCrmContacts).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, data: { unknownStage: "Nowhere", availableStages: ["Replied", "Won"] } });
  });

  it("rejects empty bulk filters", () => {
    expect(PrepareCrmActionSchema.safeParse({ targets: {} }).success).toBe(false);
  });
});

describe("write tools", () => {
  it("tag_crm_lead removes when asked and echoes the names", async () => {
    const c = ctx({ setCrmContactTag: vi.fn().mockResolvedValue({ ok: true }) });
    const result = await tagCrmLeadTool.handler({ contactId: 7, tagId: 5, remove: true, leadName: "Ali", tagName: "VIP" }, c);
    expect(c.mailflow.setCrmContactTag).toHaveBeenCalledWith(7, 5, true);
    expect(result).toEqual({ success: true, data: { ok: true, removed: true, lead: "Ali", tag: "VIP" } });
  });

  it("bulk needs something to do", () => {
    expect(BulkUpdateCrmLeadsSchema.safeParse({ contactIds: [1] }).success).toBe(false);
    expect(BulkUpdateCrmLeadsSchema.safeParse({ contactIds: [1], moveToStageId: 3 }).success).toBe(true);
  });

  it("bulk passes the backend counts through", async () => {
    const c = ctx({ bulkUpdateCrmContacts: vi.fn().mockResolvedValue({ ok: true, matched: 3, skipped: 0, moved: 3, tagsAdded: 0, tagsRemoved: 0 }) });
    const result = await bulkUpdateCrmLeadsTool.handler(BulkUpdateCrmLeadsSchema.parse({ contactIds: [1, 2, 3], moveToStageId: 17 }), c);
    expect(result).toEqual({ success: true, data: expect.objectContaining({ matched: 3, moved: 3 }) });
  });

  it("campaign settings keep the existing auto tags and pipeline", async () => {
    const save = vi.fn().mockResolvedValue({ settings: {}, tagged: 4 });
    const c = ctx({ getCrmCampaignSettings: vi.fn().mockResolvedValue({ pipelineId: 2, autoTagIds: [3] }), saveCrmCampaignSettings: save });
    await setCrmCampaignSettingsTool.handler(SetCrmCampaignSettingsSchema.parse({ campaignId: 9, addTagIds: [5, 3] }), c);
    expect(save).toHaveBeenCalledWith(9, { pipelineId: 2, autoTagIds: [3, 5] });
  });

  it("snooze needs a real date-time", () => {
    expect(SnoozeCrmLeadSchema.safeParse({ contactId: 1, until: "tomorrow" }).success).toBe(false);
    expect(SnoozeCrmLeadSchema.safeParse({ contactId: 1, until: "2026-10-21T09:00:00.000Z" }).success).toBe(true);
  });

  it("returns backend errors as tool failures", async () => {
    const body = { error: '"Q4" is a campaign-only tag' };
    const c = ctx({ setCrmContactTag: vi.fn().mockRejectedValue(new MailFlowApiError(400, "bad", body)) });
    const result = await tagCrmLeadTool.handler({ contactId: 7, tagId: 6, remove: false }, c);
    expect(result).toEqual({ success: false, error: expect.objectContaining({ code: "MAILFLOW_API_ERROR", details: body }) });
  });
});
