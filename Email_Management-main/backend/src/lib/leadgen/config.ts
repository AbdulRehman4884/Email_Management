/**
 * Lead Engine settings from the environment. Read on every call (not at import time) so tests can change them.
 *
 *   LEADGEN_ENABLED         off | admin | on (default off). admin = only admin/super_admin users.
 *   LEADGEN_USER_AGENT      User-Agent for every outgoing request (must identify us; Nominatim policy).
 *   LEADGEN_CONTACT_EMAIL   Sent to Nominatim as `email` (their usage policy asks for it).
 *   LEADGEN_NOMINATIM_URL   default https://nominatim.openstreetmap.org
 *   LEADGEN_OVERPASS_URL    default https://overpass-api.de/api/interpreter
 *   LEADGEN_SERP_PROVIDER   serpapi | dataforseo (default serpapi)
 *   LEADGEN_SERP_API_KEY    serpapi: the api key. dataforseo: "login:password".
 */

export type LeadGenMode = 'off' | 'admin' | 'on';

export function leadGenMode(): LeadGenMode {
  const v = (process.env.LEADGEN_ENABLED ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return 'on';
  if (v === 'admin') return 'admin';
  return 'off';
}

export function userAgent(): string {
  return process.env.LEADGEN_USER_AGENT?.trim() || 'MailFlowLeadBot/1.0 (+https://email.deltaprimeaisolutions.com)';
}

export function contactEmail(): string | null {
  return process.env.LEADGEN_CONTACT_EMAIL?.trim() || null;
}

export function nominatimUrl(): string {
  return (process.env.LEADGEN_NOMINATIM_URL?.trim() || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
}

export function overpassUrl(): string {
  return process.env.LEADGEN_OVERPASS_URL?.trim() || 'https://overpass-api.de/api/interpreter';
}

export type SerpProvider = 'serpapi' | 'dataforseo';

export function serpConfig(): { provider: SerpProvider; apiKey: string } | null {
  const apiKey = process.env.LEADGEN_SERP_API_KEY?.trim();
  if (!apiKey) return null;
  const provider = process.env.LEADGEN_SERP_PROVIDER?.trim().toLowerCase() === 'dataforseo' ? 'dataforseo' : 'serpapi';
  return { provider, apiKey };
}

/** Fetch limits (use case UC-04 business rules). */
export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 1024 * 1024;
export const FETCH_MAX_REDIRECTS = 5;
/** One request per host every 2 seconds. */
export const HOST_INTERVAL_MS = 2_000;

/** Cache lifetimes (leadgen_cache.expires_at). */
export const CACHE_TTL_MS = {
  geocode: 30 * 86_400_000,
  overpass: 7 * 86_400_000,
  search: 86_400_000,
  robots: 86_400_000,
} as const;
