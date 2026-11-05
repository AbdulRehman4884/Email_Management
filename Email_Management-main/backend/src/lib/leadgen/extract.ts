/**
 * Facts from one HTML page (pure: no network, no database). Use case UC-04 step 5:
 *   JSON-LD (Organization / LocalBusiness / Person / JobPosting), meta description, mailto/tel links,
 *   plain-text, obfuscated ("ali [at] acme [dot] com") and Cloudflare-protected emails, footer social links,
 *   team members (name + title), careers page job count, tech signals (CMS, analytics, chat widget),
 *   and the internal links the crawler may follow next.
 * Raw HTML is never stored; only these facts are.
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { normalizeDomain, normalizeLinkedinUrl } from './normalize.js';
import { cleanEmail } from './verify.js';
import type { SocialPlatform } from './types.js';

export type PageType = 'home' | 'about' | 'contact' | 'team' | 'careers' | 'other';

export interface TeamMember {
  fullName: string;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
}

export interface PageFacts {
  title: string | null;
  description: string | null;
  name: string | null;
  emails: string[];
  phones: string[];
  whatsapp: string[];
  socials: Array<{ platform: SocialPlatform; url: string }>;
  address: { street: string | null; city: string | null; region: string | null; countryCode: string | null } | null;
  foundedYear: number | null;
  employeeCount: number | null;
  team: TeamMember[];
  /** Job postings seen on the page (JSON-LD JobPosting or job-like list items). */
  openRoles: number;
  techStack: string[];
  /** What the page says the business does: title, meta keywords, h1-h3 (short phrases). */
  topics: string[];
  /** Same-site links: absolute URL + the page type its URL / text suggests. */
  links: Array<{ url: string; type: PageType }>;
}

// ── Emails ───────────────────────────────────────────────────────────────────

const EMAIL_IN_TEXT = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}/gi;
const OBFUSCATED = /([a-z0-9._%+-]{1,64})\s*(?:\[|\(|\{)\s*(?:at|@)\s*(?:\]|\)|\})\s*([a-z0-9-]{1,63}(?:\s*(?:\[|\(|\{)\s*(?:dot|\.)\s*(?:\]|\)|\})\s*[a-z0-9-]{1,63})+)/gi;

/** Cloudflare email protection: hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

function deobfuscate(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(OBFUSCATED)) {
    const domain = m[2]!.replace(/\s*(?:\[|\(|\{)\s*(?:dot|\.)\s*(?:\]|\)|\})\s*/gi, '.');
    out.push(`${m[1]}@${domain}`);
  }
  return out;
}

// ── Social links ─────────────────────────────────────────────────────────────

const SOCIAL_HOSTS: Array<[RegExp, SocialPlatform]> = [
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)twitter\.com$|(^|\.)x\.com$/, 'x'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'youtube'],
];
const SHARE_PATH = /sharer|share\.php|\/share\b|intent\/tweet|\/dialog\/|\/plugins\/|\/hashtag\/|\/watch\?|\/embed\/|\/p\/|\/reel\/|\/posts?\/|\/status\/|\/events?\//i;

/** A profile/page URL of a social network (not a share button or a post). Normalized: https, no query. */
export function socialProfileOf(href: string): { platform: SocialPlatform; url: string } | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const hit = SOCIAL_HOSTS.find(([re]) => re.test(host));
  if (!hit) return null;
  const platform = hit[1];
  if (SHARE_PATH.test(u.pathname + u.search) || u.pathname === '/' || u.pathname === '') return null;
  if (platform === 'linkedin') {
    const url = normalizeLinkedinUrl(href);
    return url ? { platform, url } : null;
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (platform === 'facebook' && /^\/(profile\.php)$/.test(path)) {
    const id = u.searchParams.get('id');
    return id ? { platform, url: `https://www.facebook.com/profile.php?id=${id}` } : null;
  }
  const bare = host.replace(/^(www|m|mobile)\./, '');
  const canonicalHost = platform === 'x' ? 'x.com' : platform === 'youtube' && bare === 'youtu.be' ? 'www.youtube.com' : `www.${bare}`;
  return { platform, url: `https://${canonicalHost}${path.toLowerCase()}` };
}

// ── Page types ───────────────────────────────────────────────────────────────

const TYPE_WORDS: Array<[PageType, RegExp]> = [
  ['contact', /contact|get-in-touch|reach-us|rabta|location|find-us/],
  ['team', /team|our-people|people|staff|doctors|leadership|management|founders|meet-|who-we-are/],
  ['careers', /career|jobs|vacanc|join-us|hiring|work-with-us|openings/],
  ['about', /about|company|our-story|history|profile/],
];

export function pageTypeOf(url: string, text = ''): PageType {
  let path = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    if (path === '/' || path === '') return 'home';
  } catch {
    return 'other';
  }
  const hay = `${path} ${text.toLowerCase().replace(/\s+/g, '-')}`;
  for (const [type, re] of TYPE_WORDS) if (re.test(hay)) return type;
  return 'other';
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

function ldNodes($: CheerioAPI): Json[] {
  const out: Json[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.replace(/^\s*<!--|-->\s*$/g, ''));
    } catch {
      return;
    }
    const walk = (n: unknown) => {
      for (const item of asArray(n)) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Json;
        out.push(o);
        if (o['@graph']) walk(o['@graph']);
      }
    };
    walk(parsed);
  });
  return out;
}

function typesOf(n: Json): string[] {
  return asArray(n['@type']).map((t) => String(t).toLowerCase());
}

const ORG_TYPES = /organization|localbusiness|business|store|clinic|dentist|medical|hospital|restaurant|hotel|agency|office|attorney|legalservice|school|corporation|professionalservice|place/;

// ── Team members ─────────────────────────────────────────────────────────────

const TITLE_WORDS =
  /\b(ceo|cto|cfo|coo|cmo|founder|co-founder|cofounder|owner|director|manager|head|chief|president|vice president|vp|partner|principal|consultant|surgeon|dentist|orthodontist|doctor|physician|specialist|lead|officer|engineer|architect|lawyer|advocate|accountant|chairman|chairperson|md|managing)\b/i;
const NOT_A_NAME = /\b(our|team|meet|about|contact|services?|clinic|company|home|welcome|privacy|policy|careers?|news|blog|read|more|view|profile|book|appointment|call|email|follow)\b/i;

export function looksLikeName(s: string): boolean {
  const t = s.replace(/^(dr|mr|mrs|ms|prof|engr)\.?\s+/i, '').trim();
  const parts = t.split(/\s+/);
  if (parts.length < 2 || parts.length > 4 || t.length > 50) return false;
  if (NOT_A_NAME.test(t) || TITLE_WORDS.test(t)) return false;
  return parts.every((p) => /^[A-Z][a-zA-Z'’.-]{0,20}$/.test(p));
}

function cleanTitle(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 120 && TITLE_WORDS.test(t) ? t : null;
}

function teamFromHtml($: CheerioAPI, base: string): TeamMember[] {
  const out: TeamMember[] = [];
  const seen = new Set<string>();
  const add = (name: string, title: string | null, scope: ReturnType<CheerioAPI>) => {
    const fullName = name.replace(/\s+/g, ' ').trim();
    if (!looksLikeName(fullName) || seen.has(fullName.toLowerCase())) return;
    seen.add(fullName.toLowerCase());
    let linkedinUrl: string | null = null;
    let email: string | null = null;
    scope.find('a[href]').each((_i, a) => {
      const href = $(a).attr('href') ?? '';
      if (!linkedinUrl && /linkedin\.com\/in\//i.test(href)) linkedinUrl = normalizeLinkedinUrl(absolute(href, base));
      if (!email && /^mailto:/i.test(href)) email = cleanEmail(href);
    });
    out.push({ fullName, title, linkedinUrl, email });
  };
  // Cards: an element named like a team/member/staff block with a heading (name) and a title line.
  $('[class*="team"], [class*="member"], [class*="staff"], [class*="doctor"], [class*="people"], [class*="person"], [class*="profile"], [class*="leader"]').each((_i, el) => {
    const card = $(el);
    // A grid/list of cards is not a card itself: its links would be mixed up between people.
    if (card.find('[class*="team"], [class*="member"], [class*="staff"], [class*="doctor"], [class*="person"], [class*="profile"]').length >= 2) return;
    const heading = card.find('h2, h3, h4, h5, h6, strong, .name, [class*="name"]').first();
    const name = heading.text();
    if (!name) return;
    const rest = card.find('p, span, small, em, .title, [class*="title"], [class*="role"], [class*="position"], [class*="designation"]')
      .map((_j, n) => $(n).text())
      .get()
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .find((t) => t && t !== name.trim() && TITLE_WORDS.test(t));
    add(name, cleanTitle(rest), card);
  });
  // Fallback: "Ali Khan – CEO" in one heading or a heading followed by a title line.
  if (out.length === 0) {
    $('h2, h3, h4, h5').each((_i, el) => {
      const h = $(el);
      const t = h.text().replace(/\s+/g, ' ').trim();
      const dash = t.match(/^(.{4,50}?)\s*[-–—|,]\s*(.{2,80})$/);
      if (dash && TITLE_WORDS.test(dash[2]!)) return add(dash[1]!, cleanTitle(dash[2]), h.parent());
      const next = h.next().text().replace(/\s+/g, ' ').trim();
      if (next && next.length <= 80 && TITLE_WORDS.test(next)) add(t, cleanTitle(next), h.parent());
    });
  }
  return out.slice(0, 30);
}

// ── Tech signals ─────────────────────────────────────────────────────────────

const TECH: Array<[string, RegExp]> = [
  ['wordpress', /wp-content\/|wp-includes\/|<meta[^>]+generator[^>]+wordpress/i],
  ['shopify', /cdn\.shopify\.com|shopify\.theme/i],
  ['wix', /static\.wixstatic\.com|wix\.com\/website/i],
  ['squarespace', /static1\.squarespace\.com|squarespace\.com/i],
  ['webflow', /webflow\.(js|css|com)|data-wf-page/i],
  ['joomla', /<meta[^>]+generator[^>]+joomla/i],
  ['drupal', /drupal-settings-json|\/sites\/default\/files\//i],
  ['nextjs', /__NEXT_DATA__|\/_next\/static\//],
  ['ga4', /gtag\/js\?id=G-|googletagmanager\.com\/gtag/i],
  ['google_tag_manager', /googletagmanager\.com\/gtm\.js/i],
  ['facebook_pixel', /connect\.facebook\.net\/[^"']*fbevents\.js/i],
  ['hotjar', /static\.hotjar\.com/i],
  ['hubspot', /js\.hs-scripts\.com|js\.hsforms\.net/i],
  ['intercom', /widget\.intercom\.io/i],
  ['tawk_to', /embed\.tawk\.to/i],
  ['crisp', /client\.crisp\.chat/i],
  ['zendesk', /static\.zdassets\.com/i],
  ['livechat', /cdn\.livechatinc\.com/i],
  ['whatsapp_widget', /wa\.me\/|api\.whatsapp\.com\/send/i],
  ['calendly', /assets\.calendly\.com|calendly\.com\//i],
  ['cloudflare', /cdn-cgi\//i],
];

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function extractPage(html: string, pageUrl: string, pageType: PageType = pageTypeOf(pageUrl)): PageFacts {
  const $ = cheerio.load(html);
  const siteDomain = normalizeDomain(pageUrl);
  const emails = new Set<string>();
  const phones = new Set<string>();
  const whatsapp = new Set<string>();
  const socials = new Map<string, { platform: SocialPlatform; url: string }>();
  const links = new Map<string, PageType>();
  const team: TeamMember[] = [];
  let openRoles = 0;
  let name: string | null = null;
  let description = $('meta[name="description"]').attr('content')?.trim() || $('meta[property="og:description"]').attr('content')?.trim() || null;
  let address: PageFacts['address'] = null;
  let foundedYear: number | null = null;
  let employeeCount: number | null = null;

  // JSON-LD
  for (const n of ldNodes($)) {
    const types = typesOf(n);
    if (types.includes('jobposting')) {
      openRoles++;
      continue;
    }
    if (types.includes('person')) {
      const fullName = text(n.name);
      if (fullName && looksLikeName(fullName)) {
        team.push({ fullName, title: cleanTitle(text(n.jobTitle)), linkedinUrl: asArray(n.sameAs).map((s) => normalizeLinkedinUrl(String(s))).find(Boolean) ?? null, email: cleanEmail(text(n.email)) });
      }
      continue;
    }
    if (!types.some((t) => ORG_TYPES.test(t))) continue;
    name ??= text(n.name) ?? text(n.legalName);
    description ??= text(n.description);
    for (const t of asArray(n.telephone)) if (text(t)) phones.add(text(t)!);
    for (const e of asArray(n.email)) {
      const c = cleanEmail(text(e));
      if (c) emails.add(c);
    }
    for (const s of asArray(n.sameAs)) {
      const p = socialProfileOf(String(s));
      if (p) socials.set(p.url, p);
    }
    const a = asArray(n.address)[0];
    if (a && typeof a === 'object' && !address) {
      const ad = a as Json;
      const country = text(ad.addressCountry) ?? text((ad.addressCountry as Json | undefined)?.name);
      address = {
        street: text(ad.streetAddress),
        city: text(ad.addressLocality),
        region: text(ad.addressRegion),
        countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
      };
    }
    const founded = text(n.foundingDate)?.match(/\b(1[89]\d{2}|20\d{2})\b/);
    if (founded && !foundedYear) foundedYear = Number(founded[1]);
    const emp = n.numberOfEmployees;
    const empValue = typeof emp === 'object' && emp ? Number((emp as Json).value ?? (emp as Json).maxValue) : Number(emp);
    if (Number.isFinite(empValue) && empValue > 0 && !employeeCount) employeeCount = empValue;
    for (const f of [...asArray(n.founder), ...asArray(n.employee)]) {
      if (f && typeof f === 'object') {
        const fn = text((f as Json).name);
        if (fn && looksLikeName(fn)) team.push({ fullName: fn, title: cleanTitle(text((f as Json).jobTitle)) ?? (asArray(n.founder).includes(f) ? 'Founder' : null), linkedinUrl: null, email: null });
      }
    }
  }

  // Links: mailto, tel, WhatsApp, social, Cloudflare, internal
  $('a[href]').each((_i, el) => {
    const a = $(el);
    const href = (a.attr('href') ?? '').trim();
    if (/^mailto:/i.test(href)) {
      const c = cleanEmail(decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0]!));
      if (c) emails.add(c);
      return;
    }
    if (/^tel:/i.test(href)) {
      phones.add(decodeURIComponent(href.replace(/^tel:/i, '')));
      return;
    }
    const cf = href.match(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i);
    if (cf) {
      const c = cleanEmail(decodeCfEmail(cf[1]!));
      if (c) emails.add(c);
      return;
    }
    const abs = absolute(href, pageUrl);
    if (!abs) return;
    const wa = abs.match(/^https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?(\d{8,15})/i);
    if (wa) {
      whatsapp.add(`+${wa[1]}`);
      return;
    }
    const social = socialProfileOf(abs);
    if (social) {
      socials.set(social.url, social);
      return;
    }
    if (siteDomain && normalizeDomain(abs) === siteDomain && /^https?:/i.test(abs)) {
      const clean = abs.split('#')[0]!;
      if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)$/i.test(clean)) return;
      if (!links.has(clean)) links.set(clean, pageTypeOf(clean, a.text()));
    }
  });
  $('[data-cfemail]').each((_i, el) => {
    const c = cleanEmail(decodeCfEmail($(el).attr('data-cfemail') ?? ''));
    if (c) emails.add(c);
  });

  // Topics: what the business says it does (for a search's focus, e.g. "AI automation").
  const topicSet = new Set<string>();
  const addTopic = (t: string | undefined | null) => {
    const v = (t ?? '').replace(/\s+/g, ' ').trim();
    if (v.length >= 3 && v.length <= 120 && topicSet.size < 40) topicSet.add(v);
  };
  addTopic($('title').first().text());
  for (const k of ($('meta[name="keywords"]').attr('content') ?? '').split(',')) addTopic(k);
  $('h1, h2, h3').each((_i, el) => addTopic($(el).text()));

  // Visible text: plain and obfuscated emails
  $('script, style, noscript, template').remove();
  // Text nodes joined with a space: $('body').text() glues neighbouring elements together, so
  // "<span>info@acme.com</span><a>Send</a>" became "info@acme.comSend" (seen on a real site).
  const textParts: string[] = [];
  $('body').find('*').addBack().contents().each((_i, n) => {
    if (n.type === 'text') textParts.push(n.data);
  });
  const bodyText = textParts.join(' ').replace(/\s+/g, ' ');
  for (const m of bodyText.match(EMAIL_IN_TEXT) ?? []) {
    const c = cleanEmail(m);
    if (c) emails.add(c);
  }
  for (const m of deobfuscate(bodyText)) {
    const c = cleanEmail(m);
    if (c) emails.add(c);
  }

  // Team page / about page people
  if (pageType === 'team' || pageType === 'about' || pageType === 'home') team.push(...teamFromHtml($, pageUrl));

  // Careers page: job-like entries
  if (pageType === 'careers' && openRoles === 0) {
    const jobs = $('[class*="job"], [class*="position"], [class*="opening"], [class*="vacanc"]').filter((_i, el) => {
      const t = $(el).text().trim();
      return t.length > 5 && t.length < 300 && $(el).find('[class*="job"], [class*="position"]').length === 0;
    });
    openRoles = Math.min(jobs.length, 200);
  }

  const techStack = TECH.filter(([, re]) => re.test(html)).map(([k]) => k);
  if (whatsapp.size && !techStack.includes('whatsapp_widget')) techStack.push('whatsapp_widget');

  const dedupTeam = new Map<string, TeamMember>();
  for (const t of team) {
    const key = t.fullName.toLowerCase();
    const prev = dedupTeam.get(key);
    dedupTeam.set(key, prev ? { ...prev, title: prev.title ?? t.title, linkedinUrl: prev.linkedinUrl ?? t.linkedinUrl, email: prev.email ?? t.email } : t);
  }

  return {
    title: $('title').first().text().trim() || null,
    description: description ? description.slice(0, 2000) : null,
    name,
    emails: [...emails],
    phones: [...phones].map((p) => p.trim()).filter((p) => p.replace(/\D/g, '').length >= 7),
    whatsapp: [...whatsapp],
    socials: [...socials.values()],
    address,
    foundedYear,
    employeeCount,
    team: [...dedupTeam.values()],
    openRoles,
    techStack,
    topics: [...topicSet],
    links: [...links.entries()].map(([url, type]) => ({ url, type })),
  };
}

/** sitemap.xml -> page URLs (a sitemap index gives its child sitemaps, marked with isIndex). */
export function parseSitemap(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, '&')).slice(0, 2000);
  return { urls, isIndex };
}

/** Employee count -> companies.employee_range bucket. */
export function employeeRange(n: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n <= 10) return '1-10';
  if (n <= 50) return '11-50';
  if (n <= 200) return '51-200';
  if (n <= 500) return '201-500';
  if (n <= 1000) return '501-1000';
  if (n <= 5000) return '1001-5000';
  return '5000+';
}
