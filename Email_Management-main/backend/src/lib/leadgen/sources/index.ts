/**
 * Source registry + the SourceContext the worker hands to a source.
 * The context adds, around every request: availability check (enabled / cooldown / daily cap),
 * the source's rate limit, the source_daily_usage count, and 429/403 -> SourceBlockedError.
 */
import { serpConfig } from '../config.js';
import { SourceBlockedError, SourceUnavailableError } from '../errors.js';
import { safeFetch, type FetchOptions, type FetchResult } from '../http.js';
import { cacheGet, cacheSet, recordSourceRequests, sourceAvailability } from '../leadStore.js';
import { scheduleForSource } from '../rateLimiter.js';
import type { LeadSource, SearchProvider, SourceContext, SourceRow } from '../types.js';
import { osmSource } from './osm.js';
import { ddgProvider, searchSource, serpApiProvider } from './search.js';

export const SEARCH_PROVIDERS: Record<'ddg' | 'serp_api', SearchProvider> = {
  ddg: ddgProvider,
  serp_api: serpApiProvider,
};

/** Discovery sources by sources.code. */
export const DISCOVERY_SOURCES: Record<'osm' | 'ddg' | 'serp_api', LeadSource> = {
  osm: osmSource,
  ddg: searchSource(ddgProvider),
  serp_api: searchSource(serpApiProvider),
};

/** A paid SERP API needs its key; everything else only needs is_enabled. */
export function isSourceConfigured(code: string): boolean {
  return code !== 'serp_api' || serpConfig() !== null;
}

/**
 * Discovery sources for a run: OSM plus ONE search provider (SERP API when it is enabled and has a key,
 * else DuckDuckGo). Disabled sources are left out.
 */
export function pickDiscoverySources(sources: SourceRow[]): SourceRow[] {
  const usable = (code: string) => sources.find((s) => s.code === code && s.isEnabled && isSourceConfigured(code));
  return [usable('osm'), usable('serp_api') ?? usable('ddg')].filter((s): s is SourceRow => !!s);
}

function retryAfterMs(res: FetchResult): number | null {
  const v = res.headers['retry-after'];
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function createSourceContext(source: SourceRow, opts: { blockOnStatus?: boolean } = {}): SourceContext {
  const blockOnStatus = opts.blockOnStatus ?? true;
  return {
    async fetch(url: string, fetchOpts?: FetchOptions) {
      const avail = await sourceAvailability(source);
      if (!avail.ok) throw new SourceUnavailableError(source.code, avail.reason, avail.until ? new Date(avail.until) : null);
      return scheduleForSource(source.code, source.ratePerMin, async () => {
        await recordSourceRequests(source.id);
        const res = await safeFetch(url, fetchOpts);
        if (blockOnStatus && (res.status === 429 || res.status === 403)) {
          throw new SourceBlockedError(source.code, res.status === 429 ? '429' : '403', retryAfterMs(res));
        }
        return res;
      });
    },
    cacheGet: (key) => cacheGet(key),
    cacheSet: (key, payload, ttlMs) => cacheSet(key, payload, ttlMs),
  };
}
