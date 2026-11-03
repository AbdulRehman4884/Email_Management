/**
 * Run: npm run test:leadgen   (offline)
 * Lead Engine Day 2, collectors: page extraction, crawler, LinkedIn from search results, email/phone checks,
 * scoring, provider parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCfEmail, extractPage, looksLikeName, pageTypeOf, parseSitemap, socialProfileOf, employeeRange } from '../leadgen/extract.js';
import { choosePages, crawlSite, sha256 } from '../leadgen/crawler.js';
import { companyNamesMatch, departmentOf, parsePersonTitle, pickCompanyResult, pickPeople, seniorityOf } from '../leadgen/linkedin.js';
import { cleanEmail, emailLabel, hasMx, normalizePhone, clearMxCache } from '../leadgen/verify.js';
import { computeFitScore, tierFor } from '../leadgen/score.js';
import { parsePdlCompany, parsePdlPeople } from '../leadgen/provider.js';
import type { FetchResult } from '../leadgen/http.js';

// Cloudflare encoding of "info@smiledental.pk" with key 0x2a.
const cf = (email: string, key = 0x2a) => key.toString(16).padStart(2, '0') + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');

const HOME = `<!doctype html><html><head><title>Smile Dental Clinic | Lahore</title>
<meta name="description" content="Family dentistry in Gulberg, Lahore since 2009.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Dentist","name":"Smile Dental Clinic",
 "telephone":"+92 42 3577 1234","email":"info@smiledental.pk","foundingDate":"2009-03-01","numberOfEmployees":{"@type":"QuantitativeValue","value":14},
 "address":{"@type":"PostalAddress","streetAddress":"12 MM Alam Road","addressLocality":"Lahore","addressRegion":"Punjab","addressCountry":"PK"},
 "sameAs":["https://www.facebook.com/smiledentalpk","https://pk.linkedin.com/company/smile-dental-clinic/"],
 "founder":{"@type":"Person","name":"Ayesha Malik"}}]}</script>
<script src="/wp-content/themes/x/app.js"></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script src="https://embed.tawk.to/abc/default"></script>
</head><body>
<nav><a href="/about-us/">About</a><a href="/our-team">Our Team</a><a href="/contact">Contact</a><a href="/careers">Careers</a>
<a href="/blog/how-to-floss">Blog</a><a href="https://other.com/x">Partner</a><a href="/brochure.pdf">Brochure</a></nav>
<p>Write to bookings [at] smiledental [dot] pk or <a href="mailto:Appointments@SmileDental.pk?subject=Hi">email us</a>.</p>
<a href="/cdn-cgi/l/email-protection#${cf('dr.ayesha@smiledental.pk')}">[email protected]</a>
<span class="__cf_email__" data-cfemail="${cf('billing@smiledental.pk', 0x11)}">[email protected]</span>
<img src="logo@2x.png" alt="logo@2x.png"> noreply@smiledental.pk  user@example.com  a1b2c3d4e5f6a7b8c9d0@sentry.io
<a href="tel:+924235771235">Call</a> <a href="https://wa.me/923001234567">WhatsApp</a>
<footer><a href="https://instagram.com/smiledentalpk/">IG</a><a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
<a href="https://twitter.com/intent/tweet?text=x">Tweet</a><a href="https://www.youtube.com/@smiledental">YT</a></footer>
</body></html>`;

const TEAM = `<html><body><h1>Meet Our Team</h1>
<div class="team-grid">
  <div class="team-member"><img src="a.jpg"><h3>Dr. Ayesha Malik</h3><p class="designation">Founder &amp; Lead Dentist</p>
    <a href="https://www.linkedin.com/in/ayesha-malik-dds/">in</a></div>
  <div class="team-member"><h3>Bilal Ahmed</h3><span class="role">Clinic Manager</span><a href="mailto:bilal@smiledental.pk">mail</a></div>
  <div class="team-member"><h3>Read More</h3><p>Our services</p></div>
</div></body></html>`;

const CAREERS = `<html><body><h1>Careers</h1><ul class="jobs">
<li class="job-item">Dental Assistant — Full time</li><li class="job-item">Receptionist — Part time</li><li class="job-item">Hygienist</li></ul></body></html>`;

const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://www.smiledental.pk/contact</loc></url>
<url><loc>https://www.smiledental.pk/locations/contact-gulberg</loc></url><url><loc>https://www.smiledental.pk/privacy</loc></url></urlset>`;

test('JSON-LD, meta, emails (mailto, text, obfuscated, Cloudflare), junk rejected', () => {
  const f = extractPage(HOME, 'https://www.smiledental.pk/', 'home');
  assert.equal(f.name, 'Smile Dental Clinic');
  assert.equal(f.description, 'Family dentistry in Gulberg, Lahore since 2009.');
  assert.deepEqual(f.address, { street: '12 MM Alam Road', city: 'Lahore', region: 'Punjab', countryCode: 'PK' });
  assert.equal(f.foundedYear, 2009);
  assert.equal(f.employeeCount, 14);
  assert.deepEqual(f.emails.sort(), ['appointments@smiledental.pk', 'billing@smiledental.pk', 'bookings@smiledental.pk', 'dr.ayesha@smiledental.pk', 'info@smiledental.pk']);
  for (const junk of ['logo@2x.png', 'noreply@smiledental.pk', 'user@example.com']) assert.ok(!f.emails.includes(junk), junk);
  assert.ok(!f.emails.some((e) => e.endsWith('sentry.io')));
});

test('phones, WhatsApp, social profiles (share buttons ignored), tech signals, founder', () => {
  const f = extractPage(HOME, 'https://www.smiledental.pk/', 'home');
  assert.ok(f.phones.includes('+92 42 3577 1234'));
  assert.ok(f.phones.includes('+924235771235'));
  assert.deepEqual(f.whatsapp, ['+923001234567']);
  assert.deepEqual(f.socials.map((s) => s.url).sort(), [
    'https://www.facebook.com/smiledentalpk', 'https://www.instagram.com/smiledentalpk', 'https://www.linkedin.com/company/smile-dental-clinic', 'https://www.youtube.com/@smiledental',
  ]);
  for (const t of ['wordpress', 'ga4', 'tawk_to', 'whatsapp_widget', 'cloudflare']) assert.ok(f.techStack.includes(t), t);
  assert.ok(f.team.some((m) => m.fullName === 'Ayesha Malik' && m.title === 'Founder'));
});

test('internal links are typed; off-site links and files are dropped', () => {
  const f = extractPage(HOME, 'https://www.smiledental.pk/', 'home');
  const byType = Object.fromEntries(f.links.map((l) => [new URL(l.url).pathname, l.type]));
  assert.deepEqual(byType, { '/about-us/': 'about', '/our-team': 'team', '/contact': 'contact', '/careers': 'careers', '/blog/how-to-floss': 'other' });
  assert.equal(pageTypeOf('https://x.com/'), 'home');
  assert.equal(pageTypeOf('https://x.com/jobs/open'), 'careers');
});

test('team page: names + titles + LinkedIn + email; headings that are not names are skipped', () => {
  const f = extractPage(TEAM, 'https://www.smiledental.pk/our-team', 'team');
  assert.deepEqual(f.team.map((t) => [t.fullName, t.title, t.linkedinUrl, t.email]), [
    ['Dr. Ayesha Malik', 'Founder & Lead Dentist', 'https://www.linkedin.com/in/ayesha-malik-dds', null],
    ['Bilal Ahmed', 'Clinic Manager', null, 'bilal@smiledental.pk'],
  ]);
  assert.equal(looksLikeName('Read More'), false);
  assert.equal(looksLikeName('Our Team'), false);
  assert.equal(looksLikeName('Ali Khan'), true);
});

test('careers page job count', () => {
  assert.equal(extractPage(CAREERS, 'https://www.smiledental.pk/careers', 'careers').openRoles, 3);
});

test('Cloudflare email decoding and social URL normalization', () => {
  assert.equal(decodeCfEmail(cf('a@b.co')), 'a@b.co');
  assert.equal(decodeCfEmail('zz'), null);
  assert.equal(socialProfileOf('https://m.facebook.com/AcmePK/?ref=x')?.url, 'https://www.facebook.com/acmepk');
  assert.equal(socialProfileOf('https://twitter.com/acme')?.url, 'https://x.com/acme');
  assert.equal(socialProfileOf('https://www.facebook.com/'), null);
  assert.equal(socialProfileOf('https://www.instagram.com/p/abc123/'), null);
});

test('sitemap parsing and page choice (contact/about/team/careers, max 8 pages, short paths first)', () => {
  assert.deepEqual(parseSitemap(SITEMAP).urls.length, 3);
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>').isIndex, true);
  const picked = choosePages([
    { url: 'https://a.com/blog/how-to-contact-us', type: 'contact' },
    { url: 'https://a.com/contact', type: 'contact' },
    { url: 'https://a.com/contact-2', type: 'contact' },
    { url: 'https://a.com/about', type: 'about' },
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://a.com/team/${i}`, type: 'team' as const })),
  ], 'https://a.com/');
  // At most 2 pages per type: 2 contact + 1 about + 2 team. Never more than 7 besides the home page.
  assert.equal(picked.length, 5);
  assert.ok(picked.length <= 7);
  assert.equal(picked[0]!.url, 'https://a.com/contact');
  assert.equal(picked.filter((p) => p.type === 'contact').length, 2);
  assert.equal(employeeRange(14), '11-50');
});

function fakeSite(pages: Record<string, string | number>): (url: string) => Promise<FetchResult> {
  return async (url) => {
    const body = pages[url];
    if (body === undefined) return { url, status: 404, headers: {}, body: '', redirects: [] };
    if (typeof body === 'number') return { url, status: body, headers: {}, body: '', redirects: [] };
    return { url, status: 200, headers: { 'content-type': 'text/html' } as Record<string, string>, body, redirects: [] };
  };
}

test('crawler: home + sitemap + chosen pages, facts merged; unchanged hashes skip extraction', async () => {
  const site = fakeSite({
    'https://www.smiledental.pk/': HOME,
    'https://www.smiledental.pk/sitemap.xml': SITEMAP,
    'https://www.smiledental.pk/our-team': TEAM,
    'https://www.smiledental.pk/careers': CAREERS,
    'https://www.smiledental.pk/contact': '<html><body>Call 042 3577 9999</body></html>',
    'https://www.smiledental.pk/about-us/': 500,
  });
  const r = await crawlSite('https://www.smiledental.pk/', { fetch: site });
  assert.equal(r.status, 'ok');
  assert.ok(r.pages.length <= 8);
  assert.deepEqual(r.pages.map((p) => p.pageType).sort(), ['about', 'careers', 'contact', 'contact', 'home', 'team']);
  assert.equal(r.facts.openRoles, 3);
  assert.equal(r.facts.careersPage, 'https://www.smiledental.pk/careers');
  assert.ok(r.facts.team.some((t) => t.fullName === 'Bilal Ahmed' && t.sourceUrl.endsWith('/our-team')));
  assert.ok(r.facts.emails.some((e) => e.value === 'info@smiledental.pk'));
  assert.equal(r.unchanged, false);

  const hashes = new Map(r.pages.filter((p) => p.contentHash).map((p) => [p.url, p.contentHash!]));
  const again = await crawlSite('https://www.smiledental.pk/', { fetch: site, previousHashes: hashes });
  assert.equal(again.unchanged, true);
  assert.equal(again.facts.emails.length, 0, 'nothing extracted from unchanged pages');
  assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});

test('crawler: a dead site is "down"; a redirect to another domain is reported', async () => {
  const down = await crawlSite('https://gone.example/', { fetch: fakeSite({}) });
  assert.equal(down.status, 'down');
  const redirected = await crawlSite('https://old.pk/', {
    fetch: async (url) => url === 'https://old.pk/'
      ? { url: 'https://www.newbrand.com/', status: 200, headers: {}, body: '<html><body>hi</body></html>', redirects: ['https://old.pk/'] }
      : { url, status: 404, headers: {}, body: '', redirects: [] },
  });
  assert.equal(redirected.redirectedDomain, 'newbrand.com');
});

// ── LinkedIn via search results ──────────────────────────────────────────────

test('LinkedIn result titles: name, title, company', () => {
  assert.deepEqual(parsePersonTitle('Ali Khan - CEO - Acme Dental | LinkedIn'), { fullName: 'Ali Khan', title: 'CEO', company: 'Acme Dental' });
  assert.deepEqual(parsePersonTitle('Sara Iqbal – Owner at Smile Dental Clinic – LinkedIn'), { fullName: 'Sara Iqbal', title: 'Owner', company: 'Smile Dental Clinic' });
  assert.deepEqual(parsePersonTitle('Usman Tariq - Acme Dental | LinkedIn'), { fullName: 'Usman Tariq', title: null, company: 'Acme Dental' });
  assert.equal(parsePersonTitle('Jobs at Acme | LinkedIn'), null);
});

test('strict company name match', () => {
  assert.equal(companyNamesMatch('Smile Dental', 'Smile Dental Clinic'), true);
  assert.equal(companyNamesMatch('Smile Dental Clinic (Pvt) Ltd', 'smile dental'), true);
  assert.equal(companyNamesMatch('Smile', 'Bright Smile Dental Care'), false);
  assert.equal(companyNamesMatch('Acme Dental', 'Apex Dental'), false);
});

test('company page: first result whose name matches; posts and other companies ignored', () => {
  const r = pickCompanyResult([
    { title: 'Bright Smile | LinkedIn', url: 'https://www.linkedin.com/company/bright-smile', snippet: '', position: 1 },
    { title: 'Smile Dental Clinic posted on LinkedIn', url: 'https://www.linkedin.com/posts/smile-x', snippet: '', position: 2 },
    { title: 'Smile Dental Clinic | LinkedIn', url: 'https://pk.linkedin.com/company/smile-dental-clinic?trk=x', snippet: '', position: 3 },
  ], 'Smile Dental Clinic');
  assert.deepEqual(r, { url: 'https://www.linkedin.com/company/smile-dental-clinic', snippet: 'Smile Dental Clinic | LinkedIn' });
});

test('people: company must match; two profiles with the same name are not saved', () => {
  const people = pickPeople([
    { title: 'Ayesha Malik - Founder - Smile Dental Clinic | LinkedIn', url: 'https://www.linkedin.com/in/ayesha-malik', snippet: '', position: 1 },
    { title: 'Bilal Ahmed - Manager - Other Clinic | LinkedIn', url: 'https://www.linkedin.com/in/bilal', snippet: '', position: 2 },
    { title: 'Omar Shah - CEO - Smile Dental | LinkedIn', url: 'https://www.linkedin.com/in/omar-shah-1', snippet: '', position: 3 },
    { title: 'Omar Shah - Director - Smile Dental | LinkedIn', url: 'https://www.linkedin.com/in/omar-shah-2', snippet: '', position: 4 },
  ], 'Smile Dental Clinic');
  assert.deepEqual(people.map((p) => p.fullName), ['Ayesha Malik']);
  assert.equal(seniorityOf('Founder & CEO'), 'owner');
  assert.equal(seniorityOf('Chief Marketing Officer'), 'c_level');
  assert.equal(seniorityOf('Head of Sales'), 'director');
  assert.equal(departmentOf('Head of Sales'), 'sales');
});

// ── Email / phone / score / provider ─────────────────────────────────────────

test('email junk filter and labels', () => {
  for (const junk of ['logo@2x.png', 'noreply@acme.com', 'no-reply@acme.com', 'test@example.com', 'icon@3x.webp', 'a1b2c3d4e5f6a7b8c9@x.com', 'x@y.invalid']) {
    assert.equal(cleanEmail(junk), null, junk);
  }
  assert.equal(cleanEmail('Ali.Khan@Acme.PK'), 'ali.khan@acme.pk');
  assert.equal(emailLabel('info@acme.pk'), 'generic');
  assert.equal(emailLabel('sales@acme.pk'), 'sales');
  assert.equal(emailLabel('ali@acme.pk'), 'direct');
});

test('MX check (fake resolver): MX, A fallback, none; cached', async () => {
  clearMxCache();
  let calls = 0;
  const resolver = {
    resolveMx: async (d: string) => {
      calls++;
      if (d === 'mx.pk') return [{ exchange: 'mail.mx.pk', priority: 10 }];
      const e = Object.assign(new Error('x'), { code: d === 'aonly.pk' ? 'ENODATA' : 'ENOTFOUND' });
      throw e;
    },
    resolve4: async () => ['1.2.3.4'],
  } as never;
  assert.equal(await hasMx('mx.pk', resolver), true);
  assert.equal(await hasMx('aonly.pk', resolver), true);
  assert.equal(await hasMx('nothing.pk', resolver), false);
  await hasMx('mx.pk', resolver);
  assert.equal(calls, 3);
});

test('phones to E.164 with the company country', () => {
  assert.equal(normalizePhone('042-3577 1234', 'PK'), '+924235771234');
  assert.equal(normalizePhone('+92 300 1234567', null), '+923001234567');
  assert.equal(normalizePhone('0300 1234567', 'PK'), '+923001234567');
  assert.equal(normalizePhone('12345', 'PK'), null);
  assert.equal(normalizePhone('call us', 'PK'), null);
});

test('fit score 0-100 with breakdown and tiers', () => {
  const none = computeFitScore({ categoryMatch: false, cityMatch: false, hasWebsite: false, hasPhone: false, hasEmail: false, hasVerifiedEmail: false, hasDirectEmail: false, hasDecisionMaker: false, hasLinkedin: false, hiring: false, websiteActive: false });
  assert.deepEqual([none.score, none.tier, none.breakdown.length], [0, 'cold', 0]);
  const all = computeFitScore({ categoryMatch: true, cityMatch: true, hasWebsite: true, hasPhone: true, hasEmail: true, hasVerifiedEmail: true, hasDirectEmail: true, hasDecisionMaker: true, hasLinkedin: true, hiring: true, websiteActive: true });
  assert.equal(all.score, 100);
  assert.equal(all.tier, 'hot');
  assert.equal(tierFor(59), 'warm');
  assert.equal(tierFor(29), 'cold');
});

test('provider (PDL) answers', () => {
  assert.deepEqual(parsePdlCompany({ status: 200, size: '11-50', founded: 2009, linkedin_url: 'linkedin.com/company/smile', industry: 'medical practice' }), {
    employeeRange: '11-50', foundedYear: 2009, linkedinUrl: 'https://www.linkedin.com/company/smile', industry: 'medical practice',
  });
  assert.equal(parsePdlCompany({ status: 404 }), null);
  assert.deepEqual(parsePdlPeople({ data: [{ full_name: 'ayesha malik', job_title: 'founder', linkedin_url: 'linkedin.com/in/ayesha', work_email: 'Ayesha@Smile.pk' }] }), [
    { fullName: 'Ayesha Malik', title: 'founder', linkedinUrl: 'https://www.linkedin.com/in/ayesha', workEmail: 'ayesha@smile.pk' },
  ]);
});

test('emails next to other elements are not glued to their text (real site: "info@x.comSend")', () => {
  // "Get in touch" + "info@..." + "Company" + "About" used to become "touchinfo@noviq.pkcompanyabout".
  const html = `<html><body><div><h3>Get in touch</h3><span>info@noviq.pk</span><span>Company</span><span>About</span></div>
    <p>hello@noviq.pk<button>Send</button></p><div><b>Email</b>contact@noviq.pk</div><li>careers@noviq.pk</li><li>Location</li><li>Lahore</li></body></html>`;
  const f = extractPage(html, 'https://noviq.pk/', 'contact');
  assert.deepEqual(f.emails.sort(), ['careers@noviq.pk', 'contact@noviq.pk', 'hello@noviq.pk', 'info@noviq.pk']);
});

// ── Focus ("IT companies" + "AI automation") ─────────────────────────────────

test('focus: taken out of a category phrase, split from a list, matched against what the website says', async () => {
  const { focusFromPhrase, matchFocus, splitFocusList } = await import('../leadgen/focus.js');
  const { resolveCategory } = await import('../leadgen/categories.js');
  const it = resolveCategory('IT companies working on AI automation')!;
  assert.equal(it.key, 'it_company');
  assert.equal(focusFromPhrase('IT companies working on AI automation', it), 'AI automation');
  assert.equal(focusFromPhrase('software houses that do chatbots', resolveCategory('software houses that do chatbots')), 'chatbots');
  assert.equal(focusFromPhrase('software houses', resolveCategory('software houses')), '');
  assert.equal(focusFromPhrase('IT companies jo app development pa kam krti hon', it), 'app development');
  assert.deepEqual(splitFocusList('AI automation, chatbots; RPA'), ['AI automation', 'chatbots', 'RPA']);
  assert.equal(matchFocus(['AI automation'], 'Noviq | We build AI-powered business automation for clinics'), 'AI automation');
  assert.equal(matchFocus(['AI automation'], 'Intelligent Automation & AI Solutions'), 'AI automation');
  assert.equal(matchFocus(['AI automation'], 'Web design and SEO agency'), null);
  assert.equal(matchFocus(['chatbots', 'AI automation'], 'Custom chatbot development'), 'chatbots');
  assert.equal(matchFocus([], 'anything'), null);
});

test('focus: page topics (title, meta keywords, h1-h3) are extracted; a match adds 20 points', async () => {
  const { computeFitScore } = await import('../leadgen/score.js');
  const f = extractPage(`<html><head><title>Noviq IT Solutions</title><meta name="keywords" content="AI automation, chatbots"></head>
    <body><h1>Automate your business with AI</h1><h2>Services</h2><h3>RPA</h3></body></html>`, 'https://noviq.pk/', 'home');
  assert.deepEqual(f.topics, ['Noviq IT Solutions', 'AI automation', 'chatbots', 'Automate your business with AI', 'Services', 'RPA']);
  const base = { categoryMatch: true, cityMatch: true, hasWebsite: false, hasPhone: false, hasEmail: false, hasVerifiedEmail: false, hasDirectEmail: false, hasDecisionMaker: false, hasLinkedin: false, hiring: false, websiteActive: false };
  const plain = computeFitScore(base);
  const focused = computeFitScore({ ...base, focusMatch: 'AI automation' });
  assert.equal(focused.score - plain.score, 20);
  assert.deepEqual(focused.breakdown[0], { key: 'focusMatch', label: 'Matches your focus: AI automation', points: 20 });
});
