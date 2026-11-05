/**
 * src/mcp/tools/leadgen/leadgen.tools.ts
 *
 * Lead Engine tools (lead finder). Thin wrappers over the backend /lead-gen API — no business logic here:
 * the backend checks plan, quotas, ownership and runs the scraping in its worker.
 *
 *   create_saved_search     new ICP (category + city ...), optionally run now
 *   run_saved_search        "run it now" (counts towards today's quota)
 *   create_search_schedule  daily / weekly schedule of a search (agent asks for approval first)
 *   list_search_schedules   saved searches with their schedules
 *   update_search_schedule  pause / resume / change time
 *   get_lead_run            status + numbers of a run (latest when no id)
 *   list_workspace_leads    leads found for the user, with filters
 *   save_leads_to_crm       leads -> CRM contacts (leads without email are skipped by the backend)
 *   add_leads_to_campaign   leads -> recipients of a draft/paused campaign (agent asks for approval first)
 *   get_lead_finder_crm_summary  lead finder leads in the CRM, grouped by the search that found them
 *
 * Saved searches can be named ("Lahore dentists", "Lahore wala"); names are resolved here.
 * The user is always taken from the bearer token; no tool accepts a userId.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import {
  AddLeadsToCampaignSchema,
  CreateSavedSearchSchema,
  CreateSearchScheduleSchema,
  GetLeadFinderCrmSummarySchema,
  GetLeadRunSchema,
  ListSearchSchedulesSchema,
  ListWorkspaceLeadsSchema,
  RunSavedSearchSchema,
  SaveLeadsToCrmSchema,
  UpdateSearchScheduleSchema,
} from "../../../schemas/leadgen.schemas.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { IMailFlowApiClient } from "../../../lib/mailflowApiClient.js";
import type {
  AddLeadsToCampaignToolResult,
  CreateSavedSearchResult,
  CreateSearchScheduleResult,
  GetLeadRunResult,
  LeadFinderCrmSearchGroup,
  LeadFinderCrmSummaryResult,
  LeadListParams,
  LeadScoreTier,
  LeadStatus,
  ListSearchSchedulesResult,
  ListWorkspaceLeadsResult,
  RunSavedSearchResult,
  SavedLeadSearch,
  SaveLeadsToCrmToolResult,
  UpdateSearchScheduleResult,
  WorkspaceLead,
} from "../../../types/leadgen.js";
import { normalizeName, resolveCampaign } from "../crm/crm.tools.js";

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

/** Most leads one save / add call takes (the schema allows the same for explicit ids). */
export const MAX_LEADS_PER_ACTION = 500;

/**
 * Saved search by id ("12") or words: exact name first, then a single search whose name, city or
 * category contains the words ("Lahore wala" -> "Lahore dentists"). Several or none = not resolved.
 */
export async function resolveSavedSearch(
  mailflow: IMailFlowApiClient,
  ref: string,
): Promise<{ search: SavedLeadSearch } | { search: null; available: string[] }> {
  const searches = await mailflow.listLeadSearches();
  if (/^\d+$/.test(ref)) {
    const byId = searches.find((s) => s.id === Number(ref));
    return byId ? { search: byId } : { search: null, available: searches.slice(0, 10).map((s) => s.name) };
  }
  const words = ref
    .toLowerCase()
    .replace(/\b(wala|wali|wale|ka|ki|ke|schedule|search|the|my|leads?)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeName);
  const wanted = normalizeName(ref);
  const exact = searches.filter((s) => normalizeName(s.name) === wanted);
  if (exact.length === 1) return { search: exact[0]! };
  const hay = (s: SavedLeadSearch) => normalizeName(`${s.name} ${s.city ?? ""} ${s.category ?? ""} ${s.keywords.join(" ")}`);
  const partial = words.length ? searches.filter((s) => words.every((w) => hay(s).includes(w))) : [];
  if (partial.length === 1) return { search: partial[0]! };
  return { search: null, available: (partial.length > 1 ? partial : searches).slice(0, 10).map((s) => s.name) };
}

/** Lead ids from explicit ids or from filters (paged, at most MAX_LEADS_PER_ACTION). */
async function collectLeadIds(
  mailflow: IMailFlowApiClient,
  filters: LeadListParams,
): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; ids.length < MAX_LEADS_PER_ACTION; page++) {
    const list = await mailflow.listWorkspaceLeads({ ...filters, limit: 100, page });
    ids.push(...list.leads.map((l) => l.id));
    if (list.leads.length < 100 || ids.length >= list.total) break;
  }
  return ids.slice(0, MAX_LEADS_PER_ACTION);
}

type FilterInput = {
  search?: string | undefined;
  foundToday?: boolean | undefined;
  tiers?: LeadScoreTier[] | undefined;
  statuses?: LeadStatus[] | undefined;
  hasEmail?: boolean | undefined;
  hasDecisionMaker?: boolean | undefined;
};

/** Filters -> API params; resolves the search name. `problem` is set when the search name is unclear. */
async function leadParams(
  mailflow: IMailFlowApiClient,
  input: FilterInput,
  defaultStatuses?: LeadStatus[],
): Promise<{ params: LeadListParams; searchName: string | null; problem?: { unknownSearch: string; availableSearches: string[] } }> {
  let savedSearchId: number | undefined;
  let searchName: string | null = null;
  if (input.search) {
    const found = await resolveSavedSearch(mailflow, input.search);
    if (!found.search) return { params: {}, searchName: null, problem: { unknownSearch: input.search, availableSearches: found.available } };
    savedSearchId = found.search.id;
    searchName = found.search.name;
  }
  return {
    params: {
      savedSearchId,
      foundToday: input.foundToday,
      tiers: input.tiers,
      statuses: input.statuses ?? defaultStatuses,
      hasEmail: input.hasEmail,
      hasDecisionMaker: input.hasDecisionMaker,
    },
    searchName,
  };
}

// ── create_saved_search ──────────────────────────────────────────────────────

export const createSavedSearchTool: McpToolDefinition<typeof CreateSavedSearchSchema, CreateSavedSearchResult> = {
  name: TOOL_NAMES.CREATE_SAVED_SEARCH,
  description:
    "Creates a lead search (ICP): business category (e.g. dentist, real estate) or keywords, city, optional country, " +
    "whether to also find decision makers, and leads per run (1-100). runNow=true also starts a run right away " +
    "(counts towards today's lead quota). Finds businesses from OpenStreetMap, search results and company websites.",
  inputSchema: CreateSavedSearchSchema,
  handler: async (input, context) => {
    try {
      const { runNow, ...body } = input;
      const search = await context.mailflow.createLeadSearch(body);
      const run = runNow ? await context.mailflow.runLeadSearch(search.id) : null;
      return toolSuccess({ search, run });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── run_saved_search ─────────────────────────────────────────────────────────

export const runSavedSearchTool: McpToolDefinition<typeof RunSavedSearchSchema, RunSavedSearchResult> = {
  name: TOOL_NAMES.RUN_SAVED_SEARCH,
  description: "Starts a run of a saved lead search now (id or name). Counts towards today's lead quota.",
  inputSchema: RunSavedSearchSchema,
  handler: async (input, context) => {
    try {
      const found = await resolveSavedSearch(context.mailflow, input.search);
      if (!found.search) return toolSuccess({ search: null, run: null, unknownSearch: input.search, availableSearches: found.available });
      const run = await context.mailflow.runLeadSearch(found.search.id);
      return toolSuccess({ search: found.search, run });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── create_search_schedule ───────────────────────────────────────────────────

export const createSearchScheduleTool: McpToolDefinition<typeof CreateSearchScheduleSchema, CreateSearchScheduleResult> = {
  name: TOOL_NAMES.CREATE_SEARCH_SCHEDULE,
  description:
    "Schedules a saved lead search (id or name), or creates one first (newSearch), daily or on weekdays at a local time (HH:MM) in the user's timezone. " +
    "A search has one schedule: an existing one is updated. Each run uses the daily lead quota.",
  inputSchema: CreateSearchScheduleSchema,
  handler: async (input, context) => {
    try {
      let search: SavedLeadSearch;
      if (input.newSearch) {
        search = await context.mailflow.createLeadSearch(input.newSearch);
      } else {
        const found = await resolveSavedSearch(context.mailflow, input.search!);
        if (!found.search) return toolSuccess({ search: null, schedule: null, unknownSearch: input.search!, availableSearches: found.available });
        search = found.search;
      }
      const schedule = await context.mailflow.upsertLeadSchedule(search.id, {
        frequency: input.frequency,
        runAtLocal: input.runAtLocal,
        timezone: input.timezone,
        weekdays: input.weekdays,
      });
      return toolSuccess({ search, schedule });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_search_schedules ────────────────────────────────────────────────────

export const listSearchSchedulesTool: McpToolDefinition<typeof ListSearchSchedulesSchema, ListSearchSchedulesResult> = {
  name: TOOL_NAMES.LIST_SEARCH_SCHEDULES,
  description: "Lists the user's saved lead searches with their schedule (time, next run, paused). Read-only.",
  inputSchema: ListSearchSchedulesSchema,
  handler: async (_input, context) => {
    try {
      return toolSuccess({ searches: await context.mailflow.listLeadSearches() });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── update_search_schedule ───────────────────────────────────────────────────

export const updateSearchScheduleTool: McpToolDefinition<typeof UpdateSearchScheduleSchema, UpdateSearchScheduleResult> = {
  name: TOOL_NAMES.UPDATE_SEARCH_SCHEDULE,
  description:
    "Pauses, resumes or changes the schedule of a saved lead search (id or name, e.g. \"Lahore\"). " +
    "A run that is already going is not stopped.",
  inputSchema: UpdateSearchScheduleSchema,
  handler: async (input, context) => {
    try {
      const { search: ref, ...changes } = input;
      const found = await resolveSavedSearch(context.mailflow, ref);
      if (!found.search) return toolSuccess({ schedule: null, searchName: null, unknownSearch: ref, availableSearches: found.available });
      if (!found.search.schedule) {
        return toolSuccess({ schedule: null, searchName: found.search.name, unknownSearch: ref, availableSearches: [] });
      }
      const schedule = await context.mailflow.updateLeadSchedule(found.search.schedule.id, changes);
      return toolSuccess({ schedule, searchName: found.search.name });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── get_lead_run ─────────────────────────────────────────────────────────────

export const getLeadRunTool: McpToolDefinition<typeof GetLeadRunSchema, GetLeadRunResult> = {
  name: TOOL_NAMES.GET_LEAD_RUN,
  description: "Status and numbers of a lead search run (found, new leads, failed). Latest run when no runId is given. Read-only.",
  inputSchema: GetLeadRunSchema,
  handler: async (input, context) => {
    try {
      if (input.runId !== undefined) return toolSuccess({ run: await context.mailflow.getLeadRun(input.runId), searchName: null });
      let savedSearchId: number | undefined;
      let searchName: string | null = null;
      if (input.search) {
        const found = await resolveSavedSearch(context.mailflow, input.search);
        if (found.search) {
          savedSearchId = found.search.id;
          searchName = found.search.name;
        }
      }
      const [run] = await context.mailflow.listLeadRuns({ savedSearchId, limit: 1 });
      return toolSuccess({ run: run ?? null, searchName });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_workspace_leads ─────────────────────────────────────────────────────

export const listWorkspaceLeadsTool: McpToolDefinition<typeof ListWorkspaceLeadsSchema, ListWorkspaceLeadsResult> = {
  name: TOOL_NAMES.LIST_WORKSPACE_LEADS,
  description:
    "Lists leads the lead finder found for the user: filter by saved search (id or name), found today, " +
    "Hot/Warm/Cold, status, has email, has decision maker. Read-only. (CRM leads are list_crm_contacts.)",
  inputSchema: ListWorkspaceLeadsSchema,
  handler: async (input, context) => {
    try {
      const { params, searchName, problem } = await leadParams(context.mailflow, input);
      if (problem) return toolSuccess({ leads: [], total: 0, page: 1, limit: input.limit, searchName: null, ...problem });
      const list = await context.mailflow.listWorkspaceLeads({ ...params, limit: input.limit });
      return toolSuccess({ ...list, searchName });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── save_leads_to_crm ────────────────────────────────────────────────────────

export const saveLeadsToCrmTool: McpToolDefinition<typeof SaveLeadsToCrmSchema, SaveLeadsToCrmToolResult> = {
  name: TOOL_NAMES.SAVE_LEADS_TO_CRM,
  description:
    `Saves lead finder leads into the CRM (by leadIds or by the same filters as list_workspace_leads, max ${MAX_LEADS_PER_ACTION}). ` +
    "Leads without an email or on the suppression list are skipped. With filters, only new/reviewed leads are taken.",
  inputSchema: SaveLeadsToCrmSchema,
  handler: async (input, context) => {
    try {
      let ids = input.leadIds;
      if (!ids) {
        const { params, problem } = await leadParams(context.mailflow, input, ["new", "reviewed"]);
        if (problem) return toolFailure("UNKNOWN_SEARCH", `No saved search matches "${problem.unknownSearch}"`, problem);
        ids = await collectLeadIds(context.mailflow, params);
      }
      if (ids.length === 0) return toolSuccess({ saved: 0, updated: 0, skippedNoEmail: 0, skippedSuppressed: 0, leadCount: 0 });
      const result = await context.mailflow.saveLeadsToCrm(ids);
      return toolSuccess({ ...result, leadCount: ids.length });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── add_leads_to_campaign ────────────────────────────────────────────────────

export const addLeadsToCampaignTool: McpToolDefinition<typeof AddLeadsToCampaignSchema, AddLeadsToCampaignToolResult> = {
  name: TOOL_NAMES.ADD_LEADS_TO_CAMPAIGN,
  description:
    "Adds lead finder leads (leadIds or filters) as recipients of a draft or paused campaign (id or name). " +
    "Only leads with a verified email are added; nothing is sent. Starting the campaign is a separate, approved step.",
  inputSchema: AddLeadsToCampaignSchema,
  handler: async (input, context) => {
    try {
      const { campaign, leadIds, ...filters } = input;
      const found = await resolveCampaign(context.mailflow, campaign);
      let ids = leadIds;
      if (!ids) {
        const { params, problem } = await leadParams(context.mailflow, filters, ["new", "reviewed", "saved_to_crm"]);
        if (problem) return toolFailure("UNKNOWN_SEARCH", `No saved search matches "${problem.unknownSearch}"`, problem);
        ids = await collectLeadIds(context.mailflow, params);
      }
      if (found.id === null) return toolSuccess({ campaignId: null, unknownCampaign: campaign, availableCampaigns: found.available, leadCount: ids.length });
      if (ids.length === 0) {
        return toolSuccess({ campaignId: found.id, added: 0, skippedNoEmail: 0, skippedDuplicate: 0, skippedSuppressed: 0, leadCount: 0, campaignName: found.name });
      }
      const result = await context.mailflow.addLeadsToCampaign(ids, found.id);
      return toolSuccess({ ...result, leadCount: ids.length, campaignName: found.name });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── get_lead_finder_crm_summary ──────────────────────────────────────────────

/** Leads read for the summary (newest first); more than this is reported as truncated. */
export const MAX_SUMMARY_LEADS = 1000;
const SAMPLE_PER_SEARCH = 5;

export const getLeadFinderCrmSummaryTool: McpToolDefinition<typeof GetLeadFinderCrmSummarySchema, LeadFinderCrmSummaryResult> = {
  name: TOOL_NAMES.GET_LEAD_FINDER_CRM_SUMMARY,
  description:
    "Read-only. Lead finder leads that are in the CRM (saved to CRM or added to a campaign), grouped by the saved search " +
    "that found them: count, in campaign, Hot/Warm/Cold, a few names. Optional search (id or name).",
  inputSchema: GetLeadFinderCrmSummarySchema,
  handler: async (input, context) => {
    try {
      const m = context.mailflow;
      const { params, searchName, problem } = await leadParams(m, input, ["saved_to_crm", "in_campaign"]);
      const empty = { total: 0, inCampaign: 0, bySearch: [], truncated: false, searchName };
      if (problem) return toolSuccess({ ...empty, searchName: null, ...problem });

      const [searches, leads] = await Promise.all([
        m.listLeadSearches(),
        (async () => {
          const out: WorkspaceLead[] = [];
          let total = 0;
          for (let page = 1; out.length < MAX_SUMMARY_LEADS; page++) {
            const list = await m.listWorkspaceLeads({ ...params, limit: 100, page });
            total = list.total;
            out.push(...list.leads);
            if (list.leads.length < 100 || out.length >= list.total) break;
          }
          return { items: out.slice(0, MAX_SUMMARY_LEADS), total };
        })(),
      ]);
      if (leads.items.length === 0) return toolSuccess(empty);

      const byId = new Map(searches.map((s) => [s.id, s]));
      const groups = new Map<number | null, LeadFinderCrmSearchGroup>();
      for (const l of leads.items) {
        const key = l.savedSearchId;
        let g = groups.get(key);
        if (!g) {
          const s = key === null ? undefined : byId.get(key);
          g = {
            searchId: key, searchName: s?.name ?? null, category: s?.category ?? null, city: s?.city ?? null, focus: s?.keywords ?? [],
            total: 0, inCampaign: 0, hot: 0, warm: 0, cold: 0, lastFoundAt: null, sample: [],
          };
          groups.set(key, g);
        }
        g.total++;
        if (l.status === "in_campaign") g.inCampaign++;
        g[l.scoreTier]++;
        if (!g.lastFoundAt || l.foundAt > g.lastFoundAt) g.lastFoundAt = l.foundAt;
        if (g.sample.length < SAMPLE_PER_SEARCH) {
          g.sample.push({
            crmContactId: l.crmContactId,
            company: l.company.name,
            person: l.person?.fullName ?? null,
            email: l.person?.email ?? l.company.email,
            status: l.status,
          });
        }
      }
      const bySearch = [...groups.values()].sort((a, b) => b.total - a.total);
      return toolSuccess({
        total: leads.items.length,
        inCampaign: bySearch.reduce((n, g) => n + g.inCampaign, 0),
        bySearch,
        truncated: leads.total > leads.items.length,
        searchName,
      });
    } catch (err) {
      return failure(err);
    }
  },
};

export const LEADGEN_TOOLS = [
  createSavedSearchTool,
  runSavedSearchTool,
  createSearchScheduleTool,
  listSearchSchedulesTool,
  updateSearchScheduleTool,
  getLeadRunTool,
  listWorkspaceLeadsTool,
  saveLeadsToCrmTool,
  addLeadsToCampaignTool,
  getLeadFinderCrmSummaryTool,
] as const;
