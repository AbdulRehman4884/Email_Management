/**
 * OpenStreetMap discovery source.
 *   1. Nominatim: city (+ region, country) -> bounding box. Cached 30 days.
 *   2. Overpass: businesses with the category's tags inside the box. Cached 7 days.
 * Usage policies: identifying User-Agent, max 1 Nominatim request per second (sources.rate_per_min),
 * results cached. Data is ODbL: keep the OSM attribution wherever it is shown.
 */
import { CACHE_TTL_MS, contactEmail, nominatimUrl, overpassUrl } from '../config.js';
import { getCategory, type OsmTag } from '../categories.js';
import { isDirectoryDomain, normalizeDomain, normalizeEmail, normalizeWebsiteUrl } from '../normalize.js';
import { cacheKey } from '../leadStore.js';
import type { DiscoveredBusiness, DiscoveryQuery, LeadSource, SocialPlatform, SourceContext } from '../types.js';

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeocodeResult {
  bbox: BoundingBox;
  displayName: string;
  countryCode: string | null;
}

interface NominatimHit {
  boundingbox?: [string, string, string, string];
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: { country_code?: string };
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Overpass gets slow on huge areas: places larger than this are cut to a box around the place's own point
 * (Nominatim lat/lon = the city centre). The bbox centre can be far off: "Dubai" is the whole emirate and
 * its bbox centre is in the desert (found in the Day 3 real-data run).
 */
const MAX_BOX_DEGREES = 0.5;

export function parseNominatim(hits: unknown): GeocodeResult | null {
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const h = hits[0] as NominatimHit;
  if (!h.boundingbox || h.boundingbox.length !== 4) return null;
  const [s, n, w, e] = h.boundingbox.map(Number) as [number, number, number, number];
  if (![s, n, w, e].every(Number.isFinite)) return null;
  let bbox: BoundingBox = { south: s, north: n, west: w, east: e };
  if (n - s > MAX_BOX_DEGREES || e - w > MAX_BOX_DEGREES) {
    const pLat = Number(h.lat);
    const pLon = Number(h.lon);
    const lat = Number.isFinite(pLat) && pLat >= s && pLat <= n ? pLat : (s + n) / 2;
    const lon = Number.isFinite(pLon) && pLon >= w && pLon <= e ? pLon : (w + e) / 2;
    const half = MAX_BOX_DEGREES / 2;
    bbox = { south: lat - half, north: lat + half, west: lon - half, east: lon + half };
  }
  return { bbox, displayName: h.display_name ?? '', countryCode: h.address?.country_code?.toUpperCase() ?? null };
}

function escapeOverpass(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Overpass QL for the tags (category) or a name keyword (keyword-only search). */
export function buildOverpassQuery(bbox: BoundingBox, tags: OsmTag[], keywords: string[], limit: number): string {
  const box = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(5)).join(',');
  const parts = tags.length
    ? tags.map((t) => `  nwr["${escapeOverpass(t.key)}"="${escapeOverpass(t.value)}"]["name"](${box});`)
    : keywords.slice(0, 3).map((k) => `  nwr["name"~"${escapeOverpass(k.replace(/[.*+?^${}()|[\]]/g, ''))}",i](${box});`);
  return `[out:json][timeout:90];\n(\n${parts.join('\n')}\n);\nout center tags ${Math.max(1, Math.min(limit, 500))};`;
}

const SOCIAL_TAGS: Array<[string, SocialPlatform, string]> = [
  ['contact:facebook', 'facebook', 'https://www.facebook.com/'],
  ['facebook', 'facebook', 'https://www.facebook.com/'],
  ['contact:instagram', 'instagram', 'https://www.instagram.com/'],
  ['instagram', 'instagram', 'https://www.instagram.com/'],
  ['contact:linkedin', 'linkedin', 'https://www.linkedin.com/company/'],
  ['contact:twitter', 'x', 'https://x.com/'],
  ['contact:youtube', 'youtube', 'https://www.youtube.com/'],
];

const SOCIAL_DOMAINS: Record<string, SocialPlatform> = {
  'facebook.com': 'facebook', 'instagram.com': 'instagram', 'linkedin.com': 'linkedin', 'twitter.com': 'x', 'x.com': 'x', 'youtube.com': 'youtube',
};

function socialsOf(tags: Record<string, string>): DiscoveredBusiness['socials'] {
  const out: DiscoveredBusiness['socials'] = [];
  for (const [key, platform, base] of SOCIAL_TAGS) {
    const v = tags[key]?.trim();
    if (!v || out.some((s) => s.platform === platform)) continue;
    const url = /^https?:\/\//i.test(v) ? v : `${base}${v.replace(/^@/, '')}`;
    out.push({ platform, url });
  }
  return out;
}

function firstOf(tags: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const v = tags[k]?.split(';')[0]?.trim();
    if (v) return v;
  }
  return null;
}

/** Overpass elements -> businesses. Unnamed or closed places are dropped; the most complete come first. */
export function mapOverpassElements(
  elements: OverpassElement[],
  query: Pick<DiscoveryQuery, 'category' | 'city' | 'region' | 'countryCode' | 'limit'>
): DiscoveredBusiness[] {
  const seen = new Set<string>();
  const out: DiscoveredBusiness[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = firstOf(tags, ['name', 'name:en', 'brand']);
    if (!name) continue;
    if (tags['disused:shop'] || tags['disused:amenity'] || tags.opening_hours === 'closed' || tags['abandoned'] === 'yes') continue;
    const externalId = `osm:${el.type}/${el.id}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    let websiteUrl = normalizeWebsiteUrl(firstOf(tags, ['website', 'contact:website', 'url']));
    const socials = socialsOf(tags);
    // Many places put their Facebook/Instagram page in "website": keep it as a social link, not the company domain.
    const siteDomain = normalizeDomain(websiteUrl);
    if (websiteUrl && siteDomain && isDirectoryDomain(siteDomain)) {
      const platform = SOCIAL_DOMAINS[siteDomain.split('.').slice(-2).join('.')];
      if (platform && !socials.some((s) => s.platform === platform)) socials.push({ platform, url: websiteUrl });
      websiteUrl = null;
    }
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    const address = [street, tags['addr:suburb'] ?? tags['addr:neighbourhood']].filter(Boolean).join(', ') || tags['addr:full'] || null;
    out.push({
      sourceCode: 'osm',
      externalId,
      name,
      category: query.category,
      websiteUrl,
      domain: normalizeDomain(websiteUrl),
      phone: firstOf(tags, ['phone', 'contact:phone', 'contact:mobile', 'mobile']),
      email: normalizeEmail(firstOf(tags, ['email', 'contact:email'])),
      address,
      city: tags['addr:city'] ?? query.city,
      region: tags['addr:province'] ?? tags['addr:state'] ?? query.region,
      countryCode: (tags['addr:country'] ?? query.countryCode ?? null)?.toUpperCase().slice(0, 2) ?? null,
      latitude: lat,
      longitude: lon,
      socials,
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      confidence: 70,
    });
  }
  const completeness = (b: DiscoveredBusiness) => (b.websiteUrl ? 2 : 0) + (b.phone ? 1 : 0) + (b.email ? 1 : 0);
  return out
    .map((b, i) => ({ b, i }))
    .sort((x, y) => completeness(y.b) - completeness(x.b) || x.i - y.i)
    .slice(0, query.limit)
    .map((x) => x.b);
}

export async function geocodeCity(
  q: Pick<DiscoveryQuery, 'city' | 'region' | 'countryCode'>,
  ctx: SourceContext
): Promise<GeocodeResult | null> {
  if (!q.city) return null;
  const key = cacheKey('geocode', (q.countryCode ?? '').toLowerCase(), (q.region ?? '').toLowerCase(), q.city.toLowerCase());
  const cached = await ctx.cacheGet<GeocodeResult | { none: true }>(key);
  if (cached) return 'none' in cached ? null : cached;
  const params = new URLSearchParams({
    q: [q.city, q.region].filter(Boolean).join(', '),
    format: 'jsonv2',
    addressdetails: '1',
    limit: '1',
  });
  if (q.countryCode) params.set('countrycodes', q.countryCode.toLowerCase());
  const email = contactEmail();
  if (email) params.set('email', email);
  const res = await ctx.fetch(`${nominatimUrl()}/search?${params}`, { expect: 'json' });
  if (res.status !== 200) throw new Error(`Nominatim answered ${res.status}`);
  let result = parseNominatim(JSON.parse(res.body));
  // The city is not in the given country (e.g. "PA" = Panama typed for Pakistan): ask once more without the
  // country filter rather than finding nothing.
  if (!result && q.countryCode) {
    params.delete('countrycodes');
    const again = await ctx.fetch(`${nominatimUrl()}/search?${params}`, { expect: 'json' });
    if (again.status === 200) result = parseNominatim(JSON.parse(again.body));
  }
  await ctx.cacheSet(key, result ?? { none: true }, CACHE_TTL_MS.geocode);
  return result;
}

export const osmSource: LeadSource = {
  code: 'osm',
  type: 'directory',
  async discover(query, ctx) {
    const geo = await geocodeCity(query, ctx);
    if (!geo) return [];
    const category = getCategory(query.category);
    const tags = category?.osmTags ?? [];
    if (tags.length === 0 && query.keywords.length === 0) return [];
    // Ask for more than needed: unnamed places and duplicates are dropped afterwards.
    const ql = buildOverpassQuery(geo.bbox, tags, query.keywords, query.limit * 3);
    const key = cacheKey('overpass', query.category ?? `kw:${query.keywords.join(',').toLowerCase()}`,
      [geo.bbox.south, geo.bbox.west, geo.bbox.north, geo.bbox.east].map((v) => v.toFixed(2)).join(','), query.limit * 3);
    let elements = await ctx.cacheGet<OverpassElement[]>(key);
    if (!elements) {
      const res = await ctx.fetch(overpassUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: ql }).toString(),
        expect: 'json',
        timeoutMs: 100_000,
        maxBytes: 8 * 1024 * 1024,
      });
      if (res.status !== 200) throw new Error(`Overpass answered ${res.status}`);
      const json = JSON.parse(res.body) as { elements?: OverpassElement[]; remark?: string };
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`Overpass: ${json.remark.slice(0, 200)}`);
      elements = json.elements ?? [];
      await ctx.cacheSet(key, elements, CACHE_TTL_MS.overpass);
    }
    return mapOverpassElements(elements, { ...query, countryCode: query.countryCode ?? geo.countryCode });
  },
};
