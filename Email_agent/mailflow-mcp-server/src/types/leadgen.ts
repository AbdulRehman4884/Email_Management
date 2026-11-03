/**
 * src/types/leadgen.ts
 *
 * Lead Engine API shapes. Mirror of the contract in
 * Email_Management-main/backend/src/lib/leadgen/types.ts (frozen on Day 1) — keep both in sync.
 * The backend mounts these under /api/lead-gen (LEADGEN_ENABLED switch + lead_gen_enabled plan flag).
 */

export const LEAD_STATUSES = ["new", "reviewed", "saved_to_crm", "in_campaign", "rejected"] as const;
export const LEAD_SCORE_TIERS = ["hot", "warm", "cold"] as const;
export const SCHEDULE_FREQUENCIES = ["daily", "weekly"] as const;
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadScoreTier = (typeof LEAD_SCORE_TIERS)[number];
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
export type Weekday = (typeof WEEKDAYS)[number];
export type LeadRunStatus = "queued" | "running" | "done" | "partial" | "failed" | "cancelled";

export interface LeadSchedule {
  id: number;
  savedSearchId: number;
  frequency: ScheduleFrequency;
  runAtLocal: string;
  timezone: string;
  weekdays: Weekday[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  isPaused: boolean;
  consecutiveFailures: number;
}

export interface SavedLeadSearch {
  id: number;
  name: string;
  category: string | null;
  keywords: string[];
  city: string | null;
  region: string | null;
  countryCode: string | null;
  includePeople: boolean;
  targetPerRun: number;
  isActive: boolean;
  createdAt: string;
  schedule: LeadSchedule | null;
}

export interface CreateSavedSearchBody {
  name?: string | undefined;
  category?: string | null | undefined;
  keywords?: string[] | undefined;
  focus?: string | undefined;
  city: string;
  region?: string | null | undefined;
  countryCode?: string | null | undefined;
  includePeople?: boolean | undefined;
  targetPerRun?: number | undefined;
}

export interface UpsertScheduleBody {
  frequency?: ScheduleFrequency | undefined;
  runAtLocal: string;
  timezone?: string | undefined;
  weekdays?: Weekday[] | undefined;
}

export interface UpdateScheduleBody {
  isPaused?: boolean | undefined;
  frequency?: ScheduleFrequency | undefined;
  runAtLocal?: string | undefined;
  timezone?: string | undefined;
  weekdays?: Weekday[] | undefined;
}

export interface LeadRunStats {
  discovered?: number;
  new_companies?: number;
  new_people?: number;
  new_leads?: number;
  updated?: number;
  failed?: number;
}

export interface LeadRun {
  id: number;
  savedSearchId: number | null;
  scheduleId: number | null;
  runDate: string;
  runType: "search" | "refresh" | "manual";
  status: LeadRunStatus;
  stats: LeadRunStats;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface LeadListParams {
  savedSearchId?: number | undefined;
  foundToday?: boolean | undefined;
  tiers?: LeadScoreTier[] | undefined;
  statuses?: LeadStatus[] | undefined;
  hasEmail?: boolean | undefined;
  hasDecisionMaker?: boolean | undefined;
  limit?: number | undefined;
  page?: number | undefined;
}

export interface WorkspaceLead {
  id: number;
  status: LeadStatus;
  fitScore: number;
  scoreTier: LeadScoreTier;
  foundAt: string;
  savedSearchId: number | null;
  company: {
    id: number;
    name: string;
    domain: string | null;
    websiteUrl: string | null;
    category: string | null;
    city: string | null;
    countryCode: string | null;
    phone: string | null;
    email: string | null;
    linkedinUrl: string | null;
  };
  person: { id: number; fullName: string; title: string | null; linkedinUrl: string | null; email: string | null } | null;
  crmContactId: number | null;
  focusMatch?: string | null;
}

export interface WorkspaceLeadList {
  leads: WorkspaceLead[];
  total: number;
  page: number;
  limit: number;
}

export interface SaveLeadsToCrmResult {
  saved: number;
  updated: number;
  skippedNoEmail: number;
  skippedSuppressed: number;
}

export interface AddLeadsToCampaignResult {
  campaignId: number;
  added: number;
  skippedNoEmail: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
}

// ── Tool results ─────────────────────────────────────────────────────────────

/** Returned when a saved search given by name does not match exactly one search. */
export interface UnknownSearchProblem {
  unknownSearch: string;
  availableSearches: string[];
}

export interface CreateSavedSearchResult {
  search: SavedLeadSearch;
  /** Set when runNow was true. */
  run: LeadRun | null;
}

export type RunSavedSearchResult = { search: SavedLeadSearch | null; run: LeadRun | null } & Partial<UnknownSearchProblem>;
export type CreateSearchScheduleResult = { search: SavedLeadSearch | null; schedule: LeadSchedule | null } & Partial<UnknownSearchProblem>;
export type UpdateSearchScheduleResult = { schedule: LeadSchedule | null; searchName: string | null } & Partial<UnknownSearchProblem>;
export interface ListSearchSchedulesResult {
  searches: SavedLeadSearch[];
}
export type GetLeadRunResult = { run: LeadRun | null; searchName: string | null };
export type ListWorkspaceLeadsResult = WorkspaceLeadList & { searchName: string | null } & Partial<UnknownSearchProblem>;
export type SaveLeadsToCrmToolResult = SaveLeadsToCrmResult & { leadCount: number };
export type AddLeadsToCampaignToolResult =
  | (AddLeadsToCampaignResult & { leadCount: number; campaignName: string | null })
  | { campaignId: null; unknownCampaign: string; availableCampaigns: string[]; leadCount: number };
