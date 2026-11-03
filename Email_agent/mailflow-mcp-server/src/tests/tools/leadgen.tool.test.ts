import { describe, expect, it, vi } from "vitest";
import {
  addLeadsToCampaignTool,
  createSavedSearchTool,
  createSearchScheduleTool,
  getLeadRunTool,
  LEADGEN_TOOLS,
  listWorkspaceLeadsTool,
  resolveSavedSearch,
  runSavedSearchTool,
  saveLeadsToCrmTool,
  updateSearchScheduleTool,
} from "../../mcp/tools/leadgen/leadgen.tools.js";
import {
  AddLeadsToCampaignSchema,
  CreateSavedSearchSchema,
  CreateSearchScheduleSchema,
  GetLeadRunSchema,
  ListWorkspaceLeadsSchema,
  RunSavedSearchSchema,
  SaveLeadsToCrmSchema,
  UpdateSearchScheduleSchema,
} from "../../schemas/leadgen.schemas.js";
import { MailFlowApiError } from "../../lib/errors.js";
import { MockMailFlowApiClient } from "../../lib/mockMailflowApiClient.js";
import { createMockMailflowClient, createMockToolContext } from "../helpers.js";
import type { SavedLeadSearch, WorkspaceLead } from "../../types/leadgen.js";

const schedule = {
  id: 40, savedSearchId: 1, frequency: "daily" as const, runAtLocal: "09:00", timezone: "Asia/Karachi",
  weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const, nextRunAt: "2026-10-30T04:03:00Z",
  lastRunAt: null, isPaused: false, consecutiveFailures: 0,
};
const search = (id: number, name: string, city: string, withSchedule = false): SavedLeadSearch => ({
  id, name, category: "dentist", keywords: [], city, region: null, countryCode: "PK", includePeople: false,
  targetPerRun: 20, isActive: true, createdAt: "2026-10-29", schedule: withSchedule ? { ...schedule, weekdays: [...schedule.weekdays], savedSearchId: id } : null,
});
const SEARCHES = [search(1, "Lahore dentists", "Lahore", true), search(2, "Karachi dentists", "Karachi"), search(3, "Karachi real estate", "Karachi")];
const lead = (id: number): WorkspaceLead => ({
  id, status: "new", fitScore: 70, scoreTier: "hot", foundAt: "2026-10-29", savedSearchId: 1,
  company: { id, name: `C${id}`, domain: null, websiteUrl: null, category: "dentist", city: "Lahore", countryCode: "PK", phone: null, email: `c${id}@x.com`, linkedinUrl: null },
  person: null, crmContactId: null,
});
const run = { id: 9, savedSearchId: 1, scheduleId: null, runDate: "2026-10-29", runType: "manual" as const, status: "queued" as const, stats: {}, startedAt: null, completedAt: null, error: null };

function ctx(overrides: Parameters<typeof createMockMailflowClient>[0] = {}) {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      listLeadSearches: vi.fn().mockResolvedValue(SEARCHES),
      runLeadSearch: vi.fn().mockResolvedValue(run),
      getAllCampaigns: vi.fn().mockResolvedValue([{ id: "22", name: "Dental Outreach" }, { id: "23", name: "Dental Follow-up" }]),
      ...overrides,
    }),
  });
}

describe("lead engine tool set", () => {
  it("has the 9 tools of the plan", () => {
    expect(LEADGEN_TOOLS.map((t) => t.name)).toEqual([
      "create_saved_search", "run_saved_search", "create_search_schedule", "list_search_schedules", "update_search_schedule",
      "get_lead_run", "list_workspace_leads", "save_leads_to_crm", "add_leads_to_campaign",
    ]);
  });
});

describe("schemas", () => {
  it("are strict: unknown keys such as userId are rejected", () => {
    expect(CreateSavedSearchSchema.safeParse({ city: "Lahore", category: "dentist", userId: 5 }).success).toBe(false);
    expect(ListWorkspaceLeadsSchema.safeParse({ userId: 5 }).success).toBe(false);
    expect(RunSavedSearchSchema.safeParse({ search: "x", extra: 1 }).success).toBe(false);
  });

  it("create_saved_search needs a city and a category or keyword; defaults people off, 20 per run", () => {
    expect(CreateSavedSearchSchema.safeParse({ category: "dentist" }).success).toBe(false);
    expect(CreateSavedSearchSchema.safeParse({ city: "Lahore" }).success).toBe(false);
    const ok = CreateSavedSearchSchema.parse({ city: "Lahore", category: "dentist", countryCode: "pk" });
    expect(ok).toMatchObject({ includePeople: false, targetPerRun: 20, runNow: false, countryCode: "PK" });
    expect(CreateSavedSearchSchema.safeParse({ city: "Lahore", category: "dentist", targetPerRun: 101 }).success).toBe(false);
  });

  it("schedules: HH:MM, IANA timezone, weekly needs weekdays", () => {
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, runAtLocal: "9:00" }).success).toBe(true);
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, runAtLocal: "25:00" }).success).toBe(false);
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, runAtLocal: "09:00", timezone: "Karachi" }).success).toBe(false);
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, runAtLocal: "09:00", frequency: "weekly" }).success).toBe(false);
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, runAtLocal: "09:00", frequency: "weekly", weekdays: ["mon"] }).success).toBe(true);
    expect(UpdateSearchScheduleSchema.safeParse({ search: "Lahore" }).success).toBe(false);
  });

  it("save / add need lead ids or a filter (max 500 ids)", () => {
    expect(SaveLeadsToCrmSchema.safeParse({}).success).toBe(false);
    expect(SaveLeadsToCrmSchema.safeParse({ tiers: ["hot"] }).success).toBe(true);
    expect(SaveLeadsToCrmSchema.safeParse({ leadIds: Array.from({ length: 501 }, (_, i) => i + 1) }).success).toBe(false);
    expect(AddLeadsToCampaignSchema.safeParse({ campaign: 22 }).success).toBe(false);
    expect(AddLeadsToCampaignSchema.safeParse({ campaign: 22, foundToday: true }).success).toBe(true);
  });
});

describe("resolveSavedSearch", () => {
  it("by id, exact name, or one search matching the words (city, \"wala\")", async () => {
    const c = ctx();
    expect((await resolveSavedSearch(c.mailflow, "2")).search?.name).toBe("Karachi dentists");
    expect((await resolveSavedSearch(c.mailflow, "lahore dentists")).search?.id).toBe(1);
    expect((await resolveSavedSearch(c.mailflow, "Lahore wala")).search?.id).toBe(1);
    expect((await resolveSavedSearch(c.mailflow, "karachi real estate")).search?.id).toBe(3);
  });

  it("several or no matches are not guessed", async () => {
    const c = ctx();
    const many = await resolveSavedSearch(c.mailflow, "Karachi");
    expect(many.search).toBeNull();
    expect("available" in many && many.available).toEqual(["Karachi dentists", "Karachi real estate"]);
    expect((await resolveSavedSearch(c.mailflow, "Dubai")).search).toBeNull();
    expect((await resolveSavedSearch(c.mailflow, "99")).search).toBeNull();
  });
});

describe("create_saved_search / run_saved_search", () => {
  it("creates without running unless runNow", async () => {
    const created = search(7, "Lahore dentists", "Lahore");
    const c = ctx({ createLeadSearch: vi.fn().mockResolvedValue(created) });
    const r = await createSavedSearchTool.handler(CreateSavedSearchSchema.parse({ city: "Lahore", category: "dentist" }), c);
    expect(r).toEqual({ success: true, data: { search: created, run: null } });
    expect(c.mailflow.createLeadSearch).toHaveBeenCalledWith({ city: "Lahore", category: "dentist", includePeople: false, targetPerRun: 20 });
    expect(c.mailflow.runLeadSearch).not.toHaveBeenCalled();

    const r2 = await createSavedSearchTool.handler(CreateSavedSearchSchema.parse({ city: "Lahore", category: "dentist", runNow: true }), c);
    expect(r2.success && r2.data.run?.id).toBe(9);
    expect(c.mailflow.runLeadSearch).toHaveBeenCalledWith(7);
  });

  it("run by name; unclear name runs nothing and lists the choices", async () => {
    const c = ctx();
    const ok = await runSavedSearchTool.handler(RunSavedSearchSchema.parse({ search: "Lahore" }), c);
    expect(ok.success && ok.data.run?.id).toBe(9);
    const unclear = await runSavedSearchTool.handler(RunSavedSearchSchema.parse({ search: "Karachi" }), c);
    expect(unclear.success && unclear.data.availableSearches).toEqual(["Karachi dentists", "Karachi real estate"]);
    expect(c.mailflow.runLeadSearch).toHaveBeenCalledTimes(1);
  });

  it("a backend 403 (plan) or 404 (feature off) is a tool failure", async () => {
    const c = ctx({ createLeadSearch: vi.fn().mockRejectedValue(new MailFlowApiError(403, "Your current plan does not include this feature.", { code: "PLAN_FEATURE_REQUIRED" })) });
    const r = await createSavedSearchTool.handler(CreateSavedSearchSchema.parse({ city: "Lahore", category: "dentist" }), c);
    expect(r.success).toBe(false);
  });
});

describe("schedules", () => {
  it("create_search_schedule passes time, frequency and timezone for the resolved search", async () => {
    const c = ctx({ upsertLeadSchedule: vi.fn().mockResolvedValue(schedule) });
    const r = await createSearchScheduleTool.handler(CreateSearchScheduleSchema.parse({ search: "Karachi dentists", runAtLocal: "09:00", timezone: "Asia/Karachi" }), c);
    expect(c.mailflow.upsertLeadSchedule).toHaveBeenCalledWith(2, { frequency: "daily", runAtLocal: "09:00", timezone: "Asia/Karachi", weekdays: undefined });
    expect(r.success && r.data.search?.id).toBe(2);
  });

  it("update_search_schedule pauses the search's schedule; a search without schedule changes nothing", async () => {
    const c = ctx({ updateLeadSchedule: vi.fn().mockResolvedValue({ ...schedule, isPaused: true }) });
    const r = await updateSearchScheduleTool.handler(UpdateSearchScheduleSchema.parse({ search: "Lahore wala", isPaused: true }), c);
    expect(c.mailflow.updateLeadSchedule).toHaveBeenCalledWith(40, { isPaused: true });
    expect(r.success && r.data).toMatchObject({ searchName: "Lahore dentists", schedule: { isPaused: true } });
    const none = await updateSearchScheduleTool.handler(UpdateSearchScheduleSchema.parse({ search: "Karachi dentists", isPaused: true }), c);
    expect(none.success && none.data.schedule).toBeNull();
    expect(c.mailflow.updateLeadSchedule).toHaveBeenCalledTimes(1);
  });
});

describe("runs and leads", () => {
  it("get_lead_run: by id, else the latest run of a search", async () => {
    const c = ctx({ getLeadRun: vi.fn().mockResolvedValue(run), listLeadRuns: vi.fn().mockResolvedValue([run]) });
    await getLeadRunTool.handler(GetLeadRunSchema.parse({ runId: 9 }), c);
    expect(c.mailflow.getLeadRun).toHaveBeenCalledWith(9);
    const latest = await getLeadRunTool.handler(GetLeadRunSchema.parse({ search: "Lahore" }), c);
    expect(c.mailflow.listLeadRuns).toHaveBeenCalledWith({ savedSearchId: 1, limit: 1 });
    expect(latest.success && latest.data.searchName).toBe("Lahore dentists");
  });

  it("list_workspace_leads: filters and search name go to the API", async () => {
    const c = ctx({ listWorkspaceLeads: vi.fn().mockResolvedValue({ leads: [lead(1)], total: 1, page: 1, limit: 10 }) });
    const r = await listWorkspaceLeadsTool.handler(ListWorkspaceLeadsSchema.parse({ search: "Lahore", foundToday: true, tiers: ["hot"] }), c);
    expect(c.mailflow.listWorkspaceLeads).toHaveBeenCalledWith({
      savedSearchId: 1, foundToday: true, tiers: ["hot"], statuses: undefined, hasEmail: undefined, hasDecisionMaker: undefined, limit: 10,
    });
    expect(r.success && r.data.searchName).toBe("Lahore dentists");
  });

  it("save_leads_to_crm: \"hot leads\" collects new/reviewed hot leads over several pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => lead(i + 1));
    const page2 = [lead(101), lead(102)];
    const list = vi.fn().mockResolvedValueOnce({ leads: page1, total: 102, page: 1, limit: 100 }).mockResolvedValueOnce({ leads: page2, total: 102, page: 2, limit: 100 });
    const c = ctx({ listWorkspaceLeads: list, saveLeadsToCrm: vi.fn().mockResolvedValue({ saved: 100, updated: 0, skippedNoEmail: 2, skippedSuppressed: 0 }) });
    const r = await saveLeadsToCrmTool.handler(SaveLeadsToCrmSchema.parse({ tiers: ["hot"] }), c);
    expect(list.mock.calls[0]![0]).toMatchObject({ tiers: ["hot"], statuses: ["new", "reviewed"], page: 1 });
    expect((c.mailflow.saveLeadsToCrm as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toHaveLength(102);
    expect(r.success && r.data).toMatchObject({ saved: 100, skippedNoEmail: 2, leadCount: 102 });
  });

  it("save_leads_to_crm with no matching leads calls nothing", async () => {
    const c = ctx({ listWorkspaceLeads: vi.fn().mockResolvedValue({ leads: [], total: 0, page: 1, limit: 100 }) });
    const r = await saveLeadsToCrmTool.handler(SaveLeadsToCrmSchema.parse({ foundToday: true }), c);
    expect(r.success && r.data.leadCount).toBe(0);
    expect(c.mailflow.saveLeadsToCrm).not.toHaveBeenCalled();
  });

  it("add_leads_to_campaign: campaign by id or exact name; unclear names add nothing", async () => {
    const c = ctx({ addLeadsToCampaign: vi.fn().mockResolvedValue({ campaignId: 22, added: 2, skippedNoEmail: 0, skippedDuplicate: 0, skippedSuppressed: 0 }) });
    const ok = await addLeadsToCampaignTool.handler(AddLeadsToCampaignSchema.parse({ campaign: 22, leadIds: [1, 2] }), c);
    expect(c.mailflow.addLeadsToCampaign).toHaveBeenCalledWith([1, 2], 22);
    expect(ok.success && ok.data).toMatchObject({ added: 2, leadCount: 2 });
    const unclear = await addLeadsToCampaignTool.handler(AddLeadsToCampaignSchema.parse({ campaign: "dental", leadIds: [1] }), c);
    expect(unclear.success && unclear.data).toMatchObject({ campaignId: null, availableCampaigns: ["Dental Outreach", "Dental Follow-up"] });
    expect(c.mailflow.addLeadsToCampaign).toHaveBeenCalledTimes(1);
  });
});

describe("mock client (MOCK_MAILFLOW)", () => {
  it("supports the lead engine flow end to end", async () => {
    const mock = new MockMailFlowApiClient();
    const s = await mock.createLeadSearch({ city: "Lahore", category: "dentist" });
    expect((await mock.listLeadSearches()).some((x) => x.id === s.id)).toBe(true);
    expect((await mock.runLeadSearch(s.id)).status).toBe("queued");
    expect((await mock.upsertLeadSchedule(s.id, { runAtLocal: "09:00" })).isPaused).toBe(false);
    expect((await mock.listWorkspaceLeads({ tiers: ["hot"] })).leads.every((l) => l.scoreTier === "hot")).toBe(true);
    expect((await mock.saveLeadsToCrm([1, 2])).saved).toBe(2);
  });
});

describe("create_search_schedule with newSearch", () => {
  it("creates the search first, then schedules it (one approved step)", async () => {
    const created = search(8, "Dentists in Lahore", "Lahore");
    const c = ctx({ createLeadSearch: vi.fn().mockResolvedValue(created), upsertLeadSchedule: vi.fn().mockResolvedValue(schedule) });
    const r = await createSearchScheduleTool.handler(CreateSearchScheduleSchema.parse({ newSearch: { city: "Lahore", category: "dentists" }, runAtLocal: "09:00" }), c);
    expect(c.mailflow.createLeadSearch).toHaveBeenCalledWith({ city: "Lahore", category: "dentists", includePeople: false, targetPerRun: 20 });
    expect(c.mailflow.upsertLeadSchedule).toHaveBeenCalledWith(8, expect.objectContaining({ runAtLocal: "09:00" }));
    expect(r.success && r.data.search?.id).toBe(8);
  });

  it("needs exactly one of search / newSearch", () => {
    expect(CreateSearchScheduleSchema.safeParse({ runAtLocal: "09:00" }).success).toBe(false);
    expect(CreateSearchScheduleSchema.safeParse({ search: 1, newSearch: { city: "Lahore" }, runAtLocal: "09:00" }).success).toBe(false);
  });
});
