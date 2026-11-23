/** AI first lines (pure): website, page summary, grounded line check, custom fields. Run: npx tsx --test <file> */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailTopicOf,
  fallbackLine,
  hasContent,
  isBlockedPage,
  parseFirstLine,
  summarizePage,
  websiteFor,
  withFirstLine,
} from '../core.js';

test('website: column first, else a company email domain; free mail and social links give none', () => {
  assert.equal(websiteFor({ Website: 'acme.io' }, 'a@gmail.com'), 'https://acme.io');
  assert.equal(websiteFor({ url: 'https://www.acme.io/about' }, 'a@x.com'), 'https://www.acme.io/about');
  assert.equal(websiteFor({}, 'ali@brightdental.co.uk'), 'https://brightdental.co.uk');
  assert.equal(websiteFor({}, 'ali@gmail.com'), null);
  assert.equal(websiteFor({ website: 'https://linkedin.com/company/acme' }, 'a@gmail.com'), null);
  assert.equal(websiteFor({ website: 'not a site' }, 'a@gmail.com'), null);
});

const HTML = `<html><head><title>BrightDental | Family dentist in Leeds</title>
<meta name="description" content="Family dental clinic in Leeds offering same-day crowns and Invisalign."></head>
<body><nav>Home About</nav><h1>Same-day crowns in Leeds</h1><h2>New: evening appointments until 9pm</h2>
<p>We opened our second clinic in Headingley this spring, with three new chairs for families.</p>
<script>var x = "ignore me";</script><footer>© 2026</footer></body></html>`;

test('page summary: title, description, headings, paragraphs (no scripts, nav, footer)', () => {
  const p = summarizePage(HTML);
  assert.match(p.title, /BrightDental/);
  assert.match(p.description, /same-day crowns/);
  assert.ok(p.headings.includes('New: evening appointments until 9pm'));
  assert.match(p.text, /second clinic in Headingley/);
  assert.doesNotMatch(p.text, /ignore me|©/);
  assert.equal(hasContent(p), true);
  assert.equal(isBlockedPage(p), false);
  assert.equal(isBlockedPage(summarizePage('<title>Just a moment...</title><p>Checking your browser before accessing the site now.</p>')), true);
});

test('line must be grounded in the website', () => {
  const page = summarizePage(HTML);
  const good = parseFirstLine(JSON.stringify({ line: 'Saw that BrightDental opened a second clinic in Headingley this spring', fact: 'opened our second clinic in Headingley' }), page);
  assert.deepEqual(good, { ok: true, line: 'Saw that BrightDental opened a second clinic in Headingley this spring.' });
  // Invented fact (not on the page) → rejected.
  assert.equal(parseFirstLine(JSON.stringify({ line: 'Congrats on winning the national dental award this year', fact: 'won the national award' }), page).ok, false);
  // Fact is real but the line does not use it.
  assert.equal(parseFirstLine(JSON.stringify({ line: 'Hope your week is going really well so far', fact: 'second clinic in Headingley' }), page).ok, false);
  // Placeholders, links, greetings, empty.
  assert.equal(parseFirstLine(JSON.stringify({ line: 'Saw {company} opened a clinic in Headingley recently', fact: 'clinic in Headingley' }), page).ok, false);
  assert.equal(parseFirstLine(JSON.stringify({ line: 'Hi Ali, saw your new clinic in Headingley this spring', fact: 'clinic in Headingley' }), page).ok, false);
  assert.equal(parseFirstLine(JSON.stringify({ line: 'Saw your clinic in Headingley at https://x.io recently', fact: 'clinic in Headingley' }), page).ok, false);
  assert.equal(parseFirstLine(JSON.stringify({ line: '', fact: '' }), page).ok, false);
  assert.equal(parseFirstLine(null, page).ok, false);
});

test('fallback line, custom fields kept, email topic', () => {
  assert.equal(fallbackLine('Acme'), 'I came across Acme and wanted to reach out.');
  assert.equal(fallbackLine(''), '');
  const json = withFirstLine(JSON.stringify({ company: 'Acme', first_name: 'Ali' }), 'Line.', 'website')!;
  assert.deepEqual(JSON.parse(json), { company: 'Acme', first_name: 'Ali', first_line: 'Line.', first_line_source: 'website' });
  assert.deepEqual(JSON.parse(withFirstLine('broken json', 'L', 'manual')!), { first_line: 'L', first_line_source: 'manual' });
  assert.equal(withFirstLine(JSON.stringify({ big: 'x'.repeat(4990) }), 'Line', 'website'), null, 'does not overflow the column');
  assert.equal(emailTopicOf('<p>Hi {first_name},</p><p>{first_line}</p><p>We build sites.</p>'), 'Hi {first_name}, We build sites.');
});
