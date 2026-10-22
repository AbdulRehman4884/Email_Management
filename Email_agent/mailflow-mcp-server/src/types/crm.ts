/**
 * src/types/crm.ts
 *
 * Shapes returned by the MailFlow CRM API (/api/crm/* and /api/tags).
 * The backend is the source of truth; these mirror its JSON (camelCase).
 */

export const CRM_REPLY_LABELS = [
  "interested",
  "not_interested",
  "out_of_office",
  "question",
  "meeting_booked",
  "neutral",
  "bounce_unsubscribe",
] as const;
export type CrmReplyLabel = (typeof CRM_REPLY_LABELS)[number];

export const CRM_SCORE_TIERS = ["hot", "warm", "cold"] as const;
export type CrmScoreTier = (typeof CRM_SCORE_TIERS)[number];

export const CRM_CONTACT_SORTS = ["recent", "score", "name", "hot", "waiting", "added"] as const;
export type CrmContactSort = (typeof CRM_CONTACT_SORTS)[number];

export interface CrmTagRef {
  id: number;
  name: string;
  color: string;
}

// ── Summary (GET /crm/summary) ───────────────────────────────────────────────

export interface CrmSummary {
  pipeline: { id: number; name: string } | null;
  kpis: {
    total: number;
    interested: number;
    meetings: number;
    won: number;
    lost: number;
    /** Won ÷ (Won + Lost) in %; null until a lead is won or lost. */
    winRate: number | null;
    needsReply: number;
    hot: number;
  } | null;
  stages: Array<{
    id: number;
    name: string;
    color: string;
    type: string;
    position: number;
    count: number;
    avgDaysInStage: number | null;
  }>;
  /** Lead count per latest reply label, plus "none" (no reply yet). */
  labels: Record<string, number>;
  funnel: Array<{
    stageId: number;
    name: string;
    color: string;
    type: string;
    reached: number;
    conversionFromPrev: number | null;
  }>;
}

// ── Contacts (GET /crm/contacts, /crm/contacts/:id) ──────────────────────────

export interface CrmContact {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  pipelineId: number | null;
  stageId: number | null;
  stageName: string | null;
  stageColor: string | null;
  stageType: string | null;
  score: number;
  scoreTier: string;
  lastReplyLabel: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  needsReply: boolean;
  needsReplySince: string | null;
  snoozedUntil: string | null;
  addedAt: string;
  followUpsStopped: boolean;
  openCount: number;
  campaignCount: number;
  updatedAt: string;
  tags: CrmTagRef[];
}

export interface CrmContactListParams {
  pipelineId?: number | undefined;
  stageId?: number | undefined;
  campaignId?: number | undefined;
  labels?: string[] | undefined;
  tagIds?: number[] | undefined;
  scoreTiers?: string[] | undefined;
  needsReply?: boolean | undefined;
  hotOnly?: boolean | undefined;
  search?: string | undefined;
  sort?: CrmContactSort | undefined;
  limit?: number | undefined;
  page?: number | undefined;
}

export interface CrmContactList {
  contacts: CrmContact[];
  total: number;
  limit: number;
  offset: number;
  page: number;
}

export interface CrmContactDetail {
  contact: CrmContact & {
    customFields: Record<string, string>;
    notes: string | null;
    pipelineName: string | null;
    stageEnteredAt: string | null;
    createdAt: string;
  };
  campaigns: Array<{
    id: number;
    name: string;
    recipientId: number;
    status: string;
    sentAt: string | null;
    openedAt: string | null;
    repliedAt: string | null;
  }>;
  replies: Array<{
    id: number;
    campaignId: number;
    subject: string | null;
    snippet: string;
    direction: string;
    label: string | null;
    labelSource: string | null;
    receivedAt: string;
    threadRootId: number;
  }>;
  history: Array<{
    id: number;
    fromStageId: number | null;
    fromName: string | null;
    toStageId: number | null;
    toName: string | null;
    reason: string | null;
    ruleId: number | null;
    ruleName: string | null;
    at: string;
  }>;
  score: {
    breakdown: unknown[];
    updatedAt: string | null;
    events: Array<{ id: number; points: number; reason: string; source: string; at: string }>;
  };
  timeline?: unknown;
}

/** GET /crm/contacts/lookup: light search by name or email (max 20). */
export interface CrmContactMatch {
  id: number;
  email: string;
  name: string | null;
  stageName: string | null;
}

// ── Needs reply (GET /crm/needs-reply) ───────────────────────────────────────

export interface CrmWaitingLead {
  contactId: number;
  email: string;
  name: string | null;
  company: string | null;
  score: number;
  scoreTier: string;
  stageName: string | null;
  stageColor: string | null;
  since: string;
  waitingHours: number;
  dueHours: number;
  overdue: boolean;
  priority: "high" | "normal";
  snoozedUntil: string | null;
  reminded: boolean;
  replyId: number | null;
  threadRootId: number | null;
  label: string | null;
  subject: string | null;
  snippet: string;
}

export interface CrmNeedsReplyList {
  leads: CrmWaitingLead[];
  counts: { waiting: number; overdue: number; snoozed: number };
}

// ── Pipelines, stages, tags ──────────────────────────────────────────────────

export interface CrmPipeline {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: string;
  stageCount: number;
  ruleCount: number;
  contactCount: number;
}

export interface CrmStage {
  id: number;
  pipelineId: number;
  name: string;
  color: string;
  position: number;
  /** "normal" | "won" | "lost" */
  type: string;
  manualOnly: boolean;
  stopFollowUps: boolean;
  contactCount: number;
}

export interface CrmTag {
  id: number;
  name: string;
  color: string;
  /** "both" | "contact" | "campaign" */
  scope: string;
  contactCount: number;
  campaignCount: number;
  createdAt: string;
}

// ── Tool results (what the MCP tools return to agent-service) ────────────────

/** Set when the user named a campaign that does not exist: nothing was searched. */
export interface UnknownCampaignInfo {
  unknownCampaign?: string;
  availableCampaigns?: string[];
}

export interface CrmSummaryResult extends CrmSummary, UnknownCampaignInfo {
  campaignName?: string;
}

export interface CrmContactListResult extends CrmContactList, UnknownCampaignInfo {
  /** Names the user asked for, as resolved to ids. */
  appliedFilters: { stageName?: string; tagNames?: string[]; campaignName?: string };
  /** Set when a stage name did not match any stage: nothing was searched. */
  unknownStage?: string;
  availableStages?: string[];
  /** Tag names that did not match any tag: nothing was searched. */
  unknownTags?: string[];
  availableTags?: string[];
}

export interface CrmContactLookupResult {
  /** Full detail when exactly one lead matched (or an id was given). */
  detail: CrmContactDetail | null;
  /** Every match of the search (more than one = the user must pick). */
  matches: CrmContactMatch[];
  query?: string;
}

export interface CrmPipelinesResult {
  pipelines: Array<CrmPipeline & { stages: CrmStage[] }>;
}

export interface CrmTagsResult {
  tags: CrmTag[];
}

// ── Phase 2: write actions ───────────────────────────────────────────────────

export interface CrmCampaignSettings {
  pipelineId: number | null;
  autoTagIds: number[];
}

/** prepare_crm_action: names → ids, checked before anything is changed. */
export interface CrmActionPreparation extends UnknownCampaignInfo {
  /** One lead (lead / leadId given). Undefined when 0 or several leads matched (see leadMatches). */
  lead?: { id: number; email: string; name: string | null; stageName: string | null; stageType: string | null; pipelineId: number | null };
  leadQuery?: string;
  leadMatches?: CrmContactMatch[];
  /** Bulk targets (targets given): every matching lead id, at most 1000. */
  targets?: { total: number; ids: number[]; sample: CrmContactMatch[]; truncated: boolean; appliedFilters: CrmContactListResult["appliedFilters"] };
  stage?: CrmStage;
  unknownStage?: string;
  availableStages?: string[];
  tags?: CrmTag[];
  unknownTags?: string[];
  availableTags?: string[];
  campaign?: { id: number; name: string | null; settings: CrmCampaignSettings };
  pipeline?: CrmPipeline;
  unknownPipeline?: string;
  availablePipelines?: string[];
  /** Latest inbound reply of the lead (needLatestReply). null = the lead has no reply. */
  latestReply?: { id: number; label: string | null; subject: string | null; snippet: string; receivedAt: string } | null;
}

/** Every write tool echoes the display names it was given, so the chat can say what happened. */
export interface CrmWriteResult {
  ok: boolean;
  lead?: string;
  [key: string]: unknown;
}
