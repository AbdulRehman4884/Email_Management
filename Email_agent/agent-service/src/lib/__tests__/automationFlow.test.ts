import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDispatch, mockCompleteJson } = vi.hoisted(() => ({ mockDispatch: vi.fn(), mockCompleteJson: vi.fn() }));

vi.mock("../redisClient.js", () => ({ getRedisClient: async () => undefined }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () => ({ completeJson: mockCompleteJson }),
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import {
  applyEmails,
  emailSlots,
  findAutomation,
  formatAutomationToolResult,
  handleAutomations,
  isAutomationRequest,
  outlineSteps,
  readPlan,
  recipientRow,
  statsFromRuns,
  stopBucket,
  templateEmailIssues,
  type AutomationRow,
} from "../automationFlow.js";
import { loadJob } from "../../services/campaignCreationJob.service.js";
import { AUTOMATION_EMAILS_PROMPT, COLUMN_READER_PROMPT, FOLLOWUP_WRITER_PROMPT, REPLY_UNDERSTANDING_PROMPT } from "../../prompts/campaignCreation.prompt.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

const ok = (data: unknown) => ({ data: { success: true, data } });

function state(over: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userId: "u1",
    sessionId: "s1",
    rawToken: "t",
    userMessage: "",
    intent: "automations",
    senderDefaults: { fromName: "Bassam Ilyas", fromEmail: "bassam@dev.io" },
    ...over,
  } as unknown as AgentGraphStateType;
}
const msgOf = (p: Partial<AgentGraphStateType>) => JSON.parse(String(p.formattedResponse)).message as string;

const GOOD = {
  welcome:
    "Hi {{first_name}},\n\nThanks for asking about a website for your clinic. I read your note and I'll send a short plan with two options by tomorrow, so you can see what fits your budget and timeline.\n\nIs there a date you need it live by?\n\nBest,\nBassam",
  f1: "Hi {{first_name}},\n\nI put together a rough page list for your clinic site. Want me to send it over so you can check it?\n\nBest,\nBassam",
  f2: "Hi {{first_name}},\n\nI'll close this for now so I don't crowd your inbox. If the website comes back on your list, just reply here.\n\nBest,\nBassam",
};

describe("automation helpers", () => {
  it("detects automation requests", () => {
    expect(isAutomationRequest("show my automations")).toBe(true);
    expect(isAutomationRequest("create automation for my form")).toBe(true);
    expect(isAutomationRequest("calls to make")).toBe(true);
    expect(isAutomationRequest("create campaign")).toBe(false);
  });

  it("reads an own plan", () => {
    expect(readPlan("3 follow-ups, 2 days apart")).toEqual({ followUps: 3, gapDays: 2, reminder: false });
    expect(readPlan("2 emails 4 din with reminder")).toEqual({ followUps: 2, gapDays: 4, reminder: true });
    expect(readPlan("9 follow-ups")).toBeUndefined();
  });

  it("finds the email steps (call results too) and puts the written emails back, keeping everything else", () => {
    const steps = [
      { id: "a", type: "email", subject: "Hi", body: "x" },
      { id: "w", type: "wait", amount: 1, unit: "days" },
      { id: "c", type: "call", message: "", retries: 1, retryAmount: 1, retryUnit: "days", outcomes: {
        interested: [{ id: "i", type: "email", subject: "Great", body: "y" }, { id: "s", type: "stage", stageId: 4 }],
        no_answer: [], not_interested: [],
      } },
    ];
    const slots = emailSlots(steps);
    expect(slots.map((s) => [s.role, s.needsSubject])).toEqual([["first email", true], ["after the call: Interested", true]]);
    const out = applyEmails(steps, [{ subject: "S1", body: "B1" }, { subject: "S2", body: "B2" }], false);
    expect(out[0]).toMatchObject({ subject: "S1", body: "B1" });
    expect((out[2] as { outcomes: { interested: unknown[] } }).outcomes.interested).toEqual([{ id: "i", type: "email", subject: "S2", body: "B2" }, { id: "s", type: "stage", stageId: 4 }]);
    // Per recipient: each email step becomes that recipient's own follow-up.
    const per = applyEmails([{ type: "wait", amount: 2, unit: "days" }, { type: "email", subject: "", body: "t" }], [], true);
    expect(per[1]).toEqual({ type: "email", subject: "", body: "{{ai_followup_1}}" });
    expect(outlineSteps(per)).toEqual(["Wait 2 days", "Follow-up 1 (written for each recipient)"]);
  });

  it("checks template emails", () => {
    expect(templateEmailIssues({ subject: "your clinic website", body: GOOD.welcome }, { first: true, needsSubject: true, sender: "Bassam", kind: "form" })).toEqual([]);
    const bad = templateEmailIssues({ subject: "", body: "Hello!\n\nJust following up, check https://x.com {{city}}\n\nBest,\nTeam" }, { first: false, needsSubject: false, sender: "Bassam", kind: "form" });
    expect(bad.join(" | ")).toMatch(/Hi \{\{first_name\}\}/);
    expect(bad.join(" | ")).toMatch(/\{\{city\}\}/);
    expect(bad.join(" | ")).toMatch(/just following up/);
    expect(bad.join(" | ")).toMatch(/Bassam/);
  });

  it("analysis: stop reasons, emails sent and open problems", () => {
    expect(stopBucket("The lead replied")).toBe("replied");
    expect(stopBucket("The lead unsubscribed")).toBe("unsubscribed");
    const s = statsFromRuns(
      [
        { status: "stopped", stopReason: "The lead replied", emailsSent: 2 },
        { status: "stopped", stopReason: "The email bounced", emailsSent: 1 },
        { status: "active", emailsSent: 1, lastError: "Daily limit of the email account reached (20/20 today). Trying again in 1 hour." },
        { status: "completed", emailsSent: 3 },
      ],
      4,
    );
    expect(s).toMatchObject({ leads: 4, emailsSent: 7, sampled: false });
    expect(s.stops.replied).toBe(1);
    expect(s.stops.bounced).toBe(1);
    expect(s.problems).toEqual([{ message: "Daily limit of the email account reached . Trying again in 1 hour.", leads: 1 }]);
  });

  it("a recipient's row is saved again unchanged, with follow-ups, and never above the backend's size", () => {
    const row = recipientRow("a@b.co", { name: "Ali", fields: { company: "Acme", ai_body: "<p>x</p>", notes: "n".repeat(6000) } }, ["F1", "F2"]);
    expect(row).toEqual({ email: "a@b.co", name: "Ali", company: "Acme", ai_body: "<p>x</p>", ai_followup_1: "F1", ai_followup_2: "F2" });
  });

  it("finds an automation by name or number", () => {
    const list = [{ name: "Welcome" }, { name: "Welcome + follow-ups" }] as AutomationRow[];
    expect(findAutomation("turn off welcome + follow-ups", list)?.name).toBe("Welcome + follow-ups");
    expect(findAutomation("automation 1 details", list)?.name).toBe("Welcome");
  });

  it("formats approved actions and backend errors", () => {
    expect(JSON.parse(formatAutomationToolResult("update_automation", { isActive: true }, ok({ automation: { name: "Welcome" } }))).message).toMatch(/\*\*Welcome\*\* is \*\*on\*\*/);
    const err = formatAutomationToolResult("update_automation", {}, { data: { success: false, error: { message: "x", details: { error: "Automations are not set up yet. Run the automation migration first" } } } });
    expect(JSON.parse(err)).toMatchObject({ status: "error" });
    expect(JSON.parse(err).message).toMatch(/run-automation-migration/);
  });
});

// ── Chat ────────────────────────────────────────────────────────────────────

const WELCOME_TEMPLATE_STEPS = [
  { id: "welcome", type: "email", subject: "Thanks for reaching out, {{first_name}}!", body: "Hi {{first_name}},\n\nThank you for contacting us.\n\nBest regards" },
  { id: "wait1", type: "wait", amount: 1, unit: "days" },
  { id: "follow_up", type: "email", subject: "", body: "Hi {{first_name}},\n\nJust following up.\n\nBest regards" },
  { id: "wait2", type: "wait", amount: 1, unit: "days" },
  { id: "reminder", type: "email", subject: "", body: "Hi {{first_name}},\n\nA quick reminder.\n\nBest regards" },
];

describe("automations in chat", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockCompleteJson.mockReset();
  });

  it("summary + analysis of every automation", async () => {
    mockDispatch.mockImplementation(async (tool: string) => {
      if (tool === "list_automations") {
        return ok({ automations: [
          { id: 1, name: "Welcome", kind: "form", isActive: true, steps: [], usedBy: [{ id: 3, name: "Contact" }], usedByCampaigns: [], counts: { running: 2, waitingCall: 1, completed: 4, stopped: 1 } },
          { id: 2, name: "Q4 follow-ups", kind: "campaign", isActive: false, steps: [], usedBy: [], usedByCampaigns: [{ id: 9, name: "Q4" }], counts: { running: 3, waitingCall: 0, completed: 0, stopped: 2 } },
        ] });
      }
      if (tool === "list_automation_runs") return ok({ runs: [{ status: "stopped", stopReason: "The lead replied", emailsSent: 1 }, { status: "completed", emailsSent: 3 }], total: 2 });
      if (tool === "list_automation_calls") return ok({ calls: [{ runId: 5, email: "ali@shop.com", name: "Ali", phone: "0300", automationName: "Welcome" }] });
      throw new Error(`unexpected ${tool}`);
    });
    const p = await handleAutomations(state({ userMessage: "show my automations" }));
    const m = msgOf(p);
    expect(m).toMatch(/\*\*Your automations \(2\)\*\* — 1 on, 1 off/);
    expect(m).toMatch(/Leads in progress: \*\*5\*\*/);
    expect(m).toMatch(/Emails sent by automations: \*\*8\*\* · leads who replied: \*\*2\*\*/);
    expect(m).toMatch(/\*\*Q4 follow-ups\*\* is off but \*\*3\*\* leads are waiting/);
    expect(m).toMatch(/1 call to make:\*\* Ali \(0300\)/);
    expect(p.automationFlow).toBeUndefined();
  });

  it("turn off / call result: one approval card each, nothing changes before Confirm", async () => {
    mockDispatch.mockImplementation(async (tool: string) => {
      if (tool === "list_automations") return ok({ automations: [{ id: 1, name: "Welcome", kind: "form", isActive: true, steps: [], usedBy: [], usedByCampaigns: [], counts: {} }] });
      if (tool === "list_automation_calls") return ok({ calls: [{ runId: 5, email: "ali@shop.com", name: "Ali", automationName: "Welcome" }] });
      throw new Error(`unexpected ${tool}`);
    });
    let p = await handleAutomations(state({ userMessage: "turn off welcome automation" }));
    expect(p).toMatchObject({ toolName: "update_automation", toolArgs: { automationId: 1, isActive: false }, crmAction: { requiresApproval: true } });
    p = await handleAutomations(state({ userMessage: "automation call: ali@shop.com not interested" }));
    expect(p).toMatchObject({ toolName: "set_automation_call_result", toolArgs: { runId: 5, result: "not_interested" } });
    expect(mockDispatch.mock.calls.every((c) => String(c[0]).startsWith("list_"))).toBe(true);
  });

  it("form automation: kind → form → template → offer → emails written and checked → saved off → approval to turn on", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "list_crm_forms") return ok({ forms: [{ id: 3, name: "Contact us", automationId: null }] });
      if (tool === "list_automation_templates") {
        return ok({ templates: [{ key: "welcome_follow_ups", kind: "form", name: "Welcome + follow-ups", description: "Thanks now, two follow-ups" }, { key: "campaign_two", kind: "campaign", name: "2 follow-ups", description: "" }] });
      }
      if (tool === "get_smtp_settings") return ok({ accounts: [{ id: 7, fromEmail: "bassam@dev.io" }] });
      if (tool === "create_automation") {
        expect(args).toMatchObject({ kind: "form", templateKey: "welcome_follow_ups", smtpSettingsId: 7 });
        return ok({ automation: { id: 40, name: args.name, kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      }
      if (tool === "get_automation") return ok({ automation: { id: 40, name: "Welcome + follow-ups – Contact us", kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      if (tool === "update_automation") return ok({ automation: { id: 40 } });
      if (tool === "set_form_automation") return ok({ form: { id: 3 } });
      throw new Error(`unexpected ${tool}`);
    });
    let tries = 0;
    mockCompleteJson.mockImplementation(async (system: string) => {
      if (system !== AUTOMATION_EMAILS_PROMPT) return {};
      tries++;
      // First answer breaks the rules (checked and sent back as feedback), the second passes.
      if (tries === 1) return { emails: [{ subject: "Hi!", body: "Hello!" }, { subject: "", body: "x" }, { subject: "", body: "y" }] };
      return { emails: [{ subject: "your clinic website", body: GOOD.welcome }, { subject: "", body: GOOD.f1 }, { subject: "", body: GOOD.f2 }] };
    });

    let p = await handleAutomations(state({ userMessage: "create automation" }));
    expect(p.automationFlow?.step).toBe("kind");
    const say = async (text: string) => (p = await handleAutomations(state({ userMessage: text, automationFlow: p.automationFlow })));
    await say("1");
    expect(p.automationFlow?.step).toBe("target");
    expect(msgOf(p)).toMatch(/1\. \*\*Contact us\*\*/);
    await say("1");
    expect(p.automationFlow?.step).toBe("template");
    expect(msgOf(p)).toMatch(/1\. \*\*Welcome \+ follow-ups\*\*/);
    expect(msgOf(p)).not.toMatch(/2 follow-ups/);
    await say("1");
    // One email account: no question about it. The offer is asked.
    expect(p.automationFlow).toMatchObject({ step: "purpose", smtpSettingsId: 7 });
    await say("We build websites for clinics; people ask for a quote");
    expect(p.automationFlow?.step).toBe("review");
    const m = msgOf(p);
    expect(m).toContain("> Hi {{first_name}},");
    expect(m).toContain("Subject:** your clinic website");
    expect(m).toMatch(/approve\*\* — save it/);
    expect(tries).toBe(2);
    const second = JSON.parse(mockCompleteJson.mock.calls.filter((c) => c[0] === AUTOMATION_EMAILS_PROMPT)[1]![1] as string) as { feedback: string };
    expect(second.feedback).toMatch(/Hi \{\{first_name\}\}/);

    await say("approve");
    const update = mockDispatch.mock.calls.find((c) => c[0] === "update_automation")![1] as { steps: Array<Record<string, unknown>> };
    expect(update.steps[0]).toMatchObject({ type: "email", subject: "your clinic website", body: GOOD.welcome });
    expect(update.steps[2]).toMatchObject({ type: "email", subject: "", body: GOOD.f1 });
    expect(update.steps[1]).toEqual(WELCOME_TEMPLATE_STEPS[1]);
    expect(mockDispatch).toHaveBeenCalledWith("set_form_automation", { formId: 3, automationId: 40 }, expect.anything());
    // Still off: turning it on is the approval card.
    expect(p).toMatchObject({ toolName: "update_automation", toolArgs: { automationId: 40, isActive: true }, crmAction: { requiresApproval: true }, automationFlow: undefined });
    expect(p.crmAction?.confirmText).toMatch(/still off/);
  });

  it("own words at every step: \"naya form bnana ha\" is explained, \"call book krni ha\" picks Book a call", async () => {
    mockDispatch.mockImplementation(async (tool: string) => {
      if (tool === "list_crm_forms") return ok({ forms: [{ id: 3, name: "New form", automationId: null }, { id: 4, name: "New form", automationId: 9 }] });
      if (tool === "list_automation_templates") {
        return ok({ templates: [{ key: "welcome_follow_ups", kind: "form", name: "Welcome + follow-ups", description: "" }, { key: "book_call", kind: "form", name: "Book a call", description: "" }] });
      }
      if (tool === "get_smtp_settings") return ok({ accounts: [{ id: 7, fromEmail: "a@dev.io" }] });
      throw new Error(`unexpected ${tool}`);
    });
    mockCompleteJson.mockImplementation(async (system: string, user: string) => {
      if (system !== REPLY_UNDERSTANDING_PROMPT) return {};
      const input = JSON.parse(user) as { step: string; message: string; notPossible?: string[] };
      if (input.step === "kind") return { action: "reply", reply: "1" };
      if (input.step === "target") {
        expect(input.notPossible?.[0]).toMatch(/Forms page/);
        return input.message.includes("naya")
          ? { action: "say", message: "Forms are made on the Forms page, not in chat. Pick 3 (No form yet) and add it to the form later?" }
          : { action: "reply", reply: "3" };
      }
      if (input.step === "template") return { action: "reply", reply: "2" };
      return {};
    });

    let p = await handleAutomations(state({ userMessage: "create automation" }));
    const say = async (text: string) => (p = await handleAutomations(state({ userMessage: text, automationFlow: p.automationFlow })));
    await say("new lead forms ka lia ai automation krni a");
    expect(p.automationFlow?.step).toBe("target");
    await say("naya form bnana ha");
    expect(p.automationFlow?.step).toBe("target"); // no form was picked
    expect(msgOf(p)).toMatch(/Forms page/);
    await say("abhi koi form nahi, baad mein laga dunga");
    expect(p.automationFlow?.step).toBe("template");
    expect(p.automationFlow?.target).toBeUndefined();
    await say("call book krni ha");
    expect(p.automationFlow).toMatchObject({ step: "purpose", templateKey: "book_call", templateName: "Book a call" });
  });

  it("several email accounts: the box (or \"1, 3\") picks them, create_automation gets every account, the approval names them", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "list_crm_forms") return ok({ forms: [{ id: 3, name: "Contact us", automationId: null }] });
      if (tool === "list_automation_templates") return ok({ templates: [{ key: "welcome_follow_ups", kind: "form", name: "Welcome + follow-ups", description: "" }] });
      if (tool === "get_smtp_settings") return ok({ accounts: [{ id: 7, fromEmail: "a@dev.io" }, { id: 8, fromEmail: "b@dev.io" }, { id: 9, fromEmail: "c@dev.io" }] });
      if (tool === "create_automation") return ok({ automation: { id: 40, name: args.name, kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      if (tool === "get_automation") return ok({ automation: { id: 40, name: "Welcome + follow-ups – Contact us", kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      if (tool === "update_automation") return ok({ automation: { id: 40 } });
      if (tool === "set_form_automation") return ok({ form: { id: 3 } });
      throw new Error(`unexpected ${tool}`);
    });
    mockCompleteJson.mockImplementation(async (system: string) =>
      system === AUTOMATION_EMAILS_PROMPT ? { emails: [{ subject: "your clinic website", body: GOOD.welcome }, { subject: "", body: GOOD.f1 }, { subject: "", body: GOOD.f2 }] } : {},
    );
    const json = (p: Partial<AgentGraphStateType>) => JSON.parse(String(p.formattedResponse)) as { message: string; form?: unknown };

    let p = await handleAutomations(state({ userMessage: "create automation" }));
    const say = async (text: string, over: Partial<AgentGraphStateType> = {}) =>
      (p = await handleAutomations(state({ userMessage: text, automationFlow: p.automationFlow, ...over })));
    await say("1");
    await say("1");
    await say("1");
    expect(p.automationFlow?.step).toBe("smtp");
    expect(json(p).form).toEqual({ kind: "sender", aliases: false });

    // Typed numbers work too.
    await say("1, 3");
    expect(p.automationFlow).toMatchObject({ step: "purpose", smtpSettingsId: 7, smtpSettingIds: [7, 9], smtpLabel: "a@dev.io, c@dev.io" });
    await say("back");
    expect(p.automationFlow?.step).toBe("smtp");

    // An account that was not offered: the box comes back.
    await say("Send from: z@x.io", { senderChoice: { smtpSettingIds: [99], aliasIds: [] } });
    expect(p.automationFlow?.step).toBe("smtp");
    expect(json(p).form).toEqual({ kind: "sender", aliases: false });

    await say("Send from: b@dev.io, c@dev.io", { senderChoice: { smtpSettingIds: [8, 9], aliasIds: [] } });
    expect(p.automationFlow).toMatchObject({ step: "purpose", smtpSettingsId: 8, smtpSettingIds: [8, 9] });
    await say("We build websites for clinics; people ask for a quote");
    const created = mockDispatch.mock.calls.find((c) => c[0] === "create_automation")![1] as Record<string, unknown>;
    expect(created).toMatchObject({ kind: "form", templateKey: "welcome_follow_ups", smtpSettingIds: [8, 9] });
    expect(created.smtpSettingsId).toBeUndefined();
    await say("approve");
    expect(p.crmAction?.confirmText).toContain("b@dev.io, c@dev.io");
  });

  it("back: every create step has a Previous step button; keep returns to the emails without rewriting them", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "list_crm_forms") return ok({ forms: [{ id: 3, name: "Contact us", automationId: null }] });
      if (tool === "list_automation_templates") return ok({ templates: [{ key: "welcome_follow_ups", kind: "form", name: "Welcome + follow-ups", description: "" }] });
      if (tool === "get_smtp_settings") return ok({ accounts: [{ id: 7, fromEmail: "a@dev.io" }, { id: 8, fromEmail: "b@dev.io" }] });
      if (tool === "create_automation") return ok({ automation: { id: 40, name: args.name, kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      if (tool === "get_automation") return ok({ automation: { id: 40, name: "Welcome + follow-ups – Contact us", kind: "form", steps: WELCOME_TEMPLATE_STEPS } });
      if (tool === "update_automation") return ok({ automation: { id: 40 } });
      throw new Error(`unexpected ${tool}`);
    });
    let writes = 0;
    mockCompleteJson.mockImplementation(async (system: string) => {
      if (system !== AUTOMATION_EMAILS_PROMPT) return {};
      writes++;
      return { emails: [{ subject: "your clinic website", body: GOOD.welcome }, { subject: "", body: GOOD.f1 }, { subject: "", body: GOOD.f2 }] };
    });
    const back = (p: Partial<AgentGraphStateType>) => JSON.parse(String(p.formattedResponse)).back as boolean | undefined;

    let p = await handleAutomations(state({ userMessage: "create automation" }));
    const say = async (text: string) => (p = await handleAutomations(state({ userMessage: text, automationFlow: p.automationFlow })));
    expect(back(p)).toBeUndefined(); // the first step has nothing before it
    await say("1");
    expect(p.automationFlow?.step).toBe("target");
    expect(back(p)).toBe(true);
    await say("back");
    expect(p.automationFlow?.step).toBe("kind");
    expect(p.automationFlow?.kind).toBeUndefined();
    await say("1");
    await say("1");
    expect(p.automationFlow?.step).toBe("template");
    await say("peeche jao");
    expect(p.automationFlow?.step).toBe("target");
    await say("1");
    await say("1");
    expect(p.automationFlow?.step).toBe("smtp");
    expect(back(p)).toBe(true);
    await say("back");
    expect(p.automationFlow?.step).toBe("template");
    await say("1");
    await say("2");
    expect(p.automationFlow).toMatchObject({ step: "purpose", smtpSettingsId: 8 });
    await say("previous step");
    expect(p.automationFlow?.step).toBe("smtp");
    await say("1");
    expect(p.automationFlow).toMatchObject({ step: "purpose", smtpSettingsId: 7 });
    expect(mockDispatch.mock.calls.some((c) => c[0] === "create_automation")).toBe(false);

    await say("We build websites for clinics; people ask for a quote");
    expect(p.automationFlow?.step).toBe("review");
    expect(back(p)).toBe(true);
    expect(writes).toBe(1);
    await say("back");
    expect(p.automationFlow?.step).toBe("purpose");
    expect(msgOf(p)).toContain("Now: **We build websites for clinics; people ask for a quote**");
    expect(back(p)).toBeUndefined(); // the automation exists now: form / plan / account change on the Automations page
    await say("keep");
    expect(p.automationFlow?.step).toBe("review");
    expect(writes).toBe(1);
    expect(mockDispatch.mock.calls.filter((c) => c[0] === "create_automation")).toHaveLength(1);
  });

  it("draft campaign: every recipient gets their own follow-ups, saved on their row; the automation sends {{ai_followup_N}}", async () => {
    const steps = [
      { id: "w1", type: "wait", amount: 1, unit: "days" },
      { id: "f1", type: "email", subject: "", body: "Hi {{first_name}},\n\nDid you see my email?\n\nBest regards" },
      { id: "w2", type: "wait", amount: 2, unit: "days" },
      { id: "f2", type: "email", subject: "", body: "Hi {{first_name}},\n\nLast one from me.\n\nBest regards" },
    ];
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "get_all_campaigns") return ok([{ id: "9", name: "Q4 outreach", status: "draft" }, { id: "8", name: "Old", status: "completed" }]);
      if (tool === "get_campaign_automation") return ok({ campaignStatus: "draft", canChange: true });
      if (tool === "list_automation_templates") return ok({ templates: [{ key: "campaign_two_follow_ups", kind: "campaign", name: "2 follow-ups", description: "" }] });
      if (tool === "get_campaign_recipients") {
        return ok({
          campaign: { id: "9", name: "Q4 outreach", status: "draft", subject: "{{ai_subject}}", body: "{{ai_body}}" },
          recipients: [
            { id: 1, email: "ali@acme.pk", name: "Ali", status: "pending", customFields: { company: "Acme", ai_subject: "your dashboard", ai_body: "<p>Hi Ali,</p><p>You need a React dashboard rebuilt. I've done two of those for logistics teams.</p><p>Worth a chat?</p><p>Best,<br>Bassam</p>" } },
          ],
          total: 1,
        });
      }
      if (tool === "create_automation") return ok({ automation: { id: 50, name: args.name, kind: "campaign", steps } });
      if (tool === "get_automation") return ok({ automation: { id: 50, name: "2 follow-ups – Q4 outreach", kind: "campaign", steps } });
      if (["delete_campaign_recipients", "update_automation", "set_campaign_automation"].includes(tool)) return ok({});
      if (tool === "save_csv_recipients") return ok({ added: 1, rejected: 0 });
      throw new Error(`unexpected ${tool}`);
    });
    mockCompleteJson.mockImplementation(async (system: string, user: string) => {
      if (system === COLUMN_READER_PROMPT) return { hasHeader: true, columns: [{ index: 0, label: "Email", kind: "email" }, { index: 1, label: "Name", kind: "name" }, { index: 2, label: "Company", kind: "company" }] };
      if (system === AUTOMATION_EMAILS_PROMPT) return { emails: [{ subject: "", body: GOOD.f1 }, { subject: "", body: GOOD.f2 }] };
      if (system === FOLLOWUP_WRITER_PROMPT) {
        const input = JSON.parse(user) as { first_email: { body: string }; sequence: { count: number } };
        expect(input.first_email.body).toMatch(/React dashboard rebuilt/);
        expect(input.sequence.count).toBe(2);
        return { followups: [
          { body: "Hi Ali,\n\nOne idea for the dashboard: moving the reports first usually removes most of the risk. Want me to sketch it?\n\nBest,\nBassam" },
          { body: "Hi Ali,\n\nI'll leave this here so I don't crowd your inbox. If the rebuild comes back on the list, I'm happy to help.\n\nBest,\nBassam" },
        ] };
      }
      return {};
    });

    let p = await handleAutomations(state({ userMessage: "create automation for campaign follow-ups" }));
    expect(p.automationFlow?.step).toBe("target");
    expect(msgOf(p)).toMatch(/1\. \*\*Q4 outreach\*\* — draft/);
    expect(msgOf(p)).not.toMatch(/Old/);
    const say = async (text: string) => (p = await handleAutomations(state({ userMessage: text, automationFlow: p.automationFlow })));
    await say("1");
    await say("1");
    // The offer comes from the recipients' own emails; the follow-ups are written in the background.
    expect(p.automationFlow).toMatchObject({ step: "writing", perRecipient: true, automationId: 50 });
    for (let i = 0; i < 50 && (await loadJob("automation-flow:u1:s1"))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));

    await say("status");
    expect(p.automationFlow?.step).toBe("review");
    expect(msgOf(p)).toMatch(/Follow-ups written for \*\*1\/1\*\* recipients/);
    expect(msgOf(p)).toContain("Follow-up 1 (written for each recipient)");

    await say("approve");
    const rows = (mockDispatch.mock.calls.find((c) => c[0] === "save_csv_recipients")![1] as { rows: Array<Record<string, string>> }).rows;
    expect(rows[0]).toMatchObject({ email: "ali@acme.pk", name: "Ali", company: "Acme", ai_subject: "your dashboard" });
    expect(rows[0]!.ai_body).toMatch(/^<p>Hi Ali,/);
    expect(rows[0]!.ai_followup_1).toMatch(/^Hi Ali,\n\nOne idea/);
    const update = mockDispatch.mock.calls.find((c) => c[0] === "update_automation")![1] as { steps: Array<Record<string, unknown>> };
    expect(update.steps[1]).toMatchObject({ type: "email", subject: "", body: "{{ai_followup_1}}" });
    expect(update.steps[3]).toMatchObject({ body: "{{ai_followup_2}}" });
    expect(mockDispatch).toHaveBeenCalledWith("set_campaign_automation", { campaignId: 9, automationId: 50 }, expect.anything());
    // Order: recipients replaced before the automation is saved and set on the campaign.
    const order = mockDispatch.mock.calls.map((c) => c[0]);
    expect(order.indexOf("delete_campaign_recipients")).toBeLessThan(order.indexOf("save_csv_recipients"));
    expect(p).toMatchObject({ toolName: "update_automation", toolArgs: { automationId: 50, isActive: true } });
  });

  it("cancel deletes the draft automation", async () => {
    mockDispatch.mockResolvedValue(ok({}));
    const p = await handleAutomations(state({ userMessage: "cancel", automationFlow: { step: "review", mode: "create", automationId: 40, atIso: new Date().toISOString() } }));
    expect(mockDispatch).toHaveBeenCalledWith("delete_automation", { automationId: 40 }, expect.anything());
    expect(msgOf(p)).toMatch(/draft automation was deleted/);
    expect(p.automationFlow).toBeUndefined();
  });
});
