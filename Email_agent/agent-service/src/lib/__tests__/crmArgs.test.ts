import { describe, expect, it } from "vitest";
import { buildCrmToolArgs, parseCrmMessage, toLabel } from "../crmArgs.js";
import { resolveToolArgs } from "../toolArgResolver.js";

describe("toLabel", () => {
  it("accepts names, ids and common short forms", () => {
    expect(toLabel("Meeting Booked")).toBe("meeting_booked");
    expect(toLabel("not-interested")).toBe("not_interested");
    expect(toLabel("OOO")).toBe("out_of_office");
    expect(toLabel("unsubscribe")).toBe("bounce_unsubscribe");
    expect(toLabel("maybe")).toBeUndefined();
  });
});

describe("parseCrmMessage", () => {
  it("reads labels, never counting 'not interested' as interested", () => {
    expect(parseCrmMessage("show not interested leads").labels).toEqual(["not_interested"]);
    expect(parseCrmMessage("interested wale leads dikhao").labels).toEqual(["interested"]);
  });

  it("reads score tiers, needs reply and a count", () => {
    const p = parseCrmMessage("top 5 hot leads that need reply");
    expect(p.scoreTiers).toEqual(["hot"]);
    expect(p.needsReply).toBe(true);
    expect(p.limit).toBe(5);
  });

  it("reads a stage without turning its words into label filters", () => {
    const p = parseCrmMessage("show leads in the Interested stage");
    expect(p.stage).toBe("interested");
    expect(p.labels).toEqual([]);

    const urdu = parseCrmMessage("Meeting Booked stage mein kaun hai");
    expect(urdu.stage).toBe("meeting booked");
    expect(urdu.labels).toEqual([]);

    expect(parseCrmMessage("leads dikhao jo interested stage mein hain").stage).toBe("interested");
    expect(parseCrmMessage("stage: Won").stage).toBe("won");
    expect(parseCrmMessage("show leads by stage").stage).toBeUndefined();
  });

  it("reads tags", () => {
    expect(parseCrmMessage("leads tagged VIP").tags).toEqual(["VIP"]);
    expect(parseCrmMessage("leads with tag Real Estate").tags).toEqual(["Real Estate"]);
    expect(parseCrmMessage("VIP tag wale leads").tags).toEqual(["VIP"]);
  });

  it("reads the person for lead details (English and Roman Urdu)", () => {
    expect(parseCrmMessage("details of Ali Khan?").person).toBe("Ali Khan");
    expect(parseCrmMessage("Ali Khan ki detail").person).toBe("Ali Khan");
    expect(parseCrmMessage("tell me about sara").person).toBe("sara");
    expect(parseCrmMessage("ALI@Shop.com ka score kyun 70 hai").email).toBe("ali@shop.com");
  });

  it("leaves out things the message does not say", () => {
    const p = parseCrmMessage("show my crm leads");
    expect(p).toEqual({ labels: [], scoreTiers: [], tags: [] });
  });
});

describe("buildCrmToolArgs", () => {
  it("prefers LLM filters and cleans them", () => {
    const args = buildCrmToolArgs("list_crm_contacts", {
      extractedArgs: {
        campaignId: "Black Friday",
        limit: 500,
        filters: { stage: "Interested", labels: ["Interested", "bogus"], scoreTiers: "HOT,warm", tags: ["VIP"], needsReply: "true", userId: "9" },
      },
      userMessage: "cold leads",
    });
    expect(args).toEqual({
      stage: "Interested",
      labels: ["interested"],
      scoreTiers: ["hot", "warm"],
      tags: ["VIP"],
      campaign: "Black Friday",
      needsReply: true,
      limit: 50,
    });
  });

  it("falls back to the message when the LLM gave nothing", () => {
    const args = buildCrmToolArgs("list_crm_contacts", { extractedArgs: undefined, userMessage: "top 3 warm leads tagged VIP" });
    expect(args).toEqual({ scoreTiers: ["warm"], tags: ["VIP"], limit: 3 });
  });

  it("lead details: email beats a name, and no person means no query", () => {
    expect(buildCrmToolArgs("get_crm_contact", { extractedArgs: { query: "Ali" }, userMessage: "Ali (ali@shop.com) ki detail" }))
      .toEqual({ query: "ali@shop.com" });
    expect(buildCrmToolArgs("get_crm_contact", { extractedArgs: { filters: { contactId: "7" } } })).toEqual({ contactId: 7 });
    expect(buildCrmToolArgs("get_crm_contact", { extractedArgs: undefined, userMessage: "show lead details" })).toEqual({});
  });

  it("summary passes the campaign name through for the MCP tool to resolve", () => {
    expect(buildCrmToolArgs("get_crm_summary", { extractedArgs: { campaignId: "Summer Sale" } })).toEqual({ campaign: "Summer Sale" });
  });

  it("is wired into resolveToolArgs for the planner path", () => {
    expect(resolveToolArgs("list_crm_contacts", { extractedArgs: { filters: { labels: ["question"] } }, activeCampaignId: "5" }))
      .toEqual({ labels: ["question"] });
    expect(resolveToolArgs("list_crm_tags", { extractedArgs: undefined, activeCampaignId: undefined })).toEqual({});
  });
});
