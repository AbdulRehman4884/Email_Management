import { describe, expect, it } from "vitest";
import {
  liveCrmContext,
  nextCrmContext,
  normalizePronouns,
  ONE,
  pronounOf,
  readSelection,
  splitCompound,
  THEM,
  type CrmContext,
} from "../crmContext.js";
import { readCrmAction } from "../crmActions.js";

const matches = [
  { id: 7, email: "ali@shop.com", name: "Ali Khan" },
  { id: 8, email: "ali.raza@x.com", name: "Ali Raza" },
  { id: 9, email: "sara@x.com", name: null },
];
const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });

describe("readSelection", () => {
  it("numbers, ordinals (English + Roman Urdu), emails and names", () => {
    expect(readSelection("2", matches)).toEqual({ kind: "pick", lead: matches[1] });
    expect(readSelection(" #3 ", matches)).toEqual({ kind: "pick", lead: matches[2] });
    expect(readSelection("the second one", matches)).toEqual({ kind: "pick", lead: matches[1] });
    expect(readSelection("doosra wala", matches)).toEqual({ kind: "pick", lead: matches[1] });
    expect(readSelection("ALI@shop.com", matches)).toEqual({ kind: "pick", lead: matches[0] });
    expect(readSelection("Ali Raza", matches)).toEqual({ kind: "pick", lead: matches[1] });
    expect(readSelection("sara", matches)).toEqual({ kind: "pick", lead: matches[2] });
  });

  it("cancel words", () => {
    expect(readSelection("cancel", matches)).toEqual({ kind: "cancel" });
    expect(readSelection("rehne do", matches)).toEqual({ kind: "cancel" });
  });

  it("anything else is not a selection", () => {
    expect(readSelection("7", matches)).toBeUndefined();
    expect(readSelection("show my campaigns", matches)).toBeUndefined();
    expect(readSelection("ali", matches)).toBeUndefined();
    expect(readSelection("other@x.com", matches)).toBeUndefined();
  });
});

describe("pronouns and compound requests", () => {
  it("maps them / him in English and Roman Urdu", () => {
    expect(pronounOf("them")).toBe(THEM);
    expect(pronounOf("in sab")).toBe(THEM);
    expect(pronounOf("isko")).toBe(ONE);
    expect(pronounOf("Ali")).toBe("Ali");
    expect(normalizePronouns("inko VIP tag laga do")).toBe(`${THEM} ko VIP tag laga do`);
    expect(normalizePronouns("un sab ko Won kar do")).toBe(`${THEM} ko Won kar do`);
  });

  it("splits 'show X and do Y to them'", () => {
    expect(splitCompound("show hot leads and tag them with VIP")).toEqual({ listPart: "show hot leads", actionPart: "tag them with VIP" });
    expect(splitCompound("interested leads dikhao aur unko Engaged mein daal do")).toEqual({
      listPart: "interested leads dikhao", actionPart: "unko Engaged mein daal do",
    });
    expect(splitCompound("move Ali to Won")).toBeUndefined();
    expect(splitCompound("tag Ali and Sara with VIP")).toBeUndefined();
  });
});

describe("readCrmAction with context", () => {
  const ctx: CrmContext = {
    lastList: { targets: { labels: ["interested"] }, total: 4, atIso: new Date().toISOString() },
    lastLead: { id: 7, email: "ali@shop.com", name: "Ali Khan", atIso: new Date().toISOString() },
  };

  it("'them' / 'inko' act on the last list", () => {
    expect(readCrmAction("crm_tag_lead", undefined, "tag them with VIP", ctx)).toEqual({ tags: ["VIP"], targets: { labels: ["interested"] } });
    expect(readCrmAction("crm_move_lead", undefined, "inko Engaged mein daal do", ctx)).toEqual({ toStage: "Engaged", targets: { labels: ["interested"] } });
    expect(readCrmAction("crm_bulk_update", undefined, "un sab ko Won kar do", ctx)).toEqual({ toStage: "Won", targets: { labels: ["interested"] } });
  });

  it("'them' without a list leaves the leads open (the agent asks)", () => {
    expect(readCrmAction("crm_tag_lead", undefined, "tag them with VIP", undefined)).toEqual({ tags: ["VIP"], targets: {} });
  });

  it("a compound request uses its own first half, not the old list", () => {
    expect(readCrmAction("crm_tag_lead", undefined, "show hot leads and tag them with VIP", ctx)).toEqual({ tags: ["VIP"], targets: { scoreTiers: ["hot"] } });
    expect(readCrmAction("crm_tag_lead", undefined, "hot leads dikhao aur unko VIP tag laga do", ctx)).toEqual({ tags: ["VIP"], targets: { scoreTiers: ["hot"] } });
  });

  it("'him' / 'isko' use the last lead", () => {
    expect(readCrmAction("crm_move_lead", undefined, "move him to Won", ctx)).toEqual({ toStage: "Won", leadId: 7, lead: "Ali Khan" });
    expect(readCrmAction("crm_move_lead", undefined, "isko Won kar do", ctx)).toEqual({ toStage: "Won", leadId: 7, lead: "Ali Khan" });
  });
});

describe("nextCrmContext", () => {
  const now = new Date("2026-10-21T10:00:00Z");

  it("remembers the filters of a lead list and the lead of a detail view", () => {
    const afterList = nextCrmContext(undefined, {
      toolName: "list_crm_contacts", toolArgs: { scoreTiers: ["hot"], limit: 10 }, toolResult: ok({ contacts: [{ id: 1 }], total: 3 }),
    }, now);
    expect(afterList).toEqual({ lastList: { targets: { scoreTiers: ["hot"] }, total: 3, atIso: now.toISOString() } });

    const afterDetail = nextCrmContext(afterList, {
      toolName: "get_crm_contact", toolArgs: { query: "ali" }, toolResult: ok({ detail: { contact: { id: 7, email: "ali@shop.com", name: "Ali" } }, matches: [] }),
    }, now);
    expect(afterDetail?.lastLead).toEqual({ id: 7, email: "ali@shop.com", name: "Ali", stageName: null, atIso: now.toISOString() });
    expect(afterDetail?.lastList).toBeDefined();
  });

  it("a details search with several matches asks for a choice", () => {
    const ctx = nextCrmContext(undefined, {
      toolName: "get_crm_contact", toolArgs: { query: "ali" }, toolResult: ok({ detail: null, matches }),
    }, now);
    expect(ctx?.pendingSelection).toMatchObject({ intent: "crm_lead_details", matches: matches.map((m) => ({ ...m, stageName: null })) });
  });

  it("keeps a choice only on the turn that asked it", () => {
    const asked: CrmContext = { pendingSelection: { intent: "crm_tag_lead", request: { tags: ["VIP"] }, matches, atIso: now.toISOString(), isNew: true } };
    const saved = nextCrmContext(asked, {}, now);
    expect(saved?.pendingSelection).toEqual({ intent: "crm_tag_lead", request: { tags: ["VIP"] }, matches, atIso: now.toISOString() });
    expect(nextCrmContext(saved, {}, now)).toBeUndefined();
  });

  it("a list without filters is not remembered (no bulk on 'all leads')", () => {
    expect(nextCrmContext(undefined, { toolName: "list_crm_contacts", toolArgs: { limit: 10 }, toolResult: ok({ contacts: [{ id: 1 }], total: 1 }) }, now)).toBeUndefined();
  });

  it("drops old context", () => {
    const old = new Date(now.getTime() - 31 * 60_000).toISOString();
    expect(liveCrmContext({ lastLead: { id: 1, email: "a@b.co", name: null, atIso: old } }, now.getTime())).toBeUndefined();
  });
});
