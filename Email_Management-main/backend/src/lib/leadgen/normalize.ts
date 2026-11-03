/**
 * Normalized keys of the master data (use case section 7): domain lowercase without www.,
 * email lowercase, LinkedIn URL https without query string, names without legal suffixes.
 * Unique indexes are built on these values, so every writer must use these functions.
 * Phone E.164 (libphonenumber-js) comes with verification on Day 2.
 */
import { createHash } from 'node:crypto';

/** "https://WWW.Acme.com.pk/about" | "acme.com" -> "acme.com.pk" | "acme.com". Null if it is not a public hostname. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '').replace(/^www\d*\./, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/** Directories, social networks, marketplaces and media: a result there is not the business's own site. */
const NOT_A_BUSINESS_SITE = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com',
  'wikipedia.org', 'wikimedia.org', 'reddit.com', 'quora.com', 'medium.com', 'yelp.com', 'tripadvisor.com', 'foursquare.com',
  'google.com', 'maps.google.com', 'goo.gl', 'bing.com', 'yellowpages.com', 'yell.com', 'justdial.com', 'clutch.co',
  'goodfirms.co', 'glassdoor.com', 'indeed.com', 'rozee.pk', 'mustakbil.com', 'olx.com.pk', 'olx.com', 'daraz.pk', 'amazon.com',
  'marham.pk', 'oladoc.com', 'sehat.com.pk', 'zameen.com', 'graana.com', 'propertyfinder.ae', 'booking.com', 'agoda.com',
  'trustpilot.com', 'crunchbase.com', 'zoominfo.com', 'apollo.io', 'dnb.com', 'bloomberg.com', 'apps.apple.com', 'play.google.com',
  'gov.pk', 'blogspot.com', 'wordpress.com',
];

export function isDirectoryDomain(domain: string): boolean {
  return NOT_A_BUSINESS_SITE.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Adds https:// when missing, drops the #hash. Null for anything that is not http(s). */
export function normalizeWebsiteUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!normalizeDomain(u.hostname)) return null;
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Lowercase, trimmed, "mailto:" removed. Null if the syntax is wrong. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().replace(/^mailto:/i, '').split('?')[0]!.toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/**
 * LinkedIn company or profile URL -> "https://www.linkedin.com/company/acme" / "https://www.linkedin.com/in/ali-khan".
 * Country subdomains (pk.linkedin.com), query strings, trailing slashes and sub-pages (/about) are dropped.
 * Null for anything else (posts, jobs, search pages).
 */
export function normalizeLinkedinUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const m = u.pathname.match(/^\/(company|in|school)\/([^/?#]+)/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[2]!);
  } catch {
    slug = m[2]!;
  }
  slug = slug.trim().toLowerCase();
  if (!slug) return null;
  return `https://www.linkedin.com/${m[1]!.toLowerCase()}/${encodeURIComponent(slug)}`;
}

/** Longest first, so "private limited" wins over "limited". */
const LEGAL_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd', 'pvt limited', 'smc private limited', 'smc pvt ltd', 'smc-pvt ltd',
  'limited', 'ltd', 'llc', 'l.l.c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'llp', 'pvt', 'pte',
].sort((a, b) => b.length - a.length);

function basicName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}.\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Acme Dental (Pvt.) Ltd." -> "acme dental". Used for dedupe (normalized_name + city + phone). */
export function normalizeCompanyName(input: string): string {
  let n = basicName(input).replace(/[()]/g, ' ');
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of LEGAL_SUFFIXES) {
      const re = new RegExp(`(^|\\s)${s.replace(/[.]/g, '\\.?')}\\.?$`);
      if (re.test(n) && n.replace(re, '').trim().length > 0) {
        n = n.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return n.replace(/[.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Dr. Ali  Khan" -> "ali khan". */
export function normalizePersonName(input: string): string {
  return basicName(input)
    .replace(/^(dr|mr|mrs|ms|miss|prof|engr|eng)\.?\s+/, '')
    .replace(/[.\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type IdentifierType = 'email' | 'domain' | 'linkedin_url';

/** The normalized identifier, or null if it cannot be normalized. */
export function normalizeIdentifier(type: IdentifierType, value: string): string | null {
  if (type === 'email') return normalizeEmail(value);
  if (type === 'domain') return normalizeDomain(value);
  return normalizeLinkedinUrl(value);
}

/** sha256 hex of the normalized identifier (do_not_collect / data_subject_requests). Null if it cannot be normalized. */
export function hashIdentifier(type: IdentifierType, value: string): string | null {
  const n = normalizeIdentifier(type, value);
  return n ? createHash('sha256').update(`${type}:${n}`).digest('hex') : null;
}
