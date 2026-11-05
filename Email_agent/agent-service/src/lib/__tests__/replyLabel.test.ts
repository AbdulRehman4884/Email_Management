import { describe, expect, it } from "vitest";
import { detectCrmActionIntent, effectiveCrmIntent, isLabelFilterAction, isReplyLabelRequest, isTagFollowUp, parseCrmActionMessage, planCrmAction } from "../crmActions.js";
import { nextCrmContext, readCampaignChoice, readLeadAnswer } from "../crmContext.js";
import { detectLeadGenIntent, isLeadFinderCrmQuestion } from "../leadgenArgs.js";
import { formatLeadGenResult } from "../leadgenFormatters.js";
import { parseAgentResponse } from "../agentResponseFormatter.js";

const lead = { id: 4, email: "qa@mailinator.com", name: "Qa", stageName: "Replied" };
const two = {
  lead,
  replyCampaigns: [
    { campaignId: 31, campaignName: "QA-TEST CRM E2E", replyId: 501, label: null, subject: "Re: hi", receivedAt: "2026-10-26T10:00:00Z" },
    { campaignId: 12, campaignName: "HELLO RAYAN", replyId: 302, label: "not_interested", subject: "Re: hello", receivedAt: "2026-10-16T10:00:00Z" },
  ],
};

describe("reply label: inbox / CRM, by email", () => {
  it("Roman Urdu and English shapes are a label change, tags and bulk are not", () => {
    for (const m of ["qa@mailinator.com pa Interested label laga do", "is email ka label Question kar do", "set label interested on Ali", "Ali ki reply pa meeting booked label lga do"]) {
      expect(isReplyLabelRequest(m)).toBe(true);
      expect(detectCrmActionIntent(m)).toBe("crm_change_label");
    }
    expect(isReplyLabelRequest("Ali ko VIP tag laga do")).toBe(false);
    expect(isReplyLabelRequest("saare leads pa interested label laga do")).toBe(false);
  });

  it("the screenshot messages: quoted name / reply subject, misspelled label, 'da do'", () => {
    const a = '"Bassamilyas90" ko intrested ka lable da do';
    const b = '"We are providing AI servises " ko intrested ka label da do';
    for (const m of [a, b]) expect(isReplyLabelRequest(m)).toBe(true);
    expect(parseCrmActionMessage("crm_change_label", a)).toMatchObject({ lead: "Bassamilyas90", label: "interested" });
    expect(parseCrmActionMessage("crm_change_label", b)).toMatchObject({ lead: "We are providing AI servises", label: "interested" });
    expect(parseCrmActionMessage("crm_change_label", b).labelText).toBeUndefined();
    expect(parseCrmActionMessage("crm_change_label", "ali@x.com ko not intrested label de do")).toMatchObject({ lead: "ali@x.com", label: "not_interested" });
  });

  it("found through the inbox subject: the reply of that campaign", () => {
    const plan = planCrmAction("crm_change_label", { lead: "We are providing AI services", label: "interested" }, { ...two, replySearch: { query: "x", campaignIds: [12] } });
    expect(plan).toMatchObject({ kind: "tool", toolArgs: { replyId: 302, label: "interested" } });
  });

  it("reads the email, the label and a campaign id", () => {
    expect(parseCrmActionMessage("crm_change_label", "qa@mailinator.com pa Not Interested label laga do campaign 31 mein"))
      .toMatchObject({ lead: "qa@mailinator.com", label: "not_interested", campaignId: 31 });
    expect(parseCrmActionMessage("crm_change_label", "Ali Khan pa interested label laga do")).toMatchObject({ lead: "Ali Khan", label: "interested" });
  });

  it("several campaigns: asks which one; the answer labels the reply in that campaign", () => {
    const ask = planCrmAction("crm_change_label", { lead: "qa@mailinator.com", label: "interested" }, two);
    expect(ask.kind).toBe("chooseCampaign");
    if (ask.kind !== "chooseCampaign") return;
    expect(ask.message).toMatch(/2 campaigns[\s\S]*1\. \*\*QA-TEST CRM E2E\*\*[\s\S]*2\. \*\*HELLO RAYAN\*\*/);
    expect(readCampaignChoice("2", ask.choices)).toEqual({ kind: "campaign", campaign: { campaignId: 12, campaignName: "HELLO RAYAN" } });
    expect(readCampaignChoice("QA-TEST wali", ask.choices)).toMatchObject({ campaign: { campaignId: 31 } });
    expect(readCampaignChoice("cancel", ask.choices)).toEqual({ kind: "cancel" });

    const done = planCrmAction("crm_change_label", { leadId: 4, label: "interested", campaignId: 12 }, two);
    expect(done).toMatchObject({ kind: "tool", toolName: "set_crm_reply_label", toolArgs: { replyId: 302, label: "interested" } });
  });

  it("a campaign named in the message is used; one campaign needs no question", () => {
    const named = planCrmAction("crm_change_label", { lead: "qa", label: "question", source: "qa pa question label laga do jo qa-test crm e2e campaign ma ha" }, two);
    expect(named).toMatchObject({ kind: "tool", toolArgs: { replyId: 501 } });
    const one = planCrmAction("crm_change_label", { lead: "qa", label: "question" }, { lead, replyCampaigns: [two.replyCampaigns[0]] });
    expect(one).toMatchObject({ kind: "tool", toolArgs: { replyId: 501, label: "question" } });
    const wrong = planCrmAction("crm_change_label", { lead: "qa", label: "question", campaignId: 99 }, two);
    expect(wrong.kind).toBe("chooseCampaign");
  });

  it("an own label (VIP) becomes the lead's tag", () => {
    const r = parseCrmActionMessage("crm_change_label", "qa@mailinator.com pa VIP label laga do");
    expect(r.label).toBeUndefined();
    expect(effectiveCrmIntent("crm_change_label", r)).toBe("crm_tag_lead");
    expect(r.tags).toEqual(["VIP"]);
  });
});

describe("tag follow-up right after create tag", () => {
  it('"Bassamilyas90 with engaged" tags the lead with the tag just created', () => {
    const ctx = nextCrmContext(undefined, {
      toolName: "create_crm_tag", toolArgs: { name: "engaged" },
      toolResult: { data: { success: true, data: { ok: true, tag: { id: 5, name: "engaged" } } }, isToolError: false, rawContent: [] },
    });
    expect(ctx?.lastTag?.name).toBe("engaged");
    expect(isTagFollowUp('"Bassamilyas90 with engaged"', ctx)).toBe(true);
    expect(isTagFollowUp("Ali ko Engaged", ctx)).toBe(true);
    expect(isTagFollowUp("Summer sale with discount", ctx)).toBe(false);
    expect(isTagFollowUp("Ali with engaged", undefined)).toBe(false);
    expect(parseCrmActionMessage("crm_tag_lead", '"Bassamilyas90 with engaged"')).toEqual({ lead: "Bassamilyas90", tags: ["engaged"] });
  });
});

describe("needs_input answers always carry the field arrays the chat card maps", () => {
  it("fills required_fields / optional_fields", () => {
    expect(parseAgentResponse(JSON.stringify({ status: "needs_input", intent: "crm_change_label", message: "Which campaign?" })))
      .toEqual({ status: "needs_input", intent: "crm_change_label", message: "Which campaign?", required_fields: [], optional_fields: [] });
    expect(parseAgentResponse(JSON.stringify({ status: "needs_input", intent: "x", message: "m", required_fields: ["name"] })))
      .toMatchObject({ required_fields: ["name"], optional_fields: [] });
  });
});

describe("lead finder leads in the CRM", () => {
  it("questions and summary requests; plain CRM lists stay CRM", () => {
    expect(detectLeadGenIntent("CRM ma konsi new leads add hui han")).toBe("lead_finder_crm_summary");
    expect(detectLeadGenIntent("lead finder summary")).toBe("lead_finder_crm_summary");
    expect(detectLeadGenIntent("lead generation sa CRM ma kitni leads aayi")).toBe("lead_finder_crm_summary");
    expect(isLeadFinderCrmQuestion("show CRM leads")).toBe(false);
    expect(detectLeadGenIntent("hot leads CRM mein daal do")).toBe("save_leads_to_crm");
  });

  it("groups per search in the answer", () => {
    const res = { data: { success: true, data: {
      total: 3, inCampaign: 1, truncated: false, searchName: null,
      bySearch: [
        { searchId: 7, searchName: "IT companies in Lahore", category: "IT companies", city: "Lahore", focus: ["AI automation"], total: 2, inCampaign: 1, hot: 1, warm: 1, cold: 0,
          sample: [{ company: "Acme", person: null, email: "a@acme.pk", status: "in_campaign" }, { company: "Beta", person: "Sara", email: null, status: "saved_to_crm" }] },
        { searchId: null, searchName: null, category: null, city: null, focus: [], total: 1, inCampaign: 0, hot: 0, warm: 0, cold: 1, sample: [] },
      ],
    } }, isToolError: false, rawContent: [] };
    const msg = JSON.parse(formatLeadGenResult("lead_finder_crm_summary", "get_lead_finder_crm_summary", res)).message as string;
    expect(msg).toMatch(/\*\*3 leads\*\* in your CRM came from the \*\*Lead Finder\*\* — 1 already in a campaign/);
    expect(msg).toMatch(/1\. \*\*IT companies in Lahore\*\*.*2 leads\*\*, 1 in a campaign · 🔥 1 hot · 🌤️ 1 warm/);
    expect(msg).toMatch(/Acme \(a@acme\.pk\) · in campaign/);
    expect(msg).toMatch(/2\. \*\*Deleted \/ unknown search\*\*/);
  });
});

describe("stage change for the leads with a reply label", () => {
  it("'intrested label wale emmail ki state ko engaged kr do' moves the Interested leads, it is not a label change", () => {
    const m = "intrested label wale emmail ki state ko engaged kr do";
    expect(isReplyLabelRequest(m)).toBe(false);
    expect(isLabelFilterAction(m)).toBe(true);
    expect(detectCrmActionIntent(m)).toBe("crm_bulk_update");
    expect(parseCrmActionMessage("crm_bulk_update", m)).toMatchObject({ toStage: "engaged", targets: { labels: ["interested"] } });
  });

  it("one lead: 'Bassamilyas90 ki stage Engaged kar do' is a move", () => {
    const m = "Bassamilyas90 ki stage Engaged kar do";
    expect(detectCrmActionIntent(m)).toBe("crm_move_lead");
    expect(parseCrmActionMessage("crm_move_lead", m)).toMatchObject({ lead: "Bassamilyas90", toStage: "Engaged" });
  });

  it("the answer to 'Which lead?' is the lead", () => {
    expect(readLeadAnswer("Bassamilyas90")).toEqual({ kind: "lead", text: "Bassamilyas90" });
    expect(readLeadAnswer("cancel")).toEqual({ kind: "cancel" });
    expect(readLeadAnswer("show me all campaigns that were sent last week please")).toBeUndefined();
  });
});
