# Lead Engine: field coverage on real data

Measured 2026-10-29 with `scripts/leadgenCoverage.ts` (target 100 leads per niche, 6 tasks at once).
Sources: OpenStreetMap (Nominatim + Overpass) and the companies' own websites (robots.txt respected, 1 request / 2 s per host, max 8 pages).
Search engines were **off**: DuckDuckGo answers our identifying bot User-Agent with a CAPTCHA page on the first request, and no SERP API key was set.
So the search-based discovery and LinkedIn-from-search-results columns are not measured here.

| Field | Dental clinics, Lahore | Real estate agencies, Dubai | Law firms, London |
|---|---:|---:|---:|
| Businesses found by OSM | 11 | 74 | 200 |
| New leads | 10 | 72 | 100 |
| Run status / time | done / 0s | done / 156s | done / 19s |
| Website known | 20% | 44% | 98% |
| Website reachable and crawled | 20% | 25% | 75% |
| Any email | 30% | 39% | 75% |
| Email domain with MX | 20% | 35% | 71% |
| Direct (not info@) email | 30% | 15% | 39% |
| Phone | 50% | 46% | 93% |
| WhatsApp | 10% | 8% | 4% |
| LinkedIn company page (from website) | 10% | 19% | 39% |
| Facebook / Instagram | 30% | 25% | 34% |
| A person (team page / JSON-LD) | 20% | 6% | 31% |
| Decision maker (owner / C-level / director) | 20% | 3% | 22% |
| Tech signals | 20% | 21% | 62% |
| Careers page | 10% | 11% | 32% |
| Description | 10% | 19% | 55% |
| Average fit score | 43 | 42 | 66 |
| Hot / warm / cold | 2 / 3 / 5 | 21 / 14 / 37 | 65 / 35 / 0 |

Percentages are of the new leads of that niche.

## Tasks

| Task | Status | Count |
|---|---|---:|
| discover | done | 3 |
| fetch_site | done | 57 |

## Most common task errors

- none

## Sites that were crawled but gave no email (sample, for extractor fixes)

- dentist / Lahore: none
- real_estate / Dubai: brookfieldproperties.com
- lawyer / London: retrogamebase.co.uk, prolegal.co.uk, streetermarshall.com, adukussolicitors.com, wtlawllp.co.uk, sherperd.co.uk, mlclaw.co.uk, nwlawwoodford.com

## Findings and fixes from this run

**Run times.** This report is from the second run on the same database. Companies crawled less than 30 days before were not crawled again (the refresh rule), so Lahore (0 s) and London (19 s) are faster than a first run. The first London run took 238 s for 200 businesses and 100 crawled sites at 10 tasks at once. Dubai (156 s) was crawled for the first time here.

**Fixed after the first run:**
- **Dubai gave 0 businesses.** Nominatim returns the whole emirate for "Dubai". The 1° box around its bbox centre lay in the desert, and Overpass timed out on it. Now the box is 0.5° around Nominatim's own point (the city centre), and Overpass gets 90 s. Result: 74 businesses, 72 new leads. Regression test in `leadgenCollectors.test.ts`.
- **The coverage script stopped waiting** while a task still had a retry scheduled (1 / 5 / 30 min backoff). It now waits up to 40 minutes.
- **Team grid as a card** (found with fixtures on Day 2): one person got another person's email. Fixed before this run.

**Why the crawled London sites without an email had none** (8 sites checked by hand). None of them is an extractor bug:
- 3 sites (`streetermarshall.com`, `nwlawwoodford.com`, `wtlawllp.co.uk`) are a bot-challenge page (HTTP 202) or are rendered by JavaScript (6-90 KB of HTML, no links or text). We do not run a headless browser and we do not bypass challenges.
- 1 site (`adukussolicitors.com`) has only a contact form. Its "email encoder" plugin is loaded, but no email is on the page.
- 1 site (`mlclaw.co.uk`) shows only the placeholder `you@company.com`, which is correctly rejected as junk.
- 1 domain (`prolegal.co.uk`) no longer resolves in DNS, and 1 (`sherperd.co.uk`) is a 114-byte placeholder page.
- 1 domain (`retrogamebase.co.uk`) is a wrong website tag in OpenStreetMap: a games site tagged on a law firm.

**What limits coverage most:**
1. **OSM density.** Lahore has only 11 named dental clinics in OSM (London law firms: 200+). Cities like Lahore need the search discovery source, which needs a SERP API key (`LEADGEN_SERP_API_KEY`), because DuckDuckGo blocks our honest bot User-Agent.
2. **Websites in OSM.** 20% (Lahore), 44% (Dubai) and 98% (London) of the businesses have a website tag. Emails, people, LinkedIn and tech come mostly from websites.
3. **Dead or blocked sites.** 14 of the 32 crawled Dubai sites were down or refused us (`sites_down`). In London, about 25 of the 98 sites with a website failed. They were crawled again in this run (a failed crawl is not "fresh"), and 23 of those 25 were still down.
4. **Decision makers** come from team pages only in this run (Dubai 3%, London 22%). LinkedIn from search results and the paid provider (`LEADGEN_PDL_API_KEY`) are the next levers and were not active.

**Proposal estimates replaced** (measured, OSM + websites only):

| Field | Lahore dentists | Dubai real estate | London law firms |
|---|---:|---:|---:|
| Email | 30% | 39% | 75% |
| Phone | 50% | 46% | 93% |
| Decision maker | 20% | 3% | 22% |

Measure again with a SERP API key before launch: search discovery should raise the business count in Lahore and Dubai, and LinkedIn from search results should raise decision makers.
