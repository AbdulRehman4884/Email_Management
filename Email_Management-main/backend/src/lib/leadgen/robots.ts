/**
 * robots.txt (RFC 9309): parsed once per origin and cached for a day.
 *   - our group: the most specific User-agent line matching our token, else "*"
 *   - the longest matching rule wins; on a tie Allow wins; "*" and "$" are supported
 *   - 2xx: rules apply. 4xx (not 429): no robots file, everything allowed.
 *     5xx / 429 / network error: treated as "disallow everything" for now (short cache).
 */
import { CACHE_TTL_MS } from './config.js';
import type { FetchOptions, FetchResult } from './http.js';

/** The product token we match in User-agent lines. */
export const ROBOTS_AGENT = 'mailflowleadbot';

export interface RobotsRule {
  allow: boolean;
  path: string;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}
export type RobotsPolicy =
  | { mode: 'rules'; groups: RobotsGroup[] }
  | { mode: 'allow_all' }
  | { mode: 'disallow_all' };

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // "Disallow:" with no path allows everything: no rule needed.
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

function groupFor(groups: RobotsGroup[], agent: string): RobotsGroup[] {
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  if (own.length) return own;
  return groups.filter((g) => g.agents.includes('*'));
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/** `pathWithQuery` like "/team?x=1". */
export function isPathAllowed(policy: RobotsPolicy, pathWithQuery: string, agent = ROBOTS_AGENT): boolean {
  if (policy.mode === 'allow_all') return true;
  if (policy.mode === 'disallow_all') return false;
  if (pathWithQuery === '/robots.txt') return true;
  const rules = groupFor(policy.groups, agent).flatMap((g) => g.rules);
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    const len = r.path.replace(/\*|\$$/g, '').length;
    const bestLen = best ? best.path.replace(/\*|\$$/g, '').length : -1;
    if (len > bestLen || (len === bestLen && r.allow && !best!.allow)) best = r;
  }
  return best ? best.allow : true;
}

export interface RobotsDeps {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet(key: string, payload: unknown, ttlMs: number): Promise<void>;
}

const memory = new Map<string, { policy: RobotsPolicy; expires: number }>();
const SHORT_TTL_MS = 60 * 60_000;

/** The robots policy of an origin ("https://acme.com"), from memory, leadgen_cache or the site. */
export async function robotsPolicyFor(origin: string, deps: RobotsDeps): Promise<RobotsPolicy> {
  const hit = memory.get(origin);
  if (hit && hit.expires > Date.now()) return hit.policy;
  const key = `robots:${origin}`;
  const cached = await deps.cacheGet<RobotsPolicy>(key);
  if (cached) {
    memory.set(origin, { policy: cached, expires: Date.now() + SHORT_TTL_MS });
    return cached;
  }
  let policy: RobotsPolicy;
  let ttl: number = CACHE_TTL_MS.robots;
  try {
    const res = await deps.fetch(`${origin}/robots.txt`, { expect: 'any', maxBytes: 512 * 1024 });
    if (res.status >= 200 && res.status < 300) policy = { mode: 'rules', groups: parseRobots(res.body) };
    else if (res.status >= 400 && res.status < 500 && res.status !== 429) policy = { mode: 'allow_all' };
    else {
      policy = { mode: 'disallow_all' };
      ttl = SHORT_TTL_MS;
    }
  } catch {
    policy = { mode: 'disallow_all' };
    ttl = SHORT_TTL_MS;
  }
  await deps.cacheSet(key, policy, ttl);
  memory.set(origin, { policy, expires: Date.now() + Math.min(ttl, SHORT_TTL_MS) });
  return policy;
}

/** Tests only. */
export function clearRobotsMemory(): void {
  memory.clear();
}
