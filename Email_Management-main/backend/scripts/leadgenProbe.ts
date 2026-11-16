/**
 * Runs one discovery source against the real internet, without the database (in-memory cache).
 * For checking a source by hand; the worker does not use this.
 *
 *   npx tsx scripts/leadgenProbe.ts osm dentist Lahore PK 20
 *   npx tsx scripts/leadgenProbe.ts ddg "real_estate" Dubai AE 10
 *
 * Arguments: source (osm | ddg | serp_api), category key or keyword, city, country code, limit.
 */
import 'dotenv/config';
import { safeFetch } from '../src/lib/leadgen/http.js';
import { getCategory } from '../src/lib/leadgen/categories.js';
import { scheduleForSource } from '../src/lib/leadgen/rateLimiter.js';
import { DISCOVERY_SOURCES } from '../src/lib/leadgen/sources/index.js';
import type { SourceContext } from '../src/lib/leadgen/types.js';

const [code = 'osm', what = 'dentist', city = 'Lahore', country = 'PK', limitArg = '20'] = process.argv.slice(2);
const source = DISCOVERY_SOURCES[code as keyof typeof DISCOVERY_SOURCES];
if (!source) {
  console.error(`Unknown source ${code}. Use osm, ddg or serp_api.`);
  process.exit(1);
}

const memory = new Map<string, unknown>();
let requests = 0;
const ctx: SourceContext = {
  fetch: (url, opts) => scheduleForSource(code, 50, () => { requests++; return safeFetch(url, opts); }),
  cacheGet: async <T>(key: string) => (memory.get(key) as T) ?? null,
  cacheSet: async (key, payload) => { memory.set(key, payload); },
};

async function run() {
  const category = getCategory(what);
  const started = Date.now();
  const found = await source!.discover(
    { category: category?.key ?? null, keywords: category ? [] : [what], city, region: null, countryCode: country, limit: Number(limitArg) || 20 },
    ctx
  );
  console.log(`${found.length} business(es) from ${code} in ${((Date.now() - started) / 1000).toFixed(1)}s, ${requests} request(s)`);
  const pct = (n: number) => (found.length ? `${Math.round((n / found.length) * 100)}%` : '-');
  console.log(`  website ${pct(found.filter((b) => b.websiteUrl).length)}, phone ${pct(found.filter((b) => b.phone).length)}, email ${pct(found.filter((b) => b.email).length)}`);
  for (const b of found.slice(0, 15)) {
    console.log(`  - ${b.name}${b.domain ? ` (${b.domain})` : ''}${b.phone ? `, ${b.phone}` : ''}`);
  }
}

run().catch((err) => {
  console.error('Probe failed:', err);
  process.exitCode = 1;
});
