/**
 * Search engine providers and the search discovery source.
 *
 *   ddgProvider       DuckDuckGo HTML results (free; blocks at volume -> SourceBlockedError 'captcha')
 *   serpApiProvider   paid SERP API: SerpApi or DataForSEO (LEADGEN_SERP_PROVIDER / LEADGEN_SERP_API_KEY)
 *   searchSource()    discovery: "dental clinic in Lahore" -> one business per company website
 *
 * Results are cached for a day. The Day 2 LinkedIn finder reuses the same providers.
 */
import * as cheerio from 'cheerio';
import { CACHE_TTL_MS, serpConfig } from '../config.js';
import { getCategory } from '../categories.js';
import { SourceBlockedError, SourceUnavailableError } from '../errors.js';
import { isDirectoryDomain, normalizeDomain, normalizeWebsiteUrl } from '../normalize.js';
import { cacheKey } from '../leadStore.js';
import type { DiscoveredBusiness, LeadSource, SearchOptions, SearchProvider, SearchResult, SourceContext } from '../types.js';

// ── DuckDuckGo ───────────────────────────────────────────────────────────────

/** DDG region codes: "pk-en", "us-en"; the UK is "uk-en". */
function ddgRegion(countryCode: string | null | undefined): string {
  if (!countryCode) return 'wt-wt';
  const cc = countryCode.toLowerCase();
  return `${cc === 'gb' ? 'uk' : cc}-en`;
}

/** DDG wraps result links: //duckduckgo.com/l/?uddg=<encoded url>. */
function unwrapDdgLink(href: string): string | null {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/') return u.searchParams.get('uddg');
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function isDdgChallenge(status: number, html: string): boolean {
  return status === 202 || status === 403 || /anomaly-modal|challenge-form|anomaly\.js|Unfortunately, bots use DuckDuckGo too/i.test(html);
}

export function parseDdgHtml(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  $('div.result, div.web-result').each((_i, el) => {
    if (out.length >= limit) return false;
    const node = $(el);
    if (node.hasClass('result--ad') || node.find('.badge--ad').length) return;
    const a = node.find('a.result__a').first();
    const url = unwrapDdgLink(a.attr('href') ?? '');
    const title = a.text().trim();
    if (!url || !title) return;
    if (/duckduckgo\.com\/y\.js/.test(url)) return; // ad click link
    out.push({ title, url, snippet: node.find('.result__snippet').text().trim(), position: out.length + 1 });
    return;
  });
  return out;
}

export const ddgProvider: SearchProvider = {
  code: 'ddg',
  async search(query, opts, ctx) {
    const key = cacheKey('search', 'ddg', (opts.countryCode ?? '').toLowerCase(), query.toLowerCase());
    const cached = await ctx.cacheGet<SearchResult[]>(key);
    if (cached) return cached.slice(0, opts.limit);
    const res = await ctx.fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://html.duckduckgo.com/' },
      body: new URLSearchParams({ q: query, kl: ddgRegion(opts.countryCode), b: '' }).toString(),
      expect: 'html',
    });
    if (isDdgChallenge(res.status, res.body)) throw new SourceBlockedError('ddg', 'captcha');
    if (res.status !== 200) throw new Error(`DuckDuckGo answered ${res.status}`);
    const results = parseDdgHtml(res.body, 30);
    await ctx.cacheSet(key, results, CACHE_TTL_MS.search);
    return results.slice(0, opts.limit);
  },
};

// ── SERP API (SerpApi / DataForSEO) ──────────────────────────────────────────

export function parseSerpApi(json: unknown): SearchResult[] {
  const organic = (json as { organic_results?: Array<{ position?: number; title?: string; link?: string; snippet?: string }> })?.organic_results ?? [];
  return organic
    .filter((r) => r.title && r.link)
    .map((r, i) => ({ title: r.title!, url: r.link!, snippet: r.snippet ?? '', position: r.position ?? i + 1 }));
}

export function parseDataForSeo(json: unknown): SearchResult[] {
  const task = (json as { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: unknown[] }> }> })?.tasks?.[0];
  if (!task) return [];
  if (task.status_code !== 20000) throw new Error(`DataForSEO: ${task.status_message ?? task.status_code}`);
  const items = (task.result?.[0]?.items ?? []) as Array<{ type?: string; rank_absolute?: number; title?: string; url?: string; description?: string }>;
  return items
    .filter((r) => r.type === 'organic' && r.title && r.url)
    .map((r, i) => ({ title: r.title!, url: r.url!, snippet: r.description ?? '', position: r.rank_absolute ?? i + 1 }));
}

function countryName(cc: string): string | undefined {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc.toUpperCase());
  } catch {
    return undefined;
  }
}

export const serpApiProvider: SearchProvider = {
  code: 'serp_api',
  async search(query, opts, ctx) {
    const cfg = serpConfig();
    if (!cfg) throw new SourceUnavailableError('serp_api', 'not_configured');
    const key = cacheKey('search', cfg.provider, (opts.countryCode ?? '').toLowerCase(), query.toLowerCase());
    const cached = await ctx.cacheGet<SearchResult[]>(key);
    if (cached) return cached.slice(0, opts.limit);
    let results: SearchResult[];
    if (cfg.provider === 'serpapi') {
      const params = new URLSearchParams({ engine: 'google', q: query, num: '30', hl: 'en', api_key: cfg.apiKey });
      if (opts.countryCode) params.set('gl', opts.countryCode.toLowerCase());
      const res = await ctx.fetch(`https://serpapi.com/search.json?${params}`, { expect: 'json' });
      if (res.status !== 200) throw new Error(`SerpApi answered ${res.status}`);
      results = parseSerpApi(JSON.parse(res.body));
    } else {
      const task: Record<string, unknown> = { keyword: query, language_code: 'en', depth: 30 };
      const location = opts.countryCode ? countryName(opts.countryCode) : undefined;
      task.location_name = location ?? 'United States';
      const res = await ctx.fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(cfg.apiKey).toString('base64')}` },
        body: JSON.stringify([task]),
        expect: 'json',
        timeoutMs: 30_000,
      });
      if (res.status !== 200) throw new Error(`DataForSEO answered ${res.status}`);
      results = parseDataForSeo(JSON.parse(res.body));
    }
    await ctx.cacheSet(key, results, CACHE_TTL_MS.search);
    return results.slice(0, opts.limit);
  },
};

// ── Search discovery source ──────────────────────────────────────────────────

/** "Smile Dental Clinic | Best Dentist in Lahore" -> "Smile Dental Clinic". */
export function businessNameFromTitle(title: string): string {
  const first = title.split(/\s+[|–—:·•]\s+|\s+-\s+/)[0]!.trim();
  return (first || title).slice(0, 120);
}

/** "Top 10 dentists in Lahore", "Best clinics near you": lists, not businesses. */
function isListicle(title: string): boolean {
  return /^(the\s+)?(top|best)\s+\d+|^\d+\s+best\b|\bnear (me|you)\b/i.test(title);
}

export function searchResultsToBusinesses(
  results: SearchResult[],
  meta: { sourceCode: 'ddg' | 'serp_api'; category: string | null; city: string | null; region: string | null; countryCode: string | null }
): DiscoveredBusiness[] {
  const seen = new Set<string>();
  const out: DiscoveredBusiness[] = [];
  for (const r of results) {
    const websiteUrl = normalizeWebsiteUrl(r.url);
    const domain = normalizeDomain(websiteUrl);
    if (!websiteUrl || !domain || isDirectoryDomain(domain) || seen.has(domain) || isListicle(r.title)) continue;
    seen.add(domain);
    out.push({
      sourceCode: meta.sourceCode,
      externalId: `web:${domain}`,
      name: businessNameFromTitle(r.title),
      category: meta.category,
      websiteUrl: new URL(websiteUrl).origin + '/',
      domain,
      phone: null,
      email: null,
      address: null,
      city: meta.city,
      region: meta.region,
      countryCode: meta.countryCode,
      latitude: null,
      longitude: null,
      socials: [],
      sourceUrl: r.url,
      // Only the title and URL are known; the website crawl confirms the rest.
      confidence: 35,
    });
  }
  return out;
}

/** Search queries for a saved search: "dental clinic in Lahore", "dentist in Lahore" (+ extra keywords). */
export function buildDiscoveryQueries(q: { category: string | null; keywords: string[]; city: string | null; region: string | null }): string[] {
  const categoryWords = getCategory(q.category)?.searchKeywords ?? [];
  // Category + focus: the focus goes into the query ("ai automation software company in Lahore"), focus first.
  const words = categoryWords.length && q.keywords.length
    ? [...q.keywords.map((k) => `${k} ${categoryWords[0]}`), ...categoryWords]
    : [...categoryWords, ...q.keywords];
  const place = [q.city, q.region].filter(Boolean).join(' ');
  const unique = [...new Set(words.filter(Boolean).map((w) => w.trim().toLowerCase()))].slice(0, 3);
  return unique.map((w) => (place ? `${w} in ${place}` : w));
}

export function searchSource(provider: SearchProvider): LeadSource {
  return {
    code: provider.code,
    type: 'search',
    async discover(query, ctx: SourceContext) {
      const out: DiscoveredBusiness[] = [];
      const seen = new Set<string>();
      const opts: SearchOptions = { limit: 30, countryCode: query.countryCode };
      for (const q of buildDiscoveryQueries(query)) {
        if (out.length >= query.limit) break;
        const results = await provider.search(q, opts, ctx);
        for (const b of searchResultsToBusinesses(results, { sourceCode: provider.code, ...query })) {
          if (seen.has(b.externalId) || out.length >= query.limit) continue;
          seen.add(b.externalId);
          out.push(b);
        }
      }
      return out;
    },
  };
}
