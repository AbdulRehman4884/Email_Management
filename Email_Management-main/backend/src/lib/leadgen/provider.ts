/**
 * Licensed data provider (use case section 2, method C; UC-06). People Data Labs behind LEADGEN_PDL_API_KEY.
 * Used only for hot leads (credits), capped per day by sources.daily_cap (code 'pdl'), answers cached 90 days.
 * Off unless the key is set AND the 'pdl' source is enabled by an admin. Check the provider's terms (sources.notes).
 */
import { cacheKey } from './leadStore.js';
import { normalizeEmail, normalizeLinkedinUrl } from './normalize.js';
import type { SourceContext } from './types.js';

export const PROVIDER_CACHE_MS = 90 * 86_400_000;

export function pdlApiKey(): string | null {
  return process.env.LEADGEN_PDL_API_KEY?.trim() || null;
}

export interface ProviderCompany {
  employeeRange: string | null;
  foundedYear: number | null;
  linkedinUrl: string | null;
  industry: string | null;
}

export interface ProviderPerson {
  fullName: string;
  title: string | null;
  linkedinUrl: string | null;
  workEmail: string | null;
}

export interface ProviderResult {
  company: ProviderCompany | null;
  people: ProviderPerson[];
}

/** PDL size buckets ("11-50") are already our employee ranges. */
export function parsePdlCompany(json: unknown): ProviderCompany | null {
  const c = json as { status?: number; size?: string; founded?: number; linkedin_url?: string; industry?: string };
  if (!c || (c.status !== undefined && c.status !== 200)) return null;
  return {
    employeeRange: typeof c.size === 'string' ? c.size.replace(/\s/g, '').slice(0, 20) : null,
    foundedYear: typeof c.founded === 'number' && c.founded >= 1800 ? c.founded : null,
    linkedinUrl: c.linkedin_url ? normalizeLinkedinUrl(c.linkedin_url) : null,
    industry: typeof c.industry === 'string' ? c.industry.slice(0, 100) : null,
  };
}

export function parsePdlPeople(json: unknown): ProviderPerson[] {
  const data = (json as { data?: Array<Record<string, unknown>> })?.data ?? [];
  return data
    .map((p) => ({
      fullName: typeof p.full_name === 'string' ? p.full_name.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : '',
      title: typeof p.job_title === 'string' ? p.job_title.slice(0, 255) : null,
      linkedinUrl: typeof p.linkedin_url === 'string' ? normalizeLinkedinUrl(p.linkedin_url) : null,
      // Only an address the provider marks as a work email; never a personal one.
      workEmail: typeof p.work_email === 'string' ? normalizeEmail(p.work_email) : null,
    }))
    .filter((p) => p.fullName.length > 2)
    .slice(0, 5);
}

/** Company + up to 5 decision makers for a domain. Cached 90 days: one domain is never paid for twice. */
export async function enrichWithProvider(domain: string, ctx: SourceContext): Promise<ProviderResult | null> {
  const key = pdlApiKey();
  if (!key) return null;
  const ck = cacheKey('pdl', domain);
  const cached = await ctx.cacheGet<ProviderResult>(ck);
  if (cached) return cached;
  const headers = { 'x-api-key': key, accept: 'application/json' };
  const company = await ctx.fetch(`https://api.peopledatalabs.com/v5/company/enrich?website=${encodeURIComponent(domain)}`, { expect: 'json', headers });
  const people = await ctx.fetch('https://api.peopledatalabs.com/v5/person/search', {
    method: 'POST',
    expect: 'json',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      size: 5,
      query: { bool: { must: [{ term: { job_company_website: domain } }, { terms: { job_title_levels: ['owner', 'cxo', 'director', 'vp'] } }] } },
    }),
  });
  const result: ProviderResult = {
    company: company.status === 200 ? parsePdlCompany(JSON.parse(company.body)) : null,
    people: people.status === 200 ? parsePdlPeople(JSON.parse(people.body)) : [],
  };
  await ctx.cacheSet(ck, result, PROVIDER_CACHE_MS);
  return result;
}
