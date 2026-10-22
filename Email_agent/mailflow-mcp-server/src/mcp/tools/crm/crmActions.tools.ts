/**
 * src/mcp/tools/crm/crmActions.tools.ts
 *
 * CRM write actions (agent phase 2).
 *
 *   prepare_crm_action        — read-only: names → ids (lead, many leads, stage, tags, campaign, pipeline)
 *   move_crm_lead             — move one lead to a stage
 *   tag_crm_lead              — add or remove one tag on one lead
 *   create_crm_tag            — new tag
 *   snooze_crm_lead           — hide a lead from "needs reply" until a time
 *   mark_crm_lead_done        — clear "needs reply"
 *   set_crm_reply_label       — change the label of one reply (rules and score run again)
 *   bulk_update_crm_leads     — move and/or tag many leads at once (one transaction)
 *   set_crm_campaign_settings — start pipeline and auto tags of a campaign (adds tags, keeps the others)
 *
 * The write tools take ids only — the agent calls prepare_crm_action first and asks the user
 * when anything is unclear. The user always comes from the bearer token.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import {
  BulkUpdateCrmLeadsSchema,
  CreateCrmTagSchema,
  MarkCrmLeadDoneSchema,
  MoveCrmLeadSchema,
  PrepareCrmActionSchema,
  SetCrmCampaignSettingsSchema,
  SetCrmReplyLabelSchema,
  SnoozeCrmLeadSchema,
  TagCrmLeadSchema,
} from "../../../schemas/crm.schemas.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CrmActionPreparation, CrmContactDetail, CrmContactMatch, CrmTag, CrmWriteResult } from "../../../types/crm.js";
import { normalizeName, resolveCampaign, resolveLeadFilters, resolveStage, resolveTags } from "./crm.tools.js";

/** Bulk actions never touch more leads than the backend accepts in one call. */
export const MAX_BULK_LEADS = 1000;

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

/** One lead from a name/email search: exact email, then exact name, then the only match. */
export function pickLead(matches: CrmContactMatch[], query: string): CrmContactMatch | undefined {
  const q = query.trim().toLowerCase();
  const byEmail = matches.filter((m) => m.email.toLowerCase() === q);
  if (byEmail.length === 1) return byEmail[0];
  const byName = matches.filter((m) => m.name && normalizeName(m.name) === normalizeName(q));
  if (byName.length === 1) return byName[0];
  return matches.length === 1 ? matches[0] : undefined;
}

function leadOf(detail: CrmContactDetail): NonNullable<CrmActionPreparation["lead"]> {
  const c = detail.contact;
  return { id: c.id, email: c.email, name: c.name, stageName: c.stageName, stageType: c.stageType, pipelineId: c.pipelineId };
}

// ── prepare_crm_action ───────────────────────────────────────────────────────

export const prepareCrmActionTool: McpToolDefinition<typeof PrepareCrmActionSchema, CrmActionPreparation> = {
  name: TOOL_NAMES.PREPARE_CRM_ACTION,
  description:
    "Read-only. Resolves the names in a CRM request to ids before a change: one lead (name/email), many leads (filters), " +
    "destination stage, tags, campaign, pipeline, and optionally the lead's latest reply. Lists the choices when a name is unclear.",
  inputSchema: PrepareCrmActionSchema,
  handler: async (input, context) => {
    try {
      const m = context.mailflow;
      const out: CrmActionPreparation = {};
      let detail: CrmContactDetail | undefined;

      if (input.leadId !== undefined) {
        detail = await m.getCrmContact(input.leadId);
      } else if (input.lead) {
        out.leadQuery = input.lead;
        const matches = await m.lookupCrmContacts(input.lead);
        const pick = pickLead(matches, input.lead);
        if (pick) detail = await m.getCrmContact(pick.id);
        else out.leadMatches = matches.slice(0, 10);
      }
      if (detail) {
        out.lead = leadOf(detail);
        if (input.needLatestReply) {
          const r = detail.replies.find((x) => x.direction !== "outbound");
          out.latestReply = r ? { id: r.id, label: r.label, subject: r.subject, snippet: r.snippet, receivedAt: r.receivedAt } : null;
        }
      }

      if (input.toStage) {
        const found = await resolveStage(m, input.toStage, out.lead?.pipelineId ?? undefined);
        if (found.stage) out.stage = found.stage;
        else {
          out.unknownStage = input.toStage;
          out.availableStages = found.available;
        }
      }

      if (input.tags?.length) {
        const found = await resolveTags(m, input.tags);
        out.tags = found.tags;
        if (found.unknown.length) {
          out.unknownTags = found.unknown;
          out.availableTags = found.available;
        }
      }

      if (input.campaign) {
        const found = await resolveCampaign(m, input.campaign);
        if (found.id === null) {
          out.unknownCampaign = input.campaign;
          out.availableCampaigns = found.available;
        } else {
          out.campaign = { id: found.id, name: found.name, settings: await m.getCrmCampaignSettings(found.id) };
        }
      }

      if (input.pipeline) {
        const pipelines = await m.listCrmPipelines();
        const wanted = normalizeName(input.pipeline);
        const exact = pipelines.filter((p) => normalizeName(p.name) === wanted);
        const partial = exact.length ? exact : pipelines.filter((p) => normalizeName(p.name).includes(wanted));
        if (partial.length === 1) out.pipeline = partial[0]!;
        else {
          out.unknownPipeline = input.pipeline;
          out.availablePipelines = pipelines.map((p) => p.name);
        }
      }

      if (input.targets) {
        const { stage, tags, campaign, ...plain } = input.targets;
        const resolved = await resolveLeadFilters(m, { stage, tags, campaign });
        if (!resolved.ok) {
          const { appliedFilters: _ignored, ...problem } = resolved.problem;
          Object.assign(out, problem);
        } else {
          const ids: number[] = [];
          let total = 0;
          let sample: CrmContactMatch[] = [];
          for (let page = 1; ids.length < MAX_BULK_LEADS; page++) {
            const list = await m.listCrmContacts({ ...plain, ...resolved.ids, limit: 100, page });
            if (page === 1) {
              total = list.total;
              sample = list.contacts.slice(0, 5).map((c) => ({ id: c.id, email: c.email, name: c.name, stageName: c.stageName }));
            }
            ids.push(...list.contacts.map((c) => c.id));
            if (list.contacts.length < 100) break;
          }
          out.targets = {
            total,
            ids: ids.slice(0, MAX_BULK_LEADS),
            sample,
            truncated: total > MAX_BULK_LEADS,
            appliedFilters: resolved.appliedFilters,
          };
        }
      }

      return toolSuccess(out);
    } catch (err) {
      return failure(err);
    }
  },
};

// ── Single-lead writes ───────────────────────────────────────────────────────

export const moveCrmLeadTool: McpToolDefinition<typeof MoveCrmLeadSchema, CrmWriteResult> = {
  name: TOOL_NAMES.MOVE_CRM_LEAD,
  description: "Moves one CRM lead to a stage (by ids from prepare_crm_action). The stage's rules and follow-up stop apply.",
  inputSchema: MoveCrmLeadSchema,
  handler: async (input, context) => {
    try {
      const res = await context.mailflow.moveCrmContact(input.contactId, input.stageId);
      return toolSuccess({ ...res, ok: true, ...(input.leadName ? { lead: input.leadName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};

export const tagCrmLeadTool: McpToolDefinition<typeof TagCrmLeadSchema, CrmWriteResult> = {
  name: TOOL_NAMES.TAG_CRM_LEAD,
  description: "Adds (or with remove=true removes) one tag on one CRM lead, by ids. The lead's score is recalculated.",
  inputSchema: TagCrmLeadSchema,
  handler: async (input, context) => {
    try {
      await context.mailflow.setCrmContactTag(input.contactId, input.tagId, input.remove);
      return toolSuccess({
        ok: true,
        removed: input.remove,
        ...(input.leadName ? { lead: input.leadName } : {}),
        ...(input.tagName ? { tag: input.tagName } : {}),
      });
    } catch (err) {
      return failure(err);
    }
  },
};

export const createCrmTagTool: McpToolDefinition<typeof CreateCrmTagSchema, { ok: boolean; tag: CrmTag }> = {
  name: TOOL_NAMES.CREATE_CRM_TAG,
  description: "Creates a CRM tag (name, optional #rrggbb color, scope both / contact / campaign).",
  inputSchema: CreateCrmTagSchema,
  handler: async (input, context) => {
    try {
      return toolSuccess({ ok: true, tag: await context.mailflow.createCrmTag(input) });
    } catch (err) {
      return failure(err);
    }
  },
};

export const snoozeCrmLeadTool: McpToolDefinition<typeof SnoozeCrmLeadSchema, CrmWriteResult> = {
  name: TOOL_NAMES.SNOOZE_CRM_LEAD,
  description: "Snoozes the needs-reply reminder of one CRM lead until a time (at most 90 days ahead).",
  inputSchema: SnoozeCrmLeadSchema,
  handler: async (input, context) => {
    try {
      const res = await context.mailflow.snoozeCrmContact(input.contactId, input.until);
      return toolSuccess({ ...res, ok: true, ...(input.leadName ? { lead: input.leadName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};

export const markCrmLeadDoneTool: McpToolDefinition<typeof MarkCrmLeadDoneSchema, CrmWriteResult> = {
  name: TOOL_NAMES.MARK_CRM_LEAD_DONE,
  description: "Clears the needs-reply mark of one CRM lead (the user has answered).",
  inputSchema: MarkCrmLeadDoneSchema,
  handler: async (input, context) => {
    try {
      const res = await context.mailflow.markCrmContactDone(input.contactId);
      return toolSuccess({ ...res, ok: true, ...(input.leadName ? { lead: input.leadName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};

export const setCrmReplyLabelTool: McpToolDefinition<typeof SetCrmReplyLabelSchema, CrmWriteResult> = {
  name: TOOL_NAMES.SET_CRM_REPLY_LABEL,
  description: "Changes the label of one reply by hand. The lead's rules and score run again.",
  inputSchema: SetCrmReplyLabelSchema,
  handler: async (input, context) => {
    try {
      const res = await context.mailflow.setReplyLabel(input.replyId, input.label);
      return toolSuccess({ ...res, ok: true, label: input.label, ...(input.leadName ? { lead: input.leadName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};

// ── Many leads / campaign ────────────────────────────────────────────────────

export const bulkUpdateCrmLeadsTool: McpToolDefinition<typeof BulkUpdateCrmLeadsSchema, CrmWriteResult> = {
  name: TOOL_NAMES.BULK_UPDATE_CRM_LEADS,
  description: "Moves and/or tags many CRM leads at once (ids from prepare_crm_action). All or nothing.",
  inputSchema: BulkUpdateCrmLeadsSchema,
  handler: async (input, context) => {
    try {
      const res = await context.mailflow.bulkUpdateCrmContacts(input);
      return toolSuccess({ ...res, ok: true });
    } catch (err) {
      return failure(err);
    }
  },
};

export const setCrmCampaignSettingsTool: McpToolDefinition<typeof SetCrmCampaignSettingsSchema, CrmWriteResult> = {
  name: TOOL_NAMES.SET_CRM_CAMPAIGN_SETTINGS,
  description:
    "Sets the start pipeline of a campaign's leads and/or adds auto tags (added to every lead of the campaign, now and later). " +
    "Existing auto tags are kept.",
  inputSchema: SetCrmCampaignSettingsSchema,
  handler: async (input, context) => {
    try {
      const current = await context.mailflow.getCrmCampaignSettings(input.campaignId);
      const settings = {
        pipelineId: input.pipelineId ?? current.pipelineId,
        autoTagIds: [...new Set([...current.autoTagIds, ...(input.addTagIds ?? [])])],
      };
      const res = await context.mailflow.saveCrmCampaignSettings(input.campaignId, settings);
      return toolSuccess({ ...res, ok: true, ...(input.campaignName ? { campaign: input.campaignName } : {}) });
    } catch (err) {
      return failure(err);
    }
  },
};
