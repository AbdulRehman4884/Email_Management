/**
 * LinkedIn via search engine results only (use case section 2, method B; UC-05).
 * linkedin.com is NEVER requested: we only read the result URL and title the search engine shows.
 *   - company page: site:linkedin.com/company "Name" City  -> first result whose name matches strictly
 *   - people:       site:linkedin.com/in "Company" (owner OR CEO OR founder OR director)
 *                   "Ali Khan - CEO - Acme Dental | LinkedIn" -> name, title, company; company must match.
 * Several different people with the same name = ambiguous = nobody is saved (wrong person risk).
 */
import { normalizeCompanyName, normalizeLinkedinUrl, normalizePersonName } from './normalize.js';
import { looksLikeName } from './extract.js';
import type { SearchProvider, SearchResult, SourceContext } from './types.js';

/** Words that say nothing about which company it is. */
const GENERIC = new Set(['the', 'and', 'of', 'clinic', 'clinics', 'center', 'centre', 'group', 'services', 'solutions', 'company', 'co', 'pk', 'llc', 'ltd', 'inc', 'pvt', 'private', 'limited', 'international', 'global']);

function tokens(name: string): string[] {
  return normalizeCompanyName(name).split(/\s+/).filter((t) => t.length > 1 && !GENERIC.has(t));
}

/**
 * Strict company name match: the distinctive words of the shorter name all appear in the longer one,
 * and at least one distinctive word exists. "Smile Dental" ~ "Smile Dental Clinic Lahore"; "Smile" !~ "Bright Smile".
 */
export function companyNamesMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 1 && long.length > 2) return false;
  return short.every((t) => long.includes(t));
}

function stripSuffix(title: string): string {
  return title.replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
}

export interface LinkedinPersonHit {
  fullName: string;
  title: string | null;
  company: string | null;
}

/** "Ali Khan - CEO - Acme Dental | LinkedIn", "Ali Khan – Owner at Smile Dental – LinkedIn". */
export function parsePersonTitle(title: string): LinkedinPersonHit | null {
  const parts = stripSuffix(title).split(/\s+[-–—|]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const fullName = parts[0]!.replace(/\s*\(.*?\)\s*/g, ' ').replace(/,.*$/, '').trim();
  if (!looksLikeName(fullName)) return null;
  let jobTitle: string | null = parts.length >= 3 ? parts[1]! : parts.length === 2 ? parts[1]! : null;
  let company: string | null = parts.length >= 3 ? parts.slice(2).join(' - ') : null;
  const at = jobTitle?.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (at) {
    jobTitle = at[1]!;
    company = company ?? at[2]!;
  } else if (parts.length === 2) {
    // "Ali Khan - Acme Dental": the second part is the company, no title.
    company = jobTitle;
    jobTitle = null;
  }
  return { fullName, title: jobTitle?.slice(0, 255) ?? null, company: company?.slice(0, 255) ?? null };
}

/** "Acme Dental | LinkedIn" -> "Acme Dental". */
export function parseCompanyTitle(title: string): string {
  return stripSuffix(title).split(/\s+[-–—|:]\s+/)[0]!.trim();
}

export type Seniority = 'owner' | 'c_level' | 'director' | 'manager' | 'staff';

export function seniorityOf(title: string | null): Seniority | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(owner|founder|co-?founder|proprietor|malik)\b/.test(t)) return 'owner';
  if (/\b(ceo|cto|cfo|coo|cmo|cio|chief|president|managing director|md)\b/.test(t)) return 'c_level';
  if (/\b(director|vp|vice president|head|partner|principal)\b/.test(t)) return 'director';
  if (/\b(manager|lead|supervisor)\b/.test(t)) return 'manager';
  return 'staff';
}

export function departmentOf(title: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(sales|business development|bd|account)\b/.test(t)) return 'sales';
  if (/\b(marketing|brand|growth|seo|content)\b/.test(t)) return 'marketing';
  if (/\b(it|technology|engineering|developer|cto|software)\b/.test(t)) return 'it';
  if (/\b(finance|cfo|accounts?|accounting)\b/.test(t)) return 'finance';
  if (/\b(hr|human resources|people|talent|recruit)\b/.test(t)) return 'hr';
  if (/\b(operations|coo|ops)\b/.test(t)) return 'operations';
  if (/\b(doctor|dentist|surgeon|physician|medical|clinical)\b/.test(t)) return 'medical';
  return null;
}

export const DECISION_MAKER_TITLES = ['owner', 'CEO', 'founder', 'director'];

export async function findCompanyLinkedin(
  company: { name: string; city: string | null },
  provider: SearchProvider,
  ctx: SourceContext,
): Promise<{ url: string; snippet: string } | null> {
  const query = `site:linkedin.com/company "${company.name.replace(/"/g, '')}"${company.city ? ` ${company.city}` : ''}`;
  const results = await provider.search(query, { limit: 10 }, ctx);
  return pickCompanyResult(results, company.name);
}

export function pickCompanyResult(results: SearchResult[], companyName: string): { url: string; snippet: string } | null {
  for (const r of results) {
    const url = normalizeLinkedinUrl(r.url);
    if (!url || !url.includes('/company/')) continue;
    if (companyNamesMatch(parseCompanyTitle(r.title), companyName)) return { url, snippet: r.title.slice(0, 300) };
  }
  return null;
}

export interface FoundPerson {
  fullName: string;
  title: string | null;
  linkedinUrl: string;
  snippet: string;
}

export async function findPeople(
  company: { name: string; city: string | null },
  provider: SearchProvider,
  ctx: SourceContext,
  titles: string[] = DECISION_MAKER_TITLES,
): Promise<FoundPerson[]> {
  const query = `site:linkedin.com/in "${company.name.replace(/"/g, '')}" (${titles.map((t) => t.replace(/[()"]/g, '')).join(' OR ')})`;
  const results = await provider.search(query, { limit: 10 }, ctx);
  return pickPeople(results, company.name);
}

export function pickPeople(results: SearchResult[], companyName: string): FoundPerson[] {
  const found: FoundPerson[] = [];
  const urlsByName = new Map<string, Set<string>>();
  for (const r of results) {
    const url = normalizeLinkedinUrl(r.url);
    if (!url || !url.includes('/in/')) continue;
    const hit = parsePersonTitle(r.title);
    if (!hit || !hit.company || !companyNamesMatch(hit.company, companyName)) continue;
    const key = normalizePersonName(hit.fullName);
    const set = urlsByName.get(key) ?? new Set<string>();
    set.add(url);
    urlsByName.set(key, set);
    if (!found.some((f) => f.linkedinUrl === url)) found.push({ fullName: hit.fullName, title: hit.title, linkedinUrl: url, snippet: r.title.slice(0, 300) });
  }
  // Same name with different profiles: we cannot tell which one works there.
  return found.filter((f) => (urlsByName.get(normalizePersonName(f.fullName))?.size ?? 0) === 1).slice(0, 5);
}

/** A known person's profile seen again in search results: their current company (job change check). */
export async function currentCompanyOf(linkedinUrl: string, provider: SearchProvider, ctx: SourceContext): Promise<LinkedinPersonHit | null> {
  const slug = linkedinUrl.split('/in/')[1];
  if (!slug) return null;
  const results = await provider.search(`site:linkedin.com/in/${decodeURIComponent(slug)}`, { limit: 5 }, ctx);
  const hit = results.find((r) => normalizeLinkedinUrl(r.url) === linkedinUrl);
  return hit ? parsePersonTitle(hit.title) : null;
}
