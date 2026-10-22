import { describe, expect, it } from "vitest";
import {
  effectiveCrmIntent,
  missingInfoQuestion,
  parseCrmActionMessage,
  planCrmAction,
  prepareArgsFor,
  readCrmAction,
  snoozeUntil,
} from "../crmActions.js";

describe("parseCrmActionMessage", () => {
  it("move: English, Roman Urdu and Won/Lost", () => {
    expect(parseCrmActionMessage("crm_move_lead", "move Ali Khan to Meeting Booked")).toEqual({ lead: "Ali Khan", toStage: "Meeting Booked" });
    expect(parseCrmActionMessage("crm_move_lead", "move ali@shop.com to the Interested stage")).toEqual({ lead: "ali@shop.com", toStage: "Interested" });
    expect(parseCrmActionMessage("crm_move_lead", "Ali ko Interested mein daal do")).toEqual({ lead: "Ali", toStage: "Interested" });
    expect(parseCrmActionMessage("crm_move_lead", "mark sara@x.com as won")).toEqual({ lead: "sara@x.com", toStage: "won" });
    expect(parseCrmActionMessage("crm_move_lead", "Sara ko lost kar do")).toEqual({ lead: "Sara", toStage: "lost" });
  });

  it("tag: add, remove, Roman Urdu", () => {
    expect(parseCrmActionMessage("crm_tag_lead", "tag Ali with VIP")).toEqual({ lead: "Ali", tags: ["VIP"] });
    expect(parseCrmActionMessage("crm_tag_lead", "add tag Real Estate to sara@x.com")).toEqual({ lead: "sara@x.com", tags: ["Real Estate"] });
    expect(parseCrmActionMessage("crm_tag_lead", "remove tag VIP from Ali")).toEqual({ remove: true, tags: ["VIP"], lead: "Ali" });
    expect(parseCrmActionMessage("crm_tag_lead", "Ali ko VIP tag laga do")).toEqual({ lead: "Ali", tags: ["VIP"] });
    expect(parseCrmActionMessage("crm_tag_lead", "Ali se VIP tag hata do")).toEqual({ remove: true, tags: ["VIP"], lead: "Ali" });
  });

  it("create tag with an optional color", () => {
    expect(parseCrmActionMessage("crm_create_tag", "create tag Real Estate in green")).toEqual({ tagName: "Real Estate", tagColor: "#22c55e" });
    expect(parseCrmActionMessage("crm_create_tag", "naya tag VIP banao")).toEqual({ tagName: "VIP" });
  });

  it("snooze, done and label", () => {
    const s = parseCrmActionMessage("crm_snooze_lead", "snooze Ali for 3 days");
    expect(s.lead).toBe("Ali");
    expect(s.untilText).toBe("3 days");
    expect(parseCrmActionMessage("crm_mark_done", "mark Ali as done")).toEqual({ lead: "Ali" });
    expect(parseCrmActionMessage("crm_mark_done", "I replied to sara@x.com")).toEqual({ lead: "sara@x.com" });
    expect(parseCrmActionMessage("crm_change_label", "change the label of Ali's reply to question")).toEqual({ lead: "Ali", label: "question" });
    expect(parseCrmActionMessage("crm_change_label", "Ali ki reply ka label interested kar do")).toEqual({ lead: "Ali", label: "interested" });
  });

  it("bulk: filters from the lead part, action from the rest", () => {
    expect(parseCrmActionMessage("crm_bulk_update", "move all hot leads to Engaged")).toEqual({ toStage: "Engaged", targets: { scoreTiers: ["hot"] } });
    expect(parseCrmActionMessage("crm_bulk_update", "tag all interested leads with VIP")).toEqual({ tags: ["VIP"], targets: { labels: ["interested"] } });
    expect(parseCrmActionMessage("crm_bulk_update", "saare hot leads ko VIP tag laga do")).toEqual({ tags: ["VIP"], targets: { scoreTiers: ["hot"] } });
    expect(parseCrmActionMessage("crm_bulk_update", "saare leads jo hot hain unko VIP tag laga do")).toEqual({ tags: ["VIP"], targets: { scoreTiers: ["hot"] } });
    expect(parseCrmActionMessage("crm_bulk_update", "saare interested leads ko Engaged mein le jao")).toEqual({ toStage: "Engaged", targets: { labels: ["interested"] } });
  });
});

describe("readCrmAction", () => {
  it("LLM args win, the message fills the rest", () => {
    const r = readCrmAction("crm_move_lead", { query: "ali@shop.com", filters: { toStage: "Won" } }, "move him to won");
    expect(r).toMatchObject({ lead: "ali@shop.com", toStage: "Won" });
  });

  it("a move of 'all …' leads becomes a bulk change", () => {
    const r = readCrmAction("crm_move_lead", undefined, "move all warm leads to Contacted");
    expect(r).toEqual({ toStage: "Contacted", targets: { scoreTiers: ["warm"] } });
    expect(effectiveCrmIntent("crm_move_lead", r)).toBe("crm_bulk_update");
  });

  it("bulk from LLM targets", () => {
    const r = readCrmAction("crm_bulk_update", { filters: { targets: { labels: ["Interested"], scoreTiers: ["hot", "x"] }, addTags: ["VIP"] } }, "");
    expect(r).toMatchObject({ tags: ["VIP"], targets: { labels: ["interested"], scoreTiers: ["hot"] } });
  });

  it("snooze defaults to tomorrow 09:00", () => {
    const r = readCrmAction("crm_snooze_lead", { query: "Ali" }, "snooze Ali");
    expect(r.untilText).toBe("tomorrow 09:00 (default)");
    expect(new Date(r.until!).getHours()).toBe(9);
  });
});

describe("snoozeUntil", () => {
  const now = new Date("2026-10-20T15:00:00");
  it("reads hours, days, weeks and caps at 90 days", () => {
    expect(snoozeUntil("2 hours", now).until.getTime() - now.getTime()).toBe(2 * 3_600_000);
    expect(snoozeUntil("3 din", now).until.getTime() - now.getTime()).toBe(3 * 86_400_000);
    expect(snoozeUntil("1 week", now).until.getTime() - now.getTime()).toBe(7 * 86_400_000);
    expect(snoozeUntil("500 days", now).until.getTime() - now.getTime()).toBe(90 * 86_400_000);
    expect(snoozeUntil("kal tak", now).until.getHours()).toBe(9);
  });
});

describe("missingInfoQuestion", () => {
  it("asks for what is missing", () => {
    expect(missingInfoQuestion("crm_move_lead", {})).toContain("Which lead?");
    expect(missingInfoQuestion("crm_move_lead", { lead: "Ali" })).toContain("To which stage");
    expect(missingInfoQuestion("crm_bulk_update", { toStage: "Won" })).toContain("Which leads?");
    expect(missingInfoQuestion("crm_bulk_update", { targets: { scoreTiers: ["hot"] } })).toContain("What should I do");
    expect(missingInfoQuestion("crm_move_lead", { lead: "Ali", toStage: "Won" })).toBeUndefined();
  });
});

describe("prepareArgsFor", () => {
  it("asks only for what the action needs", () => {
    expect(prepareArgsFor("crm_move_lead", { lead: "Ali", toStage: "Won" })).toEqual({ lead: "Ali", toStage: "Won" });
    expect(prepareArgsFor("crm_change_label", { lead: "Ali", label: "question" })).toEqual({ lead: "Ali", needLatestReply: true });
    expect(prepareArgsFor("crm_create_tag", { tagName: "VIP" })).toBeUndefined();
  });
});

describe("planCrmAction", () => {
  const lead = { id: 7, email: "ali@shop.com", name: "Ali Khan", stageName: "Replied", stageType: "normal", pipelineId: 1 };

  it("move to a normal stage runs at once", () => {
    const plan = planCrmAction("crm_move_lead", { lead: "Ali", toStage: "Engaged" }, { lead, stage: { id: 3, name: "Engaged", type: "normal", stopFollowUps: false } });
    expect(plan).toEqual({
      kind: "tool",
      toolName: "move_crm_lead",
      toolArgs: { contactId: 7, stageId: 3, leadName: "Ali Khan" },
      confirmText: "Move **Ali Khan** (ali@shop.com) from **Replied** to **Engaged**?",
      requiresApproval: false,
    });
  });

  it("move to Won needs approval and says so", () => {
    const plan = planCrmAction("crm_move_lead", { lead: "Ali", toStage: "won" }, { lead, stage: { id: 9, name: "Won", type: "won", stopFollowUps: true } });
    expect(plan).toMatchObject({ kind: "tool", requiresApproval: true });
    expect(plan.kind === "tool" && plan.confirmText).toContain("marks the deal as **Won**");
    expect(plan.kind === "tool" && plan.confirmText).toContain("follow-up emails to this lead will stop");
  });

  it("already in the stage → reply, no tool", () => {
    expect(planCrmAction("crm_move_lead", { lead: "Ali", toStage: "Replied" }, { lead, stage: { id: 2, name: "Replied" } }))
      .toEqual({ kind: "reply", message: "**Ali Khan** (ali@shop.com) is already in **Replied**." });
  });

  it("several matching leads → list, no tool", () => {
    const plan = planCrmAction("crm_tag_lead", { lead: "ali", tags: ["VIP"] }, {
      leadQuery: "ali",
      leadMatches: [{ id: 7, email: "ali@shop.com", name: "Ali Khan" }, { id: 8, email: "ali@x.com", name: null, stageName: "Won" }],
    });
    expect(plan.kind).toBe("reply");
    expect(plan.kind === "reply" && plan.message).toContain("2. **ali@x.com** · Won");
  });

  it("unknown tag → offer to create it", () => {
    const plan = planCrmAction("crm_tag_lead", { lead: "Ali", tags: ["Gold"] }, { lead, tags: [], unknownTags: ["Gold"], availableTags: ["VIP"] });
    expect(plan.kind === "reply" && plan.message).toContain("*create tag Gold*");
  });

  it("label change uses the latest reply and skips a no-op", () => {
    const p = { lead, latestReply: { id: 81, label: "neutral" } };
    expect(planCrmAction("crm_change_label", { lead: "Ali", label: "question" }, p)).toMatchObject({
      kind: "tool", toolName: "set_crm_reply_label", toolArgs: { replyId: 81, label: "question", leadName: "Ali Khan" }, requiresApproval: false,
    });
    expect(planCrmAction("crm_change_label", { lead: "Ali", label: "neutral" }, p).kind).toBe("reply");
    expect(planCrmAction("crm_change_label", { lead: "Ali", label: "question" }, { lead, latestReply: null }).kind).toBe("reply");
  });

  it("bulk always needs approval and shows the count", () => {
    const plan = planCrmAction("crm_bulk_update", { targets: { scoreTiers: ["hot"] }, tags: ["VIP"] }, {
      targets: { total: 3, ids: [1, 2, 3], sample: [{ name: "Ali" }, { email: "b@x.com" }], truncated: false, appliedFilters: {} },
      tags: [{ id: 5, name: "VIP" }],
    });
    expect(plan).toMatchObject({ kind: "tool", toolName: "bulk_update_crm_leads", toolArgs: { contactIds: [1, 2, 3], addTagIds: [5] }, requiresApproval: true });
    expect(plan.kind === "tool" && plan.confirmText).toContain("**3 leads** (hot): add tag **VIP**");
  });

  it("bulk with no matching leads changes nothing", () => {
    const plan = planCrmAction("crm_bulk_update", { targets: { scoreTiers: ["hot"] }, toStage: "Won" }, { targets: { total: 0, ids: [], sample: [] } });
    expect(plan.kind).toBe("reply");
  });

  it("campaign auto tags need approval, a pipeline alone does not", () => {
    const campaign = { id: 4, name: "Summer", settings: { pipelineId: null, autoTagIds: [] } };
    expect(planCrmAction("crm_campaign_settings", { campaign: "Summer", tags: ["VIP"] }, { campaign, tags: [{ id: 5, name: "VIP" }] }))
      .toMatchObject({ toolArgs: { campaignId: 4, addTagIds: [5], campaignName: "Summer" }, requiresApproval: true });
    expect(planCrmAction("crm_campaign_settings", { campaign: "Summer", pipeline: "Recruiting" }, { campaign, pipeline: { id: 2, name: "Recruiting" } }))
      .toMatchObject({ toolArgs: { campaignId: 4, pipelineId: 2 }, requiresApproval: false });
  });
});
