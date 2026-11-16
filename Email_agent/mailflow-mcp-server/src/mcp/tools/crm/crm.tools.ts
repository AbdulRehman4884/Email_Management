/**
 * src/mcp/tools/crm/crm.tools.ts
 *
 * CRM read-only tools (agent phase 1). None of them change anything.
 *
 *   get_crm_summary       — KPIs, leads per stage, funnel, label counts
 *   list_crm_contacts     — leads with filters (stage / tag by NAME, label, tier, needs reply…)
 *   get_crm_contact       — one lead by id, or looked up by name / email
 *   list_crm_needs_reply  — leads waiting for the user's answer
 *   list_crm_pipelines    — pipelines with their stages
 *   list_crm_tags         — the user's tags
 *
 * The user is always taken from the bearer token; no tool accepts a userId.
 * Users without CRM in their plan get the backend's 403 PLAN_FEATURE_REQUIRED as a tool failure.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import {
  GetCrmContactSchema,
  GetCrmSummarySchema,
  ListCrmContactsSchema,
  ListCrmNeedsReplySchema,
  ListCrmPipelinesSchema,
  ListCrmTagsSchema,
} from "../../../schemas/crm.schemas.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { IMailFlowApiClient } from "../../../lib/mailflowApiClient.js";
import type {
  CrmContactListResult,
  CrmContactLookupResult,
  CrmNeedsReplyList,
  CrmPipelinesResult,
  CrmStage,
  CrmSummaryResult,
  CrmTag,
  CrmTagsResult,
} from "../../../types/crm.js";

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

/** "Meeting  Booked" / "meeting_booked" / "meeting-booked" all compare equal. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Finds a stage by name: the given pipeline, else the default pipeline first, then the others.
 * `available` lists the stage names of the first pipeline searched (for a "did you mean" reply).
 */
export async function resolveStage(
  mailflow: IMailFlowApiClient,
  name: string,
  pipelineId?: number,
): Promise<{ stage: CrmStage | null; available: string[] }> {
  const pipelines = await mailflow.listCrmPipelines();
  const ordered = pipelineId !== undefined ? pipelines.filter((p) => p.id === pipelineId) : pipelines;
  const wanted = normalizeName(name);
  let available: string[] = [];
  for (const p of ordered) {
    const stages = await mailflow.listCrmStages(p.id);
    if (available.length === 0) available = stages.map((s) => s.name);
    const hit = stages.find((s) => normalizeName(s.name) === wanted);
    if (hit) return { stage: hit, available };
  }
  return { stage: null, available };
}

/**
 * Campaign id ("42") or name: exact name first, then a single partial match.
 * Several partial matches or none = not resolved (`available` lists up to 10 names).
 */
export async function resolveCampaign(
  mailflow: IMailFlowApiClient,
  ref: string,
): Promise<{ id: number; name: string | null } | { id: null; available: string[] }> {
  if (/^\d+$/.test(ref)) return { id: Number(ref), name: null };
  const campaigns = await mailflow.getAllCampaigns();
  const wanted = normalizeName(ref);
  const exact = campaigns.filter((c) => normalizeName(c.name) === wanted);
  const partial = exact.length ? exact : campaigns.filter((c) => normalizeName(c.name).includes(wanted));
  const hit = partial.length === 1 ? partial[0] : undefined;
  if (hit) return { id: Number(hit.id), name: hit.name };
  return { id: null, available: (partial.length > 1 ? partial : campaigns).slice(0, 10).map((c) => c.name) };
}

// ── get_crm_summary ──────────────────────────────────────────────────────────

export const getCrmSummaryTool: McpToolDefinition<typeof GetCrmSummarySchema, CrmSummaryResult> = {
  name: TOOL_NAMES.GET_CRM_SUMMARY,
  description:
    "CRM overview for one pipeline (default pipeline unless pipelineId is given), optionally for one campaign (id or name): " +
    "total leads, Interested, meetings, Won, Lost, win rate, needs-reply and hot counts, leads per stage, the funnel " +
    "and reply label counts. Read-only.",
  inputSchema: GetCrmSummarySchema,
  handler: async (input, context) => {
    try {
      let campaignId: number | undefined;
      let campaignName: string | undefined;
      if (input.campaign) {
        const found = await resolveCampaign(context.mailflow, input.campaign);
        if (found.id === null) {
          return toolSuccess({
            pipeline: null, kpis: null, stages: [], labels: {}, funnel: [],
            unknownCampaign: input.campaign, availableCampaigns: found.available,
          });
        }
        campaignId = found.id;
        campaignName = found.name ?? undefined;
      }
      const summary = await context.mailflow.getCrmSummary({ pipelineId: input.pipelineId, campaignId });
      return toolSuccess({ ...summary, ...(campaignName ? { campaignName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_crm_contacts ────────────────────────────────────────────────────────

export const listCrmContactsTool: McpToolDefinition<typeof ListCrmContactsSchema, CrmContactListResult> = {
  name: TOOL_NAMES.LIST_CRM_CONTACTS,
  description:
    "Lists CRM leads with filters: stage name, reply labels, Hot/Warm/Cold, tag names, campaign (id or name), needs reply, " +
    "Interested-or-hot only, search by name/email/company. Read-only.",
  inputSchema: ListCrmContactsSchema,
  handler: async (input, context) => {
    try {
      const { stage, tags, campaign, ...rest } = input;
      const resolved = await resolveLeadFilters(context.mailflow, { stage, tags, campaign, pipelineId: input.pipelineId });
      if (!resolved.ok) {
        return toolSuccess({ contacts: [], total: 0, limit: input.limit, offset: 0, page: 1, ...resolved.problem });
      }
      const list = await context.mailflow.listCrmContacts({ ...rest, ...resolved.ids });
      return toolSuccess({ ...list, appliedFilters: resolved.appliedFilters });
    } catch (err) {
      return failure(err);
    }
  },
};

/** Tag names → the user's lead tags (campaign-only tags never match). */
export async function resolveTags(
  mailflow: IMailFlowApiClient,
  names: string[],
): Promise<{ tags: CrmTag[]; unknown: string[]; available: string[] }> {
  const all = (await mailflow.listCrmTags()).filter((t) => t.scope !== "campaign");
  const byName = new Map(all.map((t) => [normalizeName(t.name), t]));
  const unknown = names.filter((t) => !byName.has(normalizeName(t)));
  const tags = names.map((t) => byName.get(normalizeName(t))).filter((t): t is CrmTag => t !== undefined);
  return { tags, unknown, available: all.map((t) => t.name) };
}

type LeadFilterProblem = Pick<
  CrmContactListResult,
  "appliedFilters" | "unknownStage" | "availableStages" | "unknownTags" | "availableTags" | "unknownCampaign" | "availableCampaigns"
>;

/**
 * Stage / tag / campaign NAMES of a lead filter → ids for GET /crm/contacts.
 * A name that matches nothing stops the search (ok: false) with the names that do exist.
 */
export async function resolveLeadFilters(
  mailflow: IMailFlowApiClient,
  f: { stage?: string | undefined; tags?: string[] | undefined; campaign?: string | undefined; pipelineId?: number | undefined },
): Promise<
  | { ok: true; ids: { stageId?: number; tagIds?: number[]; campaignId?: number }; appliedFilters: CrmContactListResult["appliedFilters"] }
  | { ok: false; problem: LeadFilterProblem }
> {
  const appliedFilters: CrmContactListResult["appliedFilters"] = {};
  const ids: { stageId?: number; tagIds?: number[]; campaignId?: number } = {};

  if (f.campaign) {
    const found = await resolveCampaign(mailflow, f.campaign);
    if (found.id === null) return { ok: false, problem: { appliedFilters, unknownCampaign: f.campaign, availableCampaigns: found.available } };
    ids.campaignId = found.id;
    if (found.name) appliedFilters.campaignName = found.name;
  }
  if (f.stage) {
    const found = await resolveStage(mailflow, f.stage, f.pipelineId);
    if (!found.stage) return { ok: false, problem: { appliedFilters, unknownStage: f.stage, availableStages: found.available } };
    ids.stageId = found.stage.id;
    appliedFilters.stageName = found.stage.name;
  }
  if (f.tags?.length) {
    const found = await resolveTags(mailflow, f.tags);
    if (found.unknown.length) return { ok: false, problem: { appliedFilters, unknownTags: found.unknown, availableTags: found.available } };
    ids.tagIds = found.tags.map((t) => t.id);
    appliedFilters.tagNames = found.tags.map((t) => t.name);
  }
  return { ok: true, ids, appliedFilters };
}

// ── get_crm_contact ──────────────────────────────────────────────────────────

export const getCrmContactTool: McpToolDefinition<typeof GetCrmContactSchema, CrmContactLookupResult> = {
  name: TOOL_NAMES.GET_CRM_CONTACT,
  description:
    "One CRM lead with stage, score (and why), tags, campaigns, latest replies and stage history. " +
    "Give contactId, or query = a name or email. Several matches are returned as a list to choose from. Read-only.",
  inputSchema: GetCrmContactSchema,
  handler: async (input, context) => {
    try {
      if (input.contactId !== undefined) {
        const detail = await context.mailflow.getCrmContact(input.contactId);
        const c = detail.contact;
        return toolSuccess({ detail, matches: [{ id: c.id, email: c.email, name: c.name, stageName: c.stageName }] });
      }
      const query = input.query!;
      const matches = await context.mailflow.lookupCrmContacts(query);
      const exact = matches.filter((m) => m.email.toLowerCase() === query.toLowerCase());
      const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      if (!pick) return toolSuccess({ detail: null, matches, query });
      return toolSuccess({ detail: await context.mailflow.getCrmContact(pick.id), matches, query });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_crm_needs_reply ─────────────────────────────────────────────────────

export const listCrmNeedsReplyTool: McpToolDefinition<typeof ListCrmNeedsReplySchema, CrmNeedsReplyList> = {
  name: TOOL_NAMES.LIST_CRM_NEEDS_REPLY,
  description:
    "Leads who replied and are still waiting for the user's answer, most urgent first (overdue, then Interested/Question). Read-only.",
  inputSchema: ListCrmNeedsReplySchema,
  handler: async (input, context) => {
    try {
      const list = await context.mailflow.listCrmNeedsReply({ includeSnoozed: input.includeSnoozed });
      return toolSuccess({ ...list, leads: list.leads.slice(0, input.limit) });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_crm_pipelines ───────────────────────────────────────────────────────

export const listCrmPipelinesTool: McpToolDefinition<typeof ListCrmPipelinesSchema, CrmPipelinesResult> = {
  name: TOOL_NAMES.LIST_CRM_PIPELINES,
  description: "The user's CRM pipelines, each with its stages in order and the lead count per stage. Read-only.",
  inputSchema: ListCrmPipelinesSchema,
  handler: async (_input, context) => {
    try {
      const pipelines = await context.mailflow.listCrmPipelines();
      const stages = await Promise.all(pipelines.map((p) => context.mailflow.listCrmStages(p.id)));
      return toolSuccess({ pipelines: pipelines.map((p, i) => ({ ...p, stages: stages[i] ?? [] })) });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── list_crm_tags ────────────────────────────────────────────────────────────

export const listCrmTagsTool: McpToolDefinition<typeof ListCrmTagsSchema, CrmTagsResult> = {
  name: TOOL_NAMES.LIST_CRM_TAGS,
  description: "The user's CRM tags with how many leads and campaigns use each one. Read-only.",
  inputSchema: ListCrmTagsSchema,
  handler: async (_input, context) => {
    try {
      return toolSuccess({ tags: await context.mailflow.listCrmTags() });
    } catch (err) {
      return failure(err);
    }
  },
};
