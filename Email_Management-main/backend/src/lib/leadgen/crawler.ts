/**
 * Website crawler (use case UC-04).
 *   1. home page (robots.txt + per-host rate limit + SSRF guard via politeFetch)
 *   2. candidate pages from the home page links and sitemap.xml: contact, about, team, careers (max 8 pages in all)
 *   3. sha256 of every page; a page whose hash did not change since the last crawl is not extracted again
 *   4. facts of all changed pages merged into one SiteFacts
 * Non-HTML answers and pages over 1 MB are skipped; raw HTML is never kept.
 */
import { createHash } from 'node:crypto';
import { FetchError } from './errors.js';
import type { FetchOptions, FetchResult } from './http.js';
import { normalizeDomain } from './normalize.js';
import { extractPage, pageTypeOf, parseSitemap, type PageFacts, type PageType } from './extract.js';

export const MAX_PAGES = 8;
const WANTED: PageType[] = ['contact', 'about', 'team', 'careers'];
/** At most this many pages of one type (e.g. two contact pages: /contact and /locations). */
const PER_TYPE = 2;

export interface CrawledPage {
  url: string;
  pageType: PageType;
  httpStatus: number | null;
  contentHash: string | null;
  robotsAllowed: boolean;
  changed: boolean;
}

export interface SiteFacts {
  name: string | null;
  description: string | null;
  emails: Array<{ value: string; sourceUrl: string }>;
  phones: Array<{ value: string; sourceUrl: string }>;
  whatsapp: Array<{ value: string; sourceUrl: string }>;
  socials: Array<{ platform: PageFacts['socials'][number]['platform']; url: string; sourceUrl: string }>;
  address: PageFacts['address'];
  foundedYear: number | null;
  employeeCount: number | null;
  team: Array<PageFacts['team'][number] & { sourceUrl: string }>;
  techStack: string[];
  /** Title / headings / meta keywords of all pages read (max 80). */
  topics: string[];
  careersPage: string | null;
  openRoles: number;
}

export interface CrawlResult {
  status: 'ok' | 'down';
  /** Home page URL after redirects. */
  finalUrl: string | null;
  /** Domain after redirects, when it differs from the requested one. */
  redirectedDomain: string | null;
  pages: CrawledPage[];
  facts: SiteFacts;
  /** True when every page had the same hash as last time (nothing extracted). */
  unchanged: boolean;
  error: string | null;
}

export interface CrawlDeps {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
  /** url -> content hash of the last crawl (web_pages). */
  previousHashes?: Map<string, string>;
}

export function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function emptyFacts(): SiteFacts {
  return {
    name: null, description: null, emails: [], phones: [], whatsapp: [], socials: [], address: null,
    foundedYear: null, employeeCount: null, team: [], techStack: [], topics: [], careersPage: null, openRoles: 0,
  };
}

function merge(into: SiteFacts, page: PageFacts, url: string, type: PageType): void {
  into.name ??= page.name;
  if (page.description && (!into.description || type === 'about')) into.description = page.description;
  const addUnique = <T extends { value: string }>(list: T[], items: string[], make: (v: string) => T) => {
    for (const v of items) if (!list.some((x) => x.value === v)) list.push(make(v));
  };
  addUnique(into.emails, page.emails, (value) => ({ value, sourceUrl: url }));
  addUnique(into.phones, page.phones, (value) => ({ value, sourceUrl: url }));
  addUnique(into.whatsapp, page.whatsapp, (value) => ({ value, sourceUrl: url }));
  for (const s of page.socials) if (!into.socials.some((x) => x.url === s.url)) into.socials.push({ ...s, sourceUrl: url });
  into.address ??= page.address;
  into.foundedYear ??= page.foundedYear;
  into.employeeCount ??= page.employeeCount;
  for (const t of page.team) if (!into.team.some((x) => x.fullName.toLowerCase() === t.fullName.toLowerCase())) into.team.push({ ...t, sourceUrl: url });
  for (const t of page.techStack) if (!into.techStack.includes(t)) into.techStack.push(t);
  for (const t of page.topics) if (into.topics.length < 80 && !into.topics.includes(t)) into.topics.push(t);
  if (type === 'careers') {
    into.careersPage ??= url;
    into.openRoles = Math.max(into.openRoles, page.openRoles);
  } else {
    into.openRoles = Math.max(into.openRoles, page.openRoles);
  }
}

/** Picks up to MAX_PAGES - 1 extra pages, contact/about/team/careers first, at most PER_TYPE of each. */
export function choosePages(candidates: Array<{ url: string; type: PageType }>, homeUrl: string): Array<{ url: string; type: PageType }> {
  const out: Array<{ url: string; type: PageType }> = [];
  const seen = new Set([homeUrl.replace(/\/$/, '')]);
  for (const type of WANTED) {
    const ofType = candidates
      .filter((c) => c.type === type)
      // Short, top-level paths first: "/contact" before "/blog/how-to-contact-us".
      .sort((a, b) => new URL(a.url).pathname.split('/').length - new URL(b.url).pathname.split('/').length || a.url.length - b.url.length);
    let n = 0;
    for (const c of ofType) {
      const key = c.url.replace(/\/$/, '').split('?')[0]!;
      if (seen.has(key) || n >= PER_TYPE) continue;
      seen.add(key);
      out.push({ url: c.url, type });
      n++;
      if (out.length >= MAX_PAGES - 1) return out;
    }
  }
  return out;
}

async function fetchHtml(deps: CrawlDeps, url: string): Promise<{ res: FetchResult | null; error: FetchError | Error | null }> {
  try {
    const res = await deps.fetch(url, { expect: 'html' });
    return { res, error: null };
  } catch (err) {
    return { res: null, error: err as Error };
  }
}

export async function crawlSite(websiteUrl: string, deps: CrawlDeps): Promise<CrawlResult> {
  const facts = emptyFacts();
  const pages: CrawledPage[] = [];
  const prev = deps.previousHashes ?? new Map<string, string>();

  const home = await fetchHtml(deps, websiteUrl);
  if (!home.res || home.res.status >= 400) {
    const robots = home.error instanceof FetchError && home.error.code === 'robots_disallowed';
    pages.push({ url: websiteUrl, pageType: 'home', httpStatus: home.res?.status ?? null, contentHash: null, robotsAllowed: !robots, changed: false });
    return {
      status: 'down', finalUrl: null, redirectedDomain: null, pages, facts, unchanged: false,
      error: home.error?.message ?? `HTTP ${home.res?.status}`,
    };
  }
  const finalUrl = home.res.url;
  const requestedDomain = normalizeDomain(websiteUrl);
  const finalDomain = normalizeDomain(finalUrl);
  const homeHash = sha256(home.res.body);
  const homeChanged = prev.get(finalUrl) !== homeHash;
  const homeFacts = extractPage(home.res.body, finalUrl, 'home');
  pages.push({ url: finalUrl, pageType: 'home', httpStatus: home.res.status, contentHash: homeHash, robotsAllowed: true, changed: homeChanged });
  if (homeChanged) merge(facts, homeFacts, finalUrl, 'home');

  // Candidates: links on the home page, then sitemap.xml (a sitemap index: its first child sitemap).
  const candidates = [...homeFacts.links];
  const origin = new URL(finalUrl).origin;
  try {
    const sm = await deps.fetch(`${origin}/sitemap.xml`, { expect: 'any', maxBytes: 1024 * 1024 });
    if (sm.status === 200) {
      let parsed = parseSitemap(sm.body);
      if (parsed.isIndex && parsed.urls[0] && normalizeDomain(parsed.urls[0]) === finalDomain) {
        const child = await deps.fetch(parsed.urls[0], { expect: 'any', maxBytes: 1024 * 1024 });
        parsed = child.status === 200 ? parseSitemap(child.body) : { urls: [], isIndex: false };
      }
      for (const url of parsed.urls) {
        if (normalizeDomain(url) !== finalDomain) continue;
        const type = pageTypeOf(url);
        if (WANTED.includes(type) && !candidates.some((c) => c.url === url)) candidates.push({ url, type });
      }
    }
  } catch {
    // No sitemap: the home page links are enough.
  }

  for (const page of choosePages(candidates, finalUrl)) {
    const got = await fetchHtml(deps, page.url);
    if (!got.res) {
      const robots = got.error instanceof FetchError && got.error.code === 'robots_disallowed';
      pages.push({ url: page.url, pageType: page.type, httpStatus: null, contentHash: null, robotsAllowed: !robots, changed: false });
      continue;
    }
    if (got.res.status >= 400) {
      pages.push({ url: page.url, pageType: page.type, httpStatus: got.res.status, contentHash: null, robotsAllowed: true, changed: false });
      continue;
    }
    const hash = sha256(got.res.body);
    const changed = prev.get(page.url) !== hash;
    pages.push({ url: page.url, pageType: page.type, httpStatus: got.res.status, contentHash: hash, robotsAllowed: true, changed });
    if (changed) merge(facts, extractPage(got.res.body, got.res.url, page.type), got.res.url, page.type);
    if (page.type === 'careers') facts.careersPage ??= got.res.url;
  }

  return {
    status: 'ok',
    finalUrl,
    redirectedDomain: finalDomain && requestedDomain && finalDomain !== requestedDomain ? finalDomain : null,
    pages,
    facts,
    unchanged: pages.every((p) => !p.changed),
    error: null,
  };
}
