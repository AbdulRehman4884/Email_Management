/**
 * Lead Engine contracts (frozen on Day 1). Every track builds on these:
 *   - collectors implement LeadSource / SearchProvider
 *   - the worker queues ScrapeTaskType tasks and calls the sources
 *   - the API returns the *Dto shapes; the MCP server mirrors them in its types/leadgen.ts
 */
import type { FetchResult, FetchOptions } from './http.js';

// ── Sources ──────────────────────────────────────────────────────────────────

/** sources.code values seeded by migration 0037. Providers (pdl ...) are added later. */
export type SourceCode = 'osm' | 'ddg' | 'serp_api' | 'website' | 'search_linkedin';
export type SourceType = 'directory' | 'search' | 'website' | 'provider' | 'manual';

/** One row of the sources table. */
export interface SourceRow {
  id: number;
  code: string;
  type: SourceType;
  isEnabled: boolean;
  ratePerMin: number | null;
  dailyCap: number | null;
  notes: string | null;
  cooldownUntil: string | null;
}

/** What a saved search asks a discovery source for. */
export interface DiscoveryQuery {
  /** Key of categories.ts, or null for keyword-only search. */
  category: string | null;
  keywords: string[];
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2, e.g. PK. */
  countryCode: string | null;
  /** Upper bound of businesses to return. */
  limit: number;
}

export type SocialPlatform = 'linkedin' | 'facebook' | 'instagram' | 'x' | 'youtube';

/** A business found by a discovery source, before dedupe/merge into companies. */
export interface DiscoveredBusiness {
  sourceCode: SourceCode;
  /** Stable id inside the source, e.g. "osm:node/123" or "web:acme.com". */
  externalId: string;
  name: string;
  category: string | null;
  websiteUrl: string | null;
  /** Normalized (lowercase, no www.). */
  domain: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  socials: Array<{ platform: SocialPlatform; url: string }>;
  /** Where the facts were seen (for observations.source_url). */
  sourceUrl: string | null;
  /** 0-100. */
  confidence: number;
}

/** One organic search engine result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

export interface SearchOptions {
  limit: number;
  countryCode?: string | null;
}

/** DuckDuckGo or a paid SERP API. Used by the search discovery source and (Day 2) the LinkedIn finder. */
export interface SearchProvider {
  readonly code: 'ddg' | 'serp_api';
  search(query: string, opts: SearchOptions, ctx: SourceContext): Promise<SearchResult[]>;
}

/** What a source may use. The worker builds it per source (rate limit, usage count, block detection, cache). */
export interface SourceContext {
  /** Guarded fetch (SSRF, timeout, size cap) through this source's rate limiter. Counts in source_daily_usage. */
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet(key: string, payload: unknown, ttlMs: number): Promise<void>;
}

/** A discovery source (OSM, search). Website crawler and LinkedIn finder get their own interfaces on Day 2. */
export interface LeadSource {
  readonly code: SourceCode;
  readonly type: SourceType;
  discover(query: DiscoveryQuery, ctx: SourceContext): Promise<DiscoveredBusiness[]>;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export type ScrapeTaskType = 'discover' | 'fetch_site' | 'find_social' | 'verify_email' | 'provider_enrich';
export type ScrapeTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type ScrapeRunStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
export type ScrapeRunType = 'search' | 'refresh' | 'manual';

export interface RunStats {
  discovered?: number;
  new_companies?: number;
  new_people?: number;
  new_leads?: number;
  updated?: number;
  failed?: number;
  blocked?: number;
}

// ── API contract (backend /api/lead-gen, Day 2). Mirrored in mailflow-mcp-server/src/types/leadgen.ts ──

export type LeadStatus = 'new' | 'reviewed' | 'saved_to_crm' | 'in_campaign' | 'rejected';
export type ScoreTier = 'hot' | 'warm' | 'cold';
export type ScheduleFrequency = 'daily' | 'weekly';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface SavedSearchDto {
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
  schedule: ScheduleDto | null;
}

export interface CreateSavedSearchBody {
  name?: string;
  category?: string | null;
  keywords?: string[];
  /** What the companies should do within the category ("AI automation, chatbots"); stored as keywords. */
  focus?: string;
  city: string;
  region?: string | null;
  countryCode?: string | null;
  includePeople?: boolean;
  /** 1-100, default 20. */
  targetPerRun?: number;
}

export interface ScheduleDto {
  id: number;
  savedSearchId: number;
  frequency: ScheduleFrequency;
  /** "09:00" */
  runAtLocal: string;
  timezone: string;
  weekdays: Weekday[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  isPaused: boolean;
  consecutiveFailures: number;
}

/** POST /lead-gen/searches/:id/schedule (creates or updates the one schedule of the search). */
export interface UpsertScheduleBody {
  frequency?: ScheduleFrequency;
  runAtLocal: string;
  timezone?: string;
  /** Weekly only; default every day. */
  weekdays?: Weekday[];
}

/** PATCH /lead-gen/schedules/:id */
export interface UpdateScheduleBody {
  isPaused?: boolean;
  frequency?: ScheduleFrequency;
  runAtLocal?: string;
  timezone?: string;
  weekdays?: Weekday[];
}

export interface RunDto {
  id: number;
  savedSearchId: number | null;
  scheduleId: number | null;
  runDate: string;
  runType: ScrapeRunType;
  status: ScrapeRunStatus;
  stats: RunStats;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface LeadListParams {
  savedSearchId?: number;
  /** Only leads found today (user timezone). */
  foundToday?: boolean;
  tiers?: ScoreTier[];
  statuses?: LeadStatus[];
  hasEmail?: boolean;
  hasDecisionMaker?: boolean;
  /** Only leads that match the search's focus. */
  matchesFocus?: boolean;
  limit?: number;
  page?: number;
}

export interface LeadDto {
  id: number;
  status: LeadStatus;
  fitScore: number;
  scoreTier: ScoreTier;
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
  /** The search's focus words this company matches ("AI automation"), or null. */
  focusMatch: string | null;
}

export interface LeadListDto {
  leads: LeadDto[];
  total: number;
  page: number;
  limit: number;
}

/** POST /lead-gen/leads/save-to-crm. Leads without an email are skipped (crm_contacts needs one). */
export interface SaveToCrmBody {
  leadIds: number[];
}
export interface SaveToCrmResult {
  saved: number;
  updated: number;
  skippedNoEmail: number;
  skippedSuppressed: number;
}

/** POST /lead-gen/leads/add-to-campaign. Draft or paused campaigns only; mx_valid emails only. */
export interface AddToCampaignBody {
  leadIds: number[];
  campaignId: number;
}
export interface AddToCampaignResult {
  campaignId: number;
  added: number;
  skippedNoEmail: number;
  skippedDuplicate: number;
  skippedSuppressed: number;
}
