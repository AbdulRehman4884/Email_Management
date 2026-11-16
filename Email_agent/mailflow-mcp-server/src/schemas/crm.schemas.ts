/**
 * src/schemas/crm.schemas.ts
 *
 * Zod input schemas for the read-only CRM tools (agent phase 1).
 *
 * Rules:
 *  - userId is NEVER a schema field — the backend takes it from the bearer token
 *  - stages and tags are given by NAME (what the user types); the tool resolves ids
 */

import { z } from "zod";
import { CRM_CONTACT_SORTS, CRM_REPLY_LABELS, CRM_SCORE_TIERS } from "../types/crm.js";

const positiveId = z.number().int().positive();

/** Campaign id ("42") or name ("Black Friday"); the tool resolves names. */
const campaignRef = z.union([z.string().trim().min(1).max(255), positiveId]).transform(String);

export const GetCrmSummarySchema = z.object({
  /** Omit for the user's default pipeline. */
  pipelineId: positiveId.optional(),
  campaign: campaignRef.optional(),
});

export const ListCrmContactsSchema = z.object({
  /** Name, email or company (partial match). */
  search: z.string().trim().min(1).max(100).optional(),
  /** Stage name, e.g. "Interested" (case-insensitive). */
  stage: z.string().trim().min(1).max(100).optional(),
  labels: z.array(z.enum(CRM_REPLY_LABELS)).max(7).optional(),
  scoreTiers: z.array(z.enum(CRM_SCORE_TIERS)).max(3).optional(),
  /** Tag names; the lead must have all of them. */
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  pipelineId: positiveId.optional(),
  campaign: campaignRef.optional(),
  /** Only leads waiting for the user's reply. */
  needsReply: z.boolean().optional(),
  /** Interested or hot score. */
  hotOnly: z.boolean().optional(),
  sort: z.enum(CRM_CONTACT_SORTS).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const GetCrmContactSchema = z
  .object({
    contactId: positiveId.optional(),
    /** Name or email to look up. */
    query: z.string().trim().min(1).max(100).optional(),
  })
  .refine((v) => v.contactId !== undefined || v.query !== undefined, {
    message: "Give contactId or query (a name or email)",
  });

export const ListCrmNeedsReplySchema = z.object({
  includeSnoozed: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10),
});

export const ListCrmPipelinesSchema = z.object({});

export const ListCrmTagsSchema = z.object({});

// ── Phase 2: write actions ───────────────────────────────────────────────────
// The agent first calls prepare_crm_action (read-only) to turn names into ids,
// then one write tool with ids only. Write tools never guess.

/** Lead filters for bulk actions — same names as list_crm_contacts. */
const CrmTargetFiltersSchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  stage: z.string().trim().min(1).max(100).optional(),
  labels: z.array(z.enum(CRM_REPLY_LABELS)).max(7).optional(),
  scoreTiers: z.array(z.enum(CRM_SCORE_TIERS)).max(3).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  campaign: campaignRef.optional(),
  needsReply: z.boolean().optional(),
  hotOnly: z.boolean().optional(),
});

export const PrepareCrmActionSchema = z.object({
  /** One lead by name or email. */
  lead: z.string().trim().min(1).max(100).optional(),
  leadId: positiveId.optional(),
  /** Many leads by filter (bulk). At least one filter is required. */
  targets: CrmTargetFiltersSchema.refine((t) => Object.keys(t).length > 0, { message: "targets needs at least one filter" }).optional(),
  /** Destination stage name (in the lead's pipeline, or the default pipeline for bulk). */
  toStage: z.string().trim().min(1).max(100).optional(),
  /** Tag names that must exist. */
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  campaign: campaignRef.optional(),
  /** Pipeline name, for campaign settings. */
  pipeline: z.string().trim().min(1).max(255).optional(),
  /** Also return the lead's latest inbound reply (to change its label). */
  needLatestReply: z.boolean().default(false),
});

const leadName = z.string().trim().max(200).optional();

export const MoveCrmLeadSchema = z.object({ contactId: positiveId, stageId: positiveId, leadName });

export const TagCrmLeadSchema = z.object({
  contactId: positiveId,
  tagId: positiveId,
  remove: z.boolean().default(false),
  leadName,
  tagName: z.string().trim().max(50).optional(),
});

export const CreateCrmTagSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  scope: z.enum(["both", "contact", "campaign"]).optional(),
});

export const SnoozeCrmLeadSchema = z.object({ contactId: positiveId, until: z.string().datetime({ offset: true }), leadName });

export const MarkCrmLeadDoneSchema = z.object({ contactId: positiveId, leadName });

export const SetCrmReplyLabelSchema = z.object({ replyId: positiveId, label: z.enum(CRM_REPLY_LABELS), leadName });

export const BulkUpdateCrmLeadsSchema = z
  .object({
    contactIds: z.array(positiveId).min(1).max(1000),
    addTagIds: z.array(positiveId).max(20).optional(),
    removeTagIds: z.array(positiveId).max(20).optional(),
    moveToStageId: positiveId.optional(),
  })
  .refine((v) => (v.addTagIds?.length ?? 0) + (v.removeTagIds?.length ?? 0) > 0 || v.moveToStageId !== undefined, {
    message: "Nothing to do: add tags, remove tags or pick a stage",
  });

export const SetCrmCampaignSettingsSchema = z
  .object({
    campaignId: positiveId,
    /** New start pipeline for the campaign's leads; omitted = keep the current one. */
    pipelineId: positiveId.optional(),
    /** Tags added to the campaign's auto tags (existing auto tags are kept). */
    addTagIds: z.array(positiveId).max(20).optional(),
    campaignName: z.string().trim().max(255).optional(),
  })
  .refine((v) => v.pipelineId !== undefined || (v.addTagIds?.length ?? 0) > 0, {
    message: "Give a pipeline or tags to add",
  });

export type PrepareCrmActionInput = z.infer<typeof PrepareCrmActionSchema>;
export type GetCrmSummaryInput = z.infer<typeof GetCrmSummarySchema>;
export type ListCrmContactsInput = z.infer<typeof ListCrmContactsSchema>;
export type GetCrmContactInput = z.infer<typeof GetCrmContactSchema>;
export type ListCrmNeedsReplyInput = z.infer<typeof ListCrmNeedsReplySchema>;
