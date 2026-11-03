/**
 * src/schemas/leadgen.schemas.ts
 *
 * Zod input schemas for the Lead Engine tools. All are .strict(): unknown keys are rejected.
 *
 * Rules:
 *  - userId is NEVER a schema field — the backend takes it from the bearer token
 *  - a saved search can be given by id or by NAME ("Lahore dentists"); the tool resolves names
 *  - campaigns by id or name, like the CRM tools
 */

import { z } from "zod";
import { LEAD_SCORE_TIERS, LEAD_STATUSES, SCHEDULE_FREQUENCIES, WEEKDAYS } from "../types/leadgen.js";

const positiveId = z.number().int().positive();
/** Search id ("12") or name ("Lahore dentists"). */
const searchRef = z.union([z.string().trim().min(1).max(120), positiveId]).transform(String);
const campaignRef = z.union([z.string().trim().min(1).max(255), positiveId]).transform(String);
/** "09:00" / "9:00" / "21:30". */
const localTime = z.string().trim().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM, e.g. 09:00");
/** IANA zone, e.g. Asia/Karachi. */
const timezone = z.string().trim().min(3).max(50).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/, "Use an IANA timezone, e.g. Asia/Karachi");
const weekdays = z.array(z.enum(WEEKDAYS)).min(1).max(7);
const leadIds = z.array(positiveId).min(1).max(500);

export const CreateSavedSearchSchema = z
  .object({
    /** Shown in lists; default "<Category> in <City>". */
    name: z.string().trim().min(1).max(120).optional(),
    /** Category key or words ("dentist", "dental clinics"); the backend maps words to a category. */
    category: z.string().trim().min(1).max(100).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    /** What the companies should do within the category ("AI automation, chatbots"): leads matching it rank first. */
    focus: z.string().trim().min(2).max(300).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(1).max(120).optional(),
    /** ISO alpha-2, e.g. "PK". */
    countryCode: z.string().trim().length(2).transform((s) => s.toUpperCase()).optional(),
    /** Decision makers (owners, CEOs) too. Default off. */
    includePeople: z.boolean().default(false),
    targetPerRun: z.number().int().min(1).max(100).default(20),
    /** Start a run right away (counts towards today's quota). */
    runNow: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.category !== undefined || (v.keywords?.length ?? 0) > 0, {
    message: "Give a category or at least one keyword",
  });

export const RunSavedSearchSchema = z.object({ search: searchRef }).strict();

/** The search part of create_saved_search, for "find X in Y daily at 9" (create + schedule in one approved step). */
const NewSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    keywords: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    focus: z.string().trim().min(2).max(300).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().min(1).max(120).optional(),
    countryCode: z.string().trim().length(2).transform((s) => s.toUpperCase()).optional(),
    includePeople: z.boolean().default(false),
    targetPerRun: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const CreateSearchScheduleSchema = z
  .object({
    /** An existing search (id or name) ... */
    search: searchRef.optional(),
    /** ... or a new one created first. */
    newSearch: NewSearchSchema.optional(),
    frequency: z.enum(SCHEDULE_FREQUENCIES).default("daily"),
    runAtLocal: localTime,
    /** Default: the user's browser timezone, else Asia/Karachi. */
    timezone: timezone.optional(),
    /** Weekly only. */
    weekdays: weekdays.optional(),
  })
  .strict()
  .refine((v) => v.frequency !== "weekly" || (v.weekdays?.length ?? 0) > 0, {
    message: "A weekly schedule needs weekdays",
  })
  .refine((v) => (v.search === undefined) !== (v.newSearch === undefined), {
    message: "Give search (an existing one) or newSearch, not both",
  });

export const ListSearchSchedulesSchema = z.object({}).strict();

export const UpdateSearchScheduleSchema = z
  .object({
    /** Search id or name; its one schedule is changed. */
    search: searchRef,
    isPaused: z.boolean().optional(),
    frequency: z.enum(SCHEDULE_FREQUENCIES).optional(),
    runAtLocal: localTime.optional(),
    timezone: timezone.optional(),
    weekdays: weekdays.optional(),
  })
  .strict()
  .refine((v) => v.isPaused !== undefined || v.frequency !== undefined || v.runAtLocal !== undefined || v.timezone !== undefined || v.weekdays !== undefined, {
    message: "Nothing to change",
  });

export const GetLeadRunSchema = z
  .object({
    /** Omit for the latest run (optionally of one search). */
    runId: positiveId.optional(),
    search: searchRef.optional(),
  })
  .strict();

const leadFilters = {
  search: searchRef.optional(),
  /** Only leads found today (user timezone). */
  foundToday: z.boolean().optional(),
  tiers: z.array(z.enum(LEAD_SCORE_TIERS)).min(1).max(3).optional(),
  statuses: z.array(z.enum(LEAD_STATUSES)).min(1).max(5).optional(),
  hasEmail: z.boolean().optional(),
  hasDecisionMaker: z.boolean().optional(),
};

export const ListWorkspaceLeadsSchema = z
  .object({ ...leadFilters, limit: z.number().int().min(1).max(50).default(10) })
  .strict();

export const SaveLeadsToCrmSchema = z
  .object({ leadIds: leadIds.optional(), ...leadFilters })
  .strict()
  .refine((v) => v.leadIds !== undefined || Object.values({ ...v, leadIds: undefined }).some((x) => x !== undefined), {
    message: "Give leadIds or a filter (search, foundToday, tiers ...)",
  });

export const AddLeadsToCampaignSchema = z
  .object({ campaign: campaignRef, leadIds: leadIds.optional(), ...leadFilters })
  .strict()
  .refine((v) => v.leadIds !== undefined || Object.entries(v).some(([k, x]) => k !== "campaign" && x !== undefined), {
    message: "Give leadIds or a filter (search, foundToday, tiers ...)",
  });

export type CreateSavedSearchInput = z.infer<typeof CreateSavedSearchSchema>;
export type LeadFilterInput = z.infer<typeof ListWorkspaceLeadsSchema>;
