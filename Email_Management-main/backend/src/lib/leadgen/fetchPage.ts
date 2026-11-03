/**
 * Polite fetch for company websites: robots.txt first, then the per-host rate limit, then the guarded fetch.
 * APIs (Nominatim, Overpass, search) use safeFetch directly through their source context; they are not crawled.
 */
import { assertFetchableUrl, safeFetch, type FetchOptions, type FetchResult } from './http.js';
import { FetchError } from './errors.js';
import { scheduleForHost } from './rateLimiter.js';
import { isPathAllowed, robotsPolicyFor, type RobotsDeps } from './robots.js';
import { cacheGet, cacheSet } from './leadStore.js';

const defaultDeps: RobotsDeps = { fetch: safeFetch, cacheGet, cacheSet };

export async function politeFetch(url: string, opts: FetchOptions = {}, deps: RobotsDeps = defaultDeps): Promise<FetchResult> {
  const u = assertFetchableUrl(url);
  // Only a real robots.txt download takes a turn of the host's rate limit, not a cache hit.
  const policy = await robotsPolicyFor(u.origin, {
    ...deps,
    fetch: (robotsUrl, o) => scheduleForHost(u.hostname, () => deps.fetch(robotsUrl, o)),
  });
  if (!isPathAllowed(policy, u.pathname + u.search)) {
    throw new FetchError('Disallowed by robots.txt', 'robots_disallowed');
  }
  return scheduleForHost(u.hostname, () => deps.fetch(u.toString(), opts));
}
