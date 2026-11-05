/**
 * Run: npm run test:leadgen   (node:test through tsx, offline: no database, no network)
 * Lead Engine Day 1, collectors: SSRF guard, robots.txt, normalization, categories, OSM + search parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertFetchableUrl, guardedLookup, isBlockedAddress, safeFetch } from '../leadgen/http.js';
import { FetchError, SourceBlockedError } from '../leadgen/errors.js';
import { isPathAllowed, parseRobots, robotsPolicyFor, clearRobotsMemory, type RobotsPolicy } from '../leadgen/robots.js';
import {
  hashIdentifier, normalizeCompanyName, normalizeDomain, normalizeEmail, normalizeLinkedinUrl, normalizePersonName, normalizeWebsiteUrl,
} from '../leadgen/normalize.js';
import { getCategory, resolveCategory } from '../leadgen/categories.js';
import { buildOverpassQuery, mapOverpassElements, osmSource, parseNominatim, type OverpassElement } from '../leadgen/sources/osm.js';
import {
  buildDiscoveryQueries, businessNameFromTitle, ddgProvider, isDdgChallenge, parseDataForSeo, parseDdgHtml, parseSerpApi,
  searchResultsToBusinesses, searchSource,
} from '../leadgen/sources/search.js';
import { pickDiscoverySources } from '../leadgen/sources/index.js';
import type { SourceContext, SourceRow } from '../leadgen/types.js';
import type { FetchResult } from '../leadgen/http.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOMINATIM_LAHORE = [{
  place_id: 1, display_name: 'Lahore, Punjab, Pakistan', lat: '31.5656', lon: '74.3142',
  boundingbox: ['31.3500', '31.7000', '74.1000', '74.5200'], address: { city: 'Lahore', country_code: 'pk' },
}];

const OVERPASS_DENTISTS: { elements: OverpassElement[] } = {
  elements: [
    { type: 'node', id: 1, lat: 31.52, lon: 74.35, tags: { amenity: 'dentist', name: 'Smile Dental Clinic', phone: '+92 42 1234567', website: 'www.smiledental.pk', 'addr:street': 'MM Alam Road', 'addr:city': 'Lahore', 'contact:facebook': 'smiledentalpk' } },
    { type: 'way', id: 2, center: { lat: 31.5, lon: 74.3 }, tags: { amenity: 'dentist', name: 'City Dentists', email: 'Info@CityDentists.com' } },
    { type: 'node', id: 3, lat: 31.4, lon: 74.2, tags: { amenity: 'dentist' } }, // no name: dropped
    { type: 'node', id: 4, lat: 31.4, lon: 74.2, tags: { amenity: 'dentist', name: 'Old Clinic', 'disused:amenity': 'dentist' } }, // closed: dropped
    { type: 'node', id: 5, lat: 31.45, lon: 74.25, tags: { healthcare: 'dentist', name: 'Bare Bones Dental' } },
  ],
};

const DDG_HTML = `<html><body>
<div class="result results_links results_links_deep web-result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad: Cheap Dentist</a></div>
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.smiledental.pk%2F&amp;rut=abc">Smile Dental Clinic | Best Dentist in Lahore</a></h2>
  <a class="result__snippet" href="#">Teeth whitening, implants and braces in Gulberg.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.marham.pk%2Fdoctors%2Flahore%2Fdentist">Best Dentists in Lahore - Marham</a></h2>
  <a class="result__snippet">Book appointment</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a class="result__a" href="https://lahoredentalcare.com/contact">Lahore Dental Care - Contact Us</a></h2>
  <a class="result__snippet">Call us today.</a>
</div>
<div class="result results_links web-result">
  <h2 class="result__title"><a class="result__a" href="https://blog.example.org/top-10">Top 10 Dentists in Lahore (2026)</a></h2>
</div>
</body></html>`;

const DDG_CAPTCHA = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>`;

const SERPAPI_JSON = {
  organic_results: [
    { position: 1, title: 'Smile Dental Clinic - Lahore', link: 'https://smiledental.pk/', snippet: 'Dentist in Gulberg' },
    { position: 2, title: 'Dentists in Lahore | Facebook', link: 'https://www.facebook.com/somepage', snippet: '' },
  ],
};

const DATAFORSEO_JSON = {
  tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ items: [
    { type: 'organic', rank_absolute: 1, title: 'Acme Dental', url: 'https://acmedental.com/', description: 'Acme' },
    { type: 'paid', rank_absolute: 2, title: 'Ad', url: 'https://ads.example.com/' },
  ] }] }],
};

/** SourceContext answering from a URL -> response map, with an in-memory cache. */
function fakeContext(routes: Array<[RegExp, Partial<FetchResult>]>): SourceContext & { calls: string[] } {
  const cache = new Map<string, unknown>();
  const calls: string[] = [];
  return {
    calls,
    async fetch(url) {
      calls.push(url);
      const hit = routes.find(([re]) => re.test(url));
      if (!hit) throw new Error(`no fixture for ${url}`);
      return { url, status: 200, headers: {}, body: '', redirects: [], ...hit[1] };
    },
    async cacheGet<T>(key: string) { return (cache.get(key) as T) ?? null; },
    async cacheSet(key, payload) { cache.set(key, payload); },
  };
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

test('private, loopback, link-local, metadata and reserved addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '::ffff:7f00:1', 'ff02::1', '64:ff9b::a00:1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '104.16.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('URL checks: protocol, credentials, port, local names, literal private IPs', () => {
  const bad = (url: string, code: string) => assert.throws(() => assertFetchableUrl(url), (e: unknown) => e instanceof FetchError && e.code === code, url);
  bad('ftp://example.com/', 'bad_url');
  bad('file:///etc/passwd', 'bad_url');
  bad('https://user:pw@example.com/', 'bad_url');
  bad('https://example.com:22/', 'bad_url');
  bad('not a url', 'bad_url');
  bad('http://localhost/', 'blocked_address');
  bad('http://printer.local/', 'blocked_address');
  bad('http://127.0.0.1/', 'blocked_address');
  bad('http://[::1]/', 'blocked_address');
  bad('http://169.254.169.254/latest/meta-data/', 'blocked_address');
  assert.equal(assertFetchableUrl('https://example.com:8443/a').hostname, 'example.com');
});

test('the DNS lookup refuses hostnames that resolve to a private address', async () => {
  const err = await new Promise<Error | null>((resolve) => guardedLookup('localhost', { all: true }, (e) => resolve(e)));
  assert.ok(err instanceof FetchError);
  assert.equal((err as FetchError).code, 'blocked_address');
});

test('safeFetch never reaches a server on localhost (by IP or by name)', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('secret'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), (e: unknown) => e instanceof FetchError);
    await assert.rejects(safeFetch(`http://localhost:${port}/`), (e: unknown) => e instanceof FetchError);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

// ── robots.txt ───────────────────────────────────────────────────────────────

const ROBOTS = `
# comment
User-agent: *
Disallow: /private/
Disallow: /*.pdf$
Allow: /private/press/

User-agent: BadBot
User-agent: MailFlowLeadBot
Disallow: /team
`;

test('robots: our own group wins over *, longest rule wins, wildcards and $ work', () => {
  const policy: RobotsPolicy = { mode: 'rules', groups: parseRobots(ROBOTS) };
  assert.equal(isPathAllowed(policy, '/team'), false);
  assert.equal(isPathAllowed(policy, '/private/x'), true, 'our group has no /private rule');
  const star: RobotsPolicy = { mode: 'rules', groups: parseRobots(ROBOTS) };
  assert.equal(isPathAllowed(star, '/private/x', 'otherbot'), false);
  assert.equal(isPathAllowed(star, '/private/press/1', 'otherbot'), true);
  assert.equal(isPathAllowed(star, '/files/a.pdf', 'otherbot'), false);
  assert.equal(isPathAllowed(star, '/files/a.pdf?x', 'otherbot'), true);
  assert.equal(isPathAllowed(star, '/about', 'otherbot'), true);
  assert.equal(isPathAllowed({ mode: 'rules', groups: parseRobots('User-agent: *\nDisallow:\n') }, '/anything'), true);
});

test('robots: 404 allows all, 5xx and network errors disallow all, result is cached', async () => {
  clearRobotsMemory();
  const cache = new Map<string, unknown>();
  let fetches = 0;
  const deps = (status: number | 'error') => ({
    async fetch(url: string) {
      fetches++;
      if (status === 'error') throw new Error('down');
      return { url, status, headers: {}, body: '', redirects: [] };
    },
    async cacheGet<T>(k: string) { return (cache.get(k) as T) ?? null; },
    async cacheSet(k: string, v: unknown) { cache.set(k, v); },
  });
  assert.deepEqual(await robotsPolicyFor('https://a.example', deps(404)), { mode: 'allow_all' });
  assert.deepEqual(await robotsPolicyFor('https://a.example', deps(404)), { mode: 'allow_all' });
  assert.equal(fetches, 1, 'second call is served from cache');
  assert.deepEqual(await robotsPolicyFor('https://b.example', deps(503)), { mode: 'disallow_all' });
  assert.deepEqual(await robotsPolicyFor('https://c.example', deps('error')), { mode: 'disallow_all' });
});

// ── Normalization ────────────────────────────────────────────────────────────

test('domains: lowercase, no www, no path; IPs and local names rejected', () => {
  assert.equal(normalizeDomain('https://WWW.Acme.com.pk/about?x=1'), 'acme.com.pk');
  assert.equal(normalizeDomain('acme.com'), 'acme.com');
  assert.equal(normalizeDomain('www2.acme.com'), 'acme.com');
  assert.equal(normalizeDomain('http://192.168.1.1/'), null);
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeWebsiteUrl('acme.com/#top'), 'https://acme.com/');
  assert.equal(normalizeWebsiteUrl('javascript:alert(1)'), null);
});

test('emails and LinkedIn URLs', () => {
  assert.equal(normalizeEmail(' mailto:Info@Acme.COM?subject=hi '), 'info@acme.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeLinkedinUrl('http://pk.linkedin.com/company/Acme-Dental/about/?trk=x'), 'https://www.linkedin.com/company/acme-dental');
  assert.equal(normalizeLinkedinUrl('linkedin.com/in/Ali-Khan-123/'), 'https://www.linkedin.com/in/ali-khan-123');
  assert.equal(normalizeLinkedinUrl('https://www.linkedin.com/posts/abc'), null);
  assert.equal(normalizeLinkedinUrl('https://evil.com/linkedin.com/in/x'), null);
});

test('company and person names', () => {
  assert.equal(normalizeCompanyName('Acme Dental (Pvt.) Ltd.'), 'acme dental');
  assert.equal(normalizeCompanyName('ACME Dental Private Limited'), 'acme dental');
  assert.equal(normalizeCompanyName('Smile & Co'), 'smile and');
  assert.equal(normalizeCompanyName('Café Ideas LLC'), 'cafe ideas');
  assert.equal(normalizeCompanyName('Limited'), 'limited', 'never empties a name');
  assert.equal(normalizePersonName('Dr. Ali  Khan'), 'ali khan');
});

test('identifier hashes are stable across spellings and differ by type', () => {
  assert.equal(hashIdentifier('email', 'Ali@Acme.com'), hashIdentifier('email', ' ali@acme.com '));
  assert.equal(hashIdentifier('email', 'bad'), null);
  assert.match(hashIdentifier('domain', 'acme.com')!, /^[0-9a-f]{64}$/);
  assert.notEqual(hashIdentifier('domain', 'acme.com'), hashIdentifier('email', 'x@acme.com'));
});

// ── Categories ───────────────────────────────────────────────────────────────

test('categories from free text (English + Roman Urdu), longest alias wins', () => {
  assert.equal(resolveCategory('Lahore ke dental clinics dhundo')?.key, 'dentist');
  assert.equal(resolveCategory('find software houses in Karachi')?.key, 'it_company');
  assert.equal(resolveCategory('real estate agents in Dubai')?.key, 'real_estate');
  assert.equal(resolveCategory('skin clinic')?.key, 'doctor');
  assert.equal(resolveCategory('dentist')?.key, 'dentist');
  assert.equal(resolveCategory('quantum widget makers'), null);
  assert.ok(getCategory('dentist')!.osmTags.some((t) => t.key === 'amenity' && t.value === 'dentist'));
});

// ── OSM ──────────────────────────────────────────────────────────────────────

test('Nominatim: bounding box and country; huge areas are cut around the centre', () => {
  const g = parseNominatim(NOMINATIM_LAHORE)!;
  assert.deepEqual(g.bbox, { south: 31.35, north: 31.7, west: 74.1, east: 74.52 });
  assert.equal(g.countryCode, 'PK');
  const big = parseNominatim([{ boundingbox: ['20', '30', '60', '70'] }])!;
  assert.ok(big.bbox.north - big.bbox.south <= 0.5001);
  // Dubai: the emirate's bbox centre is in the desert; the cut box goes around the city point instead.
  const dubai = parseNominatim([{ boundingbox: ['22.6', '25.4', '54.9', '56.4'], lat: '25.0742', lon: '55.1885' }])!;
  assert.ok(Math.abs((dubai.bbox.north + dubai.bbox.south) / 2 - 25.0742) < 1e-6);
  assert.ok(Math.abs((dubai.bbox.east + dubai.bbox.west) / 2 - 55.1885) < 1e-6);
  assert.equal(parseNominatim([]), null);
});

test('Overpass query uses the category tags and escapes keywords', () => {
  const q = buildOverpassQuery({ south: 1, west: 2, north: 3, east: 4 }, getCategory('dentist')!.osmTags, [], 60);
  assert.match(q, /nwr\["amenity"="dentist"\]\["name"\]\(1\.00000,2\.00000,3\.00000,4\.00000\);/);
  assert.match(q, /out center tags 60;/);
  assert.match(q, /\[timeout:90\]/);
  const kw = buildOverpassQuery({ south: 1, west: 2, north: 3, east: 4 }, [], ['solar "panels"'], 10);
  assert.match(kw, /nwr\["name"~"solar \\"panels\\"",i\]/);
});

test('Overpass elements become businesses: unnamed/closed dropped, most complete first', () => {
  const b = mapOverpassElements(OVERPASS_DENTISTS.elements, { category: 'dentist', city: 'Lahore', region: null, countryCode: 'PK', limit: 10 });
  assert.deepEqual(b.map((x) => x.name), ['Smile Dental Clinic', 'City Dentists', 'Bare Bones Dental']);
  const smile = b[0]!;
  assert.equal(smile.domain, 'smiledental.pk');
  assert.equal(smile.websiteUrl, 'https://www.smiledental.pk/');
  assert.equal(smile.phone, '+92 42 1234567');
  assert.equal(smile.address, 'MM Alam Road');
  assert.deepEqual(smile.socials, [{ platform: 'facebook', url: 'https://www.facebook.com/smiledentalpk' }]);
  assert.equal(smile.externalId, 'osm:node/1');
  assert.equal(smile.sourceUrl, 'https://www.openstreetmap.org/node/1');
  assert.equal(b[1]!.email, 'info@citydentists.com');
  assert.equal(b[1]!.latitude, 31.5);
  assert.equal(mapOverpassElements(OVERPASS_DENTISTS.elements, { category: 'dentist', city: 'Lahore', region: null, countryCode: 'PK', limit: 1 }).length, 1);
});

test('osmSource.discover: geocode + Overpass from fixtures, both cached', async () => {
  const ctx = fakeContext([
    [/nominatim.*\/search\?/, { body: JSON.stringify(NOMINATIM_LAHORE) }],
    [/overpass/, { body: JSON.stringify(OVERPASS_DENTISTS) }],
  ]);
  const query = { category: 'dentist', keywords: [], city: 'Lahore', region: null, countryCode: 'PK', limit: 20 };
  const found = await osmSource.discover(query, ctx);
  assert.equal(found.length, 3);
  assert.equal(found[0]!.city, 'Lahore');
  await osmSource.discover(query, ctx);
  assert.equal(ctx.calls.length, 2, 'second run uses the cache');
  assert.match(ctx.calls[0]!, /countrycodes=pk/);
});

test('geocode: a city not found in the given country is looked up once more without the country', async () => {
  let calls = 0;
  const ctx = fakeContext([[/nominatim/, { body: '[]' }]]);
  const original = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    calls++;
    if (!/countrycodes=/.test(url)) return { url, status: 200, headers: {}, body: JSON.stringify(NOMINATIM_LAHORE), redirects: [] };
    return original(url, opts);
  };
  const { geocodeCity } = await import('../leadgen/sources/osm.js');
  const g = await geocodeCity({ city: 'Lahore', region: null, countryCode: 'PA' }, ctx);
  assert.equal(g?.countryCode, 'PK');
  assert.equal(calls, 2);
});

test('osmSource.discover: unknown city gives no businesses', async () => {
  const ctx = fakeContext([[/nominatim/, { body: '[]' }]]);
  assert.deepEqual(await osmSource.discover({ category: 'dentist', keywords: [], city: 'Nowhere', region: null, countryCode: null, limit: 5 }, ctx), []);
});

// ── Search ───────────────────────────────────────────────────────────────────

test('DuckDuckGo HTML: ads skipped, redirect links unwrapped', () => {
  const r = parseDdgHtml(DDG_HTML, 10);
  assert.deepEqual(r.map((x) => x.url), ['https://www.smiledental.pk/', 'https://www.marham.pk/doctors/lahore/dentist', 'https://lahoredentalcare.com/contact', 'https://blog.example.org/top-10']);
  assert.equal(r[0]!.snippet, 'Teeth whitening, implants and braces in Gulberg.');
  assert.equal(r[0]!.position, 1);
});

test('DuckDuckGo CAPTCHA page is a source block', async () => {
  assert.equal(isDdgChallenge(200, DDG_CAPTCHA), true);
  assert.equal(isDdgChallenge(202, ''), true);
  assert.equal(isDdgChallenge(200, DDG_HTML), false);
  const ctx = fakeContext([[/duckduckgo/, { body: DDG_CAPTCHA }]]);
  await assert.rejects(ddgProvider.search('dentist in lahore', { limit: 5 }, ctx), (e: unknown) => e instanceof SourceBlockedError && e.reason === 'captcha');
});

test('SERP API answers: SerpApi and DataForSEO (organic only)', () => {
  assert.deepEqual(parseSerpApi(SERPAPI_JSON).map((r) => r.url), ['https://smiledental.pk/', 'https://www.facebook.com/somepage']);
  assert.deepEqual(parseDataForSeo(DATAFORSEO_JSON).map((r) => r.url), ['https://acmedental.com/']);
  assert.throws(() => parseDataForSeo({ tasks: [{ status_code: 40401, status_message: 'Auth failed' }] }), /Auth failed/);
});

test('search results -> businesses: directories, social sites and listicles dropped, one per domain', () => {
  const r = parseDdgHtml(DDG_HTML, 10);
  const b = searchResultsToBusinesses([...r, r[0]!], { sourceCode: 'ddg', category: 'dentist', city: 'Lahore', region: null, countryCode: 'PK' });
  assert.deepEqual(b.map((x) => [x.name, x.domain, x.websiteUrl]), [
    ['Smile Dental Clinic', 'smiledental.pk', 'https://www.smiledental.pk/'],
    ['Lahore Dental Care', 'lahoredentalcare.com', 'https://lahoredentalcare.com/'],
  ]);
  assert.equal(businessNameFromTitle('Acme - Home'), 'Acme');
});

test('discovery queries come from the category keywords + extra keywords', () => {
  assert.deepEqual(buildDiscoveryQueries({ category: 'dentist', keywords: ['orthodontics'], city: 'Lahore', region: null }),
    ['orthodontics dental clinic in Lahore', 'dental clinic in Lahore', 'dentist in Lahore']);
  assert.deepEqual(buildDiscoveryQueries({ category: 'it_company', keywords: ['AI automation'], city: 'Lahore', region: null }).slice(0, 1),
    ['ai automation software company in Lahore']);
  assert.deepEqual(buildDiscoveryQueries({ category: null, keywords: ['solar installers'], city: 'Karachi', region: 'Sindh' }), ['solar installers in Karachi Sindh']);
});

test('searchSource.discover stops at the limit and dedupes across queries', async () => {
  const ctx = fakeContext([[/duckduckgo/, { body: DDG_HTML }]]);
  const found = await searchSource(ddgProvider).discover({ category: 'dentist', keywords: [], city: 'Lahore', region: null, countryCode: 'PK', limit: 5 }, ctx);
  assert.deepEqual(found.map((b) => b.domain), ['smiledental.pk', 'lahoredentalcare.com']);
  const one = await searchSource(ddgProvider).discover({ category: 'dentist', keywords: [], city: 'Lahore', region: null, countryCode: 'PK', limit: 1 }, ctx);
  assert.equal(one.length, 1);
});

test('one search provider per run: SERP API only with a key, else DuckDuckGo', () => {
  const row = (code: string, isEnabled = true): SourceRow => ({ id: 1, code, type: 'search', isEnabled, ratePerMin: null, dailyCap: null, notes: null, cooldownUntil: null });
  const all = [row('osm'), row('ddg'), row('serp_api'), row('website')];
  const prev = process.env.LEADGEN_SERP_API_KEY;
  try {
    delete process.env.LEADGEN_SERP_API_KEY;
    assert.deepEqual(pickDiscoverySources(all).map((s) => s.code), ['osm', 'ddg']);
    process.env.LEADGEN_SERP_API_KEY = 'k';
    assert.deepEqual(pickDiscoverySources(all).map((s) => s.code), ['osm', 'serp_api']);
    assert.deepEqual(pickDiscoverySources([row('osm', false), row('ddg'), row('serp_api', false)]).map((s) => s.code), ['ddg']);
  } finally {
    if (prev === undefined) delete process.env.LEADGEN_SERP_API_KEY;
    else process.env.LEADGEN_SERP_API_KEY = prev;
  }
});

test('OSM "website" that is a Facebook page becomes a social link, not the company domain', () => {
  const [b] = mapOverpassElements(
    [{ type: 'node', id: 9, lat: 1, lon: 2, tags: { name: 'Sherwani Dental', website: 'https://www.facebook.com/sherwanidental' } }],
    { category: 'dentist', city: 'Lahore', region: null, countryCode: 'PK', limit: 5 }
  );
  assert.equal(b!.websiteUrl, null);
  assert.equal(b!.domain, null);
  assert.deepEqual(b!.socials, [{ platform: 'facebook', url: 'https://www.facebook.com/sherwanidental' }]);
});
