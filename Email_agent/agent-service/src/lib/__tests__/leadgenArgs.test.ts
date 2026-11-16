import { describe, expect, it } from "vitest";
import {
  applyAnswer,
  buildLeadGenToolArgs,
  detectLeadGenIntent,
  isLeadGenTool,
  missingLeadGenInfo,
  parseLeadGenMessage,
} from "../leadgenArgs.js";
import { liveLeadGenContext, nextLeadGenContext } from "../leadgenContext.js";
import { formatLeadGenResult, LEADGEN_OFF_MESSAGE, LEADGEN_PLAN_MESSAGE } from "../leadgenFormatters.js";
import { IntentDetectionService } from "../../services/intentDetection.service.js";
import { approvalPolicyService } from "../../services/approvalPolicy.service.js";
import { INTENT_DOMAIN } from "../../config/intents.js";
import { leadGenAgent, LEADGEN_TOOL_MAP } from "../../agents/LeadGenAgent.js";
import { isStandaloneCommand } from "../busyWorkflow.js";
import { managerNode } from "../../graph/nodes/manager.node.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";
import type { McpToolResult } from "../../types/mcp.js";

const detector = new IntentDetectionService();
const ok = (data: unknown): McpToolResult => ({ data: { success: true, data }, isToolError: false, rawContent: [] });

describe("detectLeadGenIntent (use case section 9 phrases)", () => {
  it.each([
    ["Lahore ke dental clinics dhundo, owners bhi", "generate_leads"],
    ["find dentists in Lahore daily at 9", "generate_leads"],
    ["Find real estate agencies in Dubai", "generate_leads"],
    ["generate leads for software houses in Karachi", "generate_leads"],
    ["Karachi mein software houses chahiye", "generate_leads"],
    ["isay roz subah 9 baje chalao", "schedule_lead_search"],
    ["run the Lahore search every Monday at 10am", "schedule_lead_search"],
    ["mere schedules dikhao", "list_lead_schedules"],
    ["show my lead searches", "list_lead_schedules"],
    ["Lahore wala schedule band kar do", "pause_lead_schedule"],
    ["resume the dentist search schedule", "pause_lead_schedule"],
    ["aaj kitni nayi leads aayi?", "show_new_leads"],
    ["show today's new leads", "show_new_leads"],
    ["hot leads CRM mein daal do", "save_leads_to_crm"],
    ["save today's leads to the CRM", "save_leads_to_crm"],
    ["add these leads to campaign 22", "add_leads_to_campaign"],
    ["lead search status", "lead_run_status"],
  ])("%s → %s", (message, intent) => {
    expect(detectLeadGenIntent(message)).toBe(intent);
    expect(detector.detect(message).intent).toBe(intent);
  });

  it.each([
    "show hot leads",
    "hot leads",
    "interested wale leads dikhao",
    "move Ali to Interested",
    "schedule campaign Summer Sale tomorrow at 9",
    "show follow up schedule",
    "research these companies https://acme.com https://example.io",
    "find companies in my CRM pipeline",
    "show campaigns",
    "Ali ko Meeting Booked mein daal do",
  ])("does not take %s away from other domains", (message) => {
    expect(detectLeadGenIntent(message)).toBeUndefined();
    expect(INTENT_DOMAIN[detector.detect(message).intent]).not.toBe("leadgen");
  });

  it("\"show hot leads\" stays the CRM hot leads", () => {
    expect(detector.detect("show hot leads").intent).toBe("show_hot_leads");
  });
});

describe("parseLeadGenMessage", () => {
  it("English: category, city, time, frequency, country", () => {
    expect(parseLeadGenMessage("find dentists in Lahore daily at 9")).toMatchObject({ category: "dentists", city: "Lahore", runAtLocal: "09:00", frequency: "daily" });
    expect(parseLeadGenMessage("find 30 real estate agencies in Dubai")).toMatchObject({ category: "real estate agencies", city: "Dubai", countryCode: "AE", targetPerRun: 30 });
    expect(parseLeadGenMessage("find dental clinics in Lahore, Pakistan with owners")).toMatchObject({ city: "Lahore", countryCode: "PK", includePeople: true });
  });

  it("Roman Urdu: city first, people, evening time, weekdays", () => {
    expect(parseLeadGenMessage("Lahore ke dental clinics dhundo, owners bhi")).toMatchObject({ city: "Lahore", category: "dental clinics", includePeople: true });
    expect(parseLeadGenMessage("isay roz shaam 6 baje chalao")).toMatchObject({ runAtLocal: "18:00", frequency: "daily" });
    expect(parseLeadGenMessage("har somwar aur budh ko 10 baje chalao")).toMatchObject({ runAtLocal: "10:00", frequency: "weekly", weekdays: ["mon", "wed"] });
    expect(parseLeadGenMessage("run it on weekdays at 8:30pm")).toMatchObject({ runAtLocal: "20:30", weekdays: ["mon", "tue", "wed", "thu", "fri"] });
  });

  it("a whole country is not a city (the agent asks for one)", () => {
    const p = parseLeadGenMessage("find dentists in Pakistan");
    expect(p.city).toBeUndefined();
    expect(p.countryCode).toBe("PK");
  });

  it("schedule references, pause/resume, tiers, today, campaign", () => {
    expect(parseLeadGenMessage("Lahore wala schedule band kar do")).toMatchObject({ search: "Lahore", isPaused: true });
    expect(parseLeadGenMessage("resume the dentist search")).toMatchObject({ search: "dentist", isPaused: false });
    expect(parseLeadGenMessage("hot leads CRM mein daal do")).toMatchObject({ tiers: ["hot"] });
    expect(parseLeadGenMessage("add today's hot leads to campaign 22")).toMatchObject({ tiers: ["hot"], foundToday: true, campaign: "22" });
    expect(parseLeadGenMessage("add leads to the Dental Outreach campaign")).toMatchObject({ campaign: "Dental Outreach" });
  });
});

describe("buildLeadGenToolArgs", () => {
  it("create_saved_search: runs now without a time, waits for the schedule with one", () => {
    expect(buildLeadGenToolArgs("create_saved_search", { extractedArgs: undefined, userMessage: "Lahore ke dental clinics dhundo" }))
      .toEqual({ category: "dental clinics", city: "Lahore", includePeople: false, targetPerRun: 20, runNow: true });
    expect(buildLeadGenToolArgs("create_saved_search", { extractedArgs: undefined, userMessage: "find dentists in Lahore daily at 9" }).runNow).toBe(false);
  });

  it("LLM arguments win over the message; no undefined keys reach the strict MCP schemas", () => {
    const args = buildLeadGenToolArgs("create_saved_search", {
      extractedArgs: { category: "dentist", city: "Karachi", includePeople: true, limit: 150 },
      userMessage: "find dentists in Lahore",
    });
    expect(args).toEqual({ category: "dentist", city: "Karachi", includePeople: true, targetPerRun: 100, runNow: true });
    expect(Object.values(args)).not.toContain(undefined);
  });

  it("schedule / pause / leads / CRM / campaign args", () => {
    expect(buildLeadGenToolArgs("create_search_schedule", { extractedArgs: { query: "Lahore dentists", runAt: "9:00" } })).toEqual({ search: "Lahore dentists", runAtLocal: "09:00", frequency: "daily" });
    expect(buildLeadGenToolArgs("update_search_schedule", { extractedArgs: undefined, userMessage: "Lahore wala schedule band kar do" })).toEqual({ search: "Lahore", isPaused: true });
    expect(buildLeadGenToolArgs("list_workspace_leads", { extractedArgs: undefined, userMessage: "aaj kitni nayi leads aayi?" })).toEqual({ foundToday: true, limit: 10 });
    expect(buildLeadGenToolArgs("save_leads_to_crm", { extractedArgs: undefined, userMessage: "hot leads CRM mein daal do" })).toEqual({ tiers: ["hot"] });
    expect(buildLeadGenToolArgs("save_leads_to_crm", { extractedArgs: undefined, userMessage: "leads CRM mein daal do" })).toEqual({ foundToday: true });
    expect(buildLeadGenToolArgs("add_leads_to_campaign", { extractedArgs: { campaignId: "22", tiers: ["hot"] } })).toEqual({ campaign: "22", tiers: ["hot"] });
  });

  it("asks for what is missing instead of calling a tool", () => {
    expect(missingLeadGenInfo("create_saved_search", { city: "Lahore" })).toMatch(/what kind of businesses/i);
    expect(missingLeadGenInfo("create_saved_search", { category: "dentists" })).toMatch(/Kis shehar mein/);
    expect(missingLeadGenInfo("create_search_schedule", { search: "Lahore" })).toMatch(/what time/i);
    expect(missingLeadGenInfo("create_search_schedule", { runAtLocal: "09:00" })).toMatch(/which lead search/i);
    expect(missingLeadGenInfo("add_leads_to_campaign", { tiers: ["hot"] })).toMatch(/which campaign/i);
    expect(missingLeadGenInfo("list_workspace_leads", {})).toBeUndefined();
  });
});

describe("LeadGenAgent", () => {
  const state = (intent: string, userMessage: string, llmExtractedArgs?: object) =>
    ({ intent, userMessage, llmExtractedArgs, userId: "u1", sessionId: "s1" }) as unknown as AgentGraphStateType;

  it("maps every lead finder intent to one known tool", () => {
    for (const tool of Object.values(LEADGEN_TOOL_MAP)) expect(isLeadGenTool(tool)).toBe(true);
    for (const intent of Object.keys(LEADGEN_TOOL_MAP)) expect(INTENT_DOMAIN[intent as keyof typeof INTENT_DOMAIN]).toBe("leadgen");
  });

  it("generate_leads → asks the focus first, keeping the parsed args for create_saved_search", async () => {
    const r = await leadGenAgent.handle(state("generate_leads", "Lahore ke dental clinics dhundo, owners bhi"));
    expect(r.toolName).toBeUndefined();
    expect(r.error).toMatch(/working on/);
    expect((r.leadGenContext as { pending?: { request: object } }).pending?.request)
      .toMatchObject({ category: "dental clinics", city: "Lahore", includePeople: true });
  });

  it("asks for the city when it is missing (\"Kis shehar mein?\")", async () => {
    const r = await leadGenAgent.handle(state("generate_leads", "find dentists", { category: "dentists" }));
    expect(r.toolName).toBeUndefined();
    expect(r.error).toMatch(/Kis shehar mein/);
  });

  it("scheduling and adding to a campaign need approval; the rest does not", () => {
    expect(approvalPolicyService.requiresApproval("schedule_lead_search")).toBe(true);
    expect(approvalPolicyService.requiresApproval("add_leads_to_campaign")).toBe(true);
    for (const i of ["generate_leads", "list_lead_schedules", "pause_lead_schedule", "show_new_leads", "save_leads_to_crm", "lead_run_status"] as const) {
      expect(approvalPolicyService.requiresApproval(i)).toBe(false);
    }
  });
});

describe("collisions with other flows", () => {
  it("manager routes lead finder intents to the leadgen node", async () => {
    const r = await managerNode({ intent: "generate_leads", userMessage: "find dentists in Lahore" } as unknown as AgentGraphStateType);
    expect(r.agentDomain).toBe("leadgen");
  });

  it("a lead finder request during the bulk workflow gets the busy reply and leaves the flow alone", async () => {
    const r = await managerNode({
      intent: "generate_leads", userMessage: "find dentists in Lahore", bulkWorkflow: { step: "awaiting_rows" },
    } as unknown as AgentGraphStateType);
    expect(JSON.parse(String(r.formattedResponse)).status).toBe("busy");
    expect(r.agentDomain).toBeUndefined();
  });

  it("lead finder chips are standalone commands", () => {
    expect(isStandaloneCommand("Find leads")).toBe(true);
    expect(isStandaloneCommand("mere schedules dikhao")).toBe(true);
    expect(isStandaloneCommand("Lahore dentists")).toBe(false);
  });
});

describe("formatLeadGenResult", () => {
  it("search created + run started", () => {
    const out = JSON.parse(formatLeadGenResult("generate_leads", "create_saved_search", ok({
      search: { name: "Lahore dentists", category: "dentist", city: "Lahore", targetPerRun: 20, includePeople: true, keywords: [] },
      run: { status: "queued", stats: {} },
    })));
    expect(out.status).toBe("success");
    expect(out.message).toMatch(/Lahore dentists/);
    expect(out.message).toMatch(/decision makers too/);
    expect(out.message).toMatch(/queued/);
  });

  it("schedule shows the next run in the user's timezone", () => {
    const out = JSON.parse(formatLeadGenResult("schedule_lead_search", "create_search_schedule", ok({
      search: { name: "Lahore dentists", keywords: [] },
      schedule: { frequency: "daily", runAtLocal: "09:00", timezone: "Asia/Karachi", weekdays: [], nextRunAt: "2026-10-30T04:03:00.000Z" },
    })));
    expect(out.message).toMatch(/every day at \*\*09:00\*\*/);
    expect(out.message).toMatch(/9:03/);
  });

  it("plan / switched-off errors become plain messages", () => {
    const plan: McpToolResult = { data: { success: false, error: { code: "MAILFLOW_FORBIDDEN", httpStatus: 403, details: { code: "PLAN_FEATURE_REQUIRED" } } }, isToolError: false, rawContent: [] };
    expect(JSON.parse(formatLeadGenResult("generate_leads", "create_saved_search", plan)).message).toBe(LEADGEN_PLAN_MESSAGE);
    const off: McpToolResult = { data: { success: false, error: { code: "MAILFLOW_NOT_FOUND", httpStatus: 404 } }, isToolError: false, rawContent: [] };
    expect(JSON.parse(formatLeadGenResult("show_new_leads", "list_workspace_leads", off)).message).toBe(LEADGEN_OFF_MESSAGE);
  });

  it("no new leads / unclear search names", () => {
    expect(JSON.parse(formatLeadGenResult("show_new_leads", "list_workspace_leads", ok({ leads: [], total: 0 }))).message).toMatch(/No new leads yet/);
    expect(JSON.parse(formatLeadGenResult("pause_lead_schedule", "update_search_schedule", ok({
      schedule: null, searchName: null, unknownSearch: "Karachi", availableSearches: ["Karachi dentists", "Karachi real estate"],
    }))).message).toMatch(/Karachi dentists.*Karachi real estate/);
  });
});

describe("conversation memory (leadGenContext) and the create + schedule chain", () => {
  const ctx = { lastSearch: { id: 7, name: "Dentists in Lahore", atIso: new Date().toISOString() }, lastLeads: { ids: [11, 12, 13], atIso: new Date().toISOString() } };
  const st = (intent: string, userMessage: string, extra: object = {}) =>
    ({ intent, userMessage, userId: "u1", sessionId: "s1", ...extra }) as unknown as AgentGraphStateType;

  it("\"find dentists in Lahore daily at 9\" = one approved step: create the search and schedule it", async () => {
    let r = await leadGenAgent.handle(st("generate_leads", "find dentists in Lahore daily at 9", { clientTimezone: "Asia/Dubai" }));
    // Focus and leads per run are asked first; "skip" keeps the defaults.
    for (let i = 0; i < 3 && r.error; i++) {
      const leadGenContext = nextLeadGenContext(r.leadGenContext as never, { toolName: undefined, toolResult: undefined });
      r = await leadGenAgent.handle(st("generate_leads", "skip", { clientTimezone: "Asia/Dubai", leadGenContext }));
    }
    expect(r.intent).toBe("schedule_lead_search");
    expect(r.toolName).toBe("create_search_schedule");
    expect(r.toolArgs).toEqual({
      newSearch: { category: "dentists", city: "Lahore", includePeople: false, targetPerRun: 20 },
      runAtLocal: "09:00", frequency: "daily", timezone: "Asia/Dubai",
    });
    expect(r.crmAction?.requiresApproval).toBe(true);
    expect(r.crmAction?.confirmText).toMatch(/dentists in Lahore.*every day at 09:00.*Asia\/Dubai/);
  });

  it("\"isay roz subah 9 baje chalao\" schedules the last search (approval text names it)", async () => {
    const r = await leadGenAgent.handle(st("schedule_lead_search", "isay roz subah 9 baje chalao", { leadGenContext: ctx }));
    expect(r.toolArgs).toEqual({ search: "7", runAtLocal: "09:00", frequency: "daily" });
    expect(r.crmAction?.confirmText).toMatch(/\*\*Dentists in Lahore\*\* will run \*\*every day at 09:00\*\*/);
  });

  it("without a last search, scheduling asks which search", async () => {
    const r = await leadGenAgent.handle(st("schedule_lead_search", "isay roz subah 9 baje chalao"));
    expect(r.error).toMatch(/which lead search/i);
  });

  it("\"inhein campaign 22 mein daal do\" after a lead list = exactly those leads, with approval", async () => {
    expect(detectLeadGenIntent("inhein campaign 22 mein daal do", ctx)).toBe("add_leads_to_campaign");
    expect(detectLeadGenIntent("inhein campaign 22 mein daal do")).toBeUndefined();
    expect(detectLeadGenIntent("inko CRM mein daal do", ctx)).toBe("save_leads_to_crm");
    const r = await leadGenAgent.handle(st("add_leads_to_campaign", "inhein campaign 22 mein daal do", { leadGenContext: ctx }));
    expect(r.toolArgs).toEqual({ campaign: "22", leadIds: [11, 12, 13] });
    expect(r.crmAction?.confirmText).toMatch(/3 leads shown last.*campaign \*\*22\*\*/);
  });

  it("\"run it now\" runs the last search", async () => {
    expect(detectLeadGenIntent("run it now", ctx)).toBe("run_lead_search");
    expect(detectLeadGenIntent("isay abhi chalao", ctx)).toBe("run_lead_search");
    const r = await leadGenAgent.handle(st("run_lead_search", "run it now", { leadGenContext: ctx }));
    expect(r).toMatchObject({ toolName: "run_saved_search", toolArgs: { search: "7" } });
  });

  it("memory: created / scheduled search and listed leads are remembered; old entries expire", () => {
    const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });
    const a = nextLeadGenContext(undefined, { toolName: "create_saved_search", toolResult: ok({ search: { id: 9, name: "Gyms in Karachi" }, run: null }) });
    expect(a?.lastSearch).toMatchObject({ id: 9, name: "Gyms in Karachi" });
    const b = nextLeadGenContext(a, { toolName: "list_workspace_leads", toolResult: ok({ leads: [{ id: 1 }, { id: 2 }], total: 2 }) });
    expect(b?.lastLeads?.ids).toEqual([1, 2]);
    expect(b?.lastSearch?.id).toBe(9);
    const failed = nextLeadGenContext(b, { toolName: "create_saved_search", toolResult: { data: { success: false, error: {} }, isToolError: false, rawContent: [] } });
    expect(failed?.lastSearch?.id).toBe(9);
    const old = { lastLeads: { ids: [1], atIso: new Date(Date.now() - 31 * 60_000).toISOString() } };
    expect(liveLeadGenContext(old)).toBeUndefined();
  });
});

describe("focus (category + what they do)", () => {
  it("the category phrase keeps the focus words (the backend splits them); LLM focus passes through", () => {
    expect(buildLeadGenToolArgs("create_saved_search", { extractedArgs: undefined, userMessage: "find IT companies working on AI automation in Lahore" }))
      .toMatchObject({ category: "IT companies working on AI automation", city: "Lahore" });
    expect(buildLeadGenToolArgs("create_saved_search", { extractedArgs: { category: "IT companies", focus: "AI automation", city: "Lahore" } }))
      .toMatchObject({ category: "IT companies", focus: "AI automation", city: "Lahore" });
    expect(parseLeadGenMessage("find software houses in Karachi, focus on chatbots").focus).toBe("chatbots");
  });
});

describe("a question waits for its answer (\"Kis shehar mein?\" -> \"Karachi\")", () => {
  const turn = (intent: string, userMessage: string, leadGenContext?: unknown, llmExtractedArgs?: object) =>
    leadGenAgent.handle({ intent, userMessage, llmExtractedArgs, leadGenContext, userId: "u1", sessionId: "s1" } as unknown as AgentGraphStateType);
  /** What saveMemory keeps for the next turn. */
  const save = (r: { leadGenContext?: unknown }) => nextLeadGenContext(r.leadGenContext as never, { toolName: undefined, toolResult: undefined });
  /** Answers "skip" to the optional questions (focus, leads per run, schedule) until a tool is chosen. */
  const finish = async (r: Awaited<ReturnType<typeof turn>>) => {
    for (let i = 0; i < 3 && r.error; i++) r = await turn("generate_leads", "skip", save(r));
    return r;
  };

  it("the screenshot conversation: IT companies doing app development, then the city", async () => {
    const r1 = await turn("generate_leads", "lead geeration kr ka do IT companies ki jo app development pa kam krti hon", undefined, { category: "IT companies" });
    expect(r1.error).toMatch(/Kis shehar mein/);
    const ctx = save(r1);
    expect(ctx?.pending).toMatchObject({ intent: "generate_leads", missing: "city", request: { category: "IT companies", focus: "app development" } });
    const r2 = await finish(await turn("generate_leads", "Karachi", ctx));
    expect(r2.toolName).toBe("create_saved_search");
    expect(r2.toolArgs).toEqual({ category: "IT companies", focus: "app development", city: "Karachi", includePeople: false, targetPerRun: 20, runNow: true });
    expect(save(r2)?.pending).toBeUndefined();
  });

  it("the \"Find new leads\" button: business type (with focus) first, then the city", async () => {
    expect(detectLeadGenIntent("Find new leads")).toBe("generate_leads");
    const r1 = await turn("generate_leads", "Find new leads");
    expect(r1.error).toMatch(/What kind of businesses/);
    const r2 = await turn("generate_leads", "IT companies jo app development pa kam krti hon", save(r1));
    expect(r2.error).toMatch(/Kis shehar mein/);
    const r3 = await finish(await turn("generate_leads", "karachi mein", save(r2)));
    expect(r3.toolArgs).toMatchObject({ category: "IT companies", focus: "app development", city: "Karachi" });
  });

  it("a country is not a city (asks again); cancel drops the request; an unrelated turn forgets it", async () => {
    const r1 = await turn("generate_leads", "find dentists", undefined, { category: "dentists" });
    const again = await turn("generate_leads", "Pakistan", save(r1));
    expect(again.error).toMatch(/Kis shehar mein/);
    expect(save(again)?.pending?.request.countryCode).toBe("PK");
    const cancelled = await turn("generate_leads", "rehne do", save(r1));
    expect(JSON.parse(String(cancelled.formattedResponse)).message).toMatch(/cancelled/);
    expect(save(cancelled)?.pending).toBeUndefined();
    // Another tool ran this turn instead (the question was not answered): the question is gone.
    expect(nextLeadGenContext(save(r1), { toolName: "list_campaigns", toolResult: undefined })?.pending).toBeUndefined();
  });

  it("time and campaign answers", () => {
    expect(applyAnswer({ search: "7" }, "time", "9 baje")).toMatchObject({ runAtLocal: "09:00" });
    expect(applyAnswer({ search: "7" }, "time", "6pm")).toMatchObject({ runAtLocal: "18:00" });
    expect(applyAnswer({}, "campaign", "campaign 22")).toMatchObject({ campaign: "22" });
    expect(applyAnswer({}, "campaign", "Dental Outreach")).toMatchObject({ campaign: "Dental Outreach" });
  });
});

describe("detectIntent node routes the answer to the waiting request", () => {
  it("\"Karachi\" after \"Kis shehar mein?\" is generate_leads, not out of domain; a command is not an answer", async () => {
    const { detectIntentNode } = await import("../../graph/nodes/detectIntent.node.js");
    const pending = { intent: "generate_leads", request: { category: "IT companies" }, missing: "city", atIso: new Date().toISOString() };
    const base = { userId: "u1", sessionId: "s1", messages: [], leadGenContext: { pending } };
    const r = await detectIntentNode({ ...base, userMessage: "Karachi" } as unknown as AgentGraphStateType);
    expect(r.intent).toBe("generate_leads");
    const cmd = await detectIntentNode({ ...base, userMessage: "show campaigns" } as unknown as AgentGraphStateType);
    expect(cmd.intent).not.toBe("generate_leads");
  });
});
