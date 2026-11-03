# Lead Engine (Lead Finder)

The Lead Engine finds new businesses for a user's target customers (ICP), every day if the user wants: "dental clinics in Lahore, owners too, daily at 9". It reads OpenStreetMap, search results and the companies' own websites, keeps everything in one shared master database with the source of every fact, joins duplicates, scores each lead, and gives each user **only leads that user has not seen before**.

Design and decisions: *Lead Engine Use Case Document v1.0* and *Lead Engine: Full Feature in 3 Days*.

## Release switch

| `LEADGEN_ENABLED` | Who can use it |
|---|---|
| `off` (default) | Nobody. `/api/lead-gen/*` answers 404 and the worker idles. |
| `admin` | Admins and super admins only (release step). |
| `on` | Admins + users whose plan has `plans.lead_gen_enabled`. Others get 403 `PLAN_FEATURE_REQUIRED`. |

Legacy users (no subscription) do **not** get the Lead Finder automatically, unlike the CRM.

## How it fits together

```
chat ("Lahore ke dental clinics dhundo") / Lead Finder page
        │
        ▼
saved_searches (+ search_schedules)            leadGenWorker (npm run worker:leadgen, any number of processes)
        │                                        every minute: due schedules -> scrape_runs (1 per schedule per day)
        ▼                                                      queued runs -> running (max 2 per user, daily quota)
scrape_runs ──► scrape_tasks queue ──────────►  every 5 s: claim tasks (FOR UPDATE SKIP LOCKED) and run them
                  discover      OSM / search -> businesses -> companies (dedupe) -> NEW workspace_leads
                  fetch_site    website crawl (max 8 pages) -> emails, phones, socials, team, tech, careers
                  find_social   LinkedIn company page / decision makers from search results only
                  verify_email  MX check (nightly refresh)
                  provider_enrich  licensed provider (PDL) for hot leads, if configured
        │
        ▼
master data (companies, people, contact_points, social_profiles, employments, web_pages, observations)
workspace_leads (per user) ──► Lead Finder page / chat ──► Save to CRM / Add to campaign
01:00-05:00: nightly refresh run · once a day: data minimization purge
```

| Part | Code |
|---|---|
| Tables (19) | `backend/drizzle/0037_lead_engine.sql` (+ rollback), `backend/src/db/schema.ts` "Lead Engine" block |
| Contracts | `backend/src/lib/leadgen/types.ts` (sources, tasks, API shapes); MCP mirror `mailflow-mcp-server/src/types/leadgen.ts` |
| Fetching | `lib/leadgen/http.ts` (SSRF guard, 10 s, 1 MB, 5 redirects), `robots.ts`, `rateLimiter.ts`, `fetchPage.ts` |
| Sources | `lib/leadgen/sources/osm.ts`, `sources/search.ts` (DuckDuckGo, SerpApi, DataForSEO), `sources/index.ts` |
| Website | `lib/leadgen/crawler.ts`, `extract.ts` |
| LinkedIn / provider | `lib/leadgen/linkedin.ts` (search results only), `provider.ts` (People Data Labs) |
| Resolution | `lib/leadgen/resolve.ts` (match, merge, people, job change, scoring, new leads), `score.ts`, `verify.ts`, `normalize.ts` |
| Pipeline | `lib/leadgen/scheduler.ts`, `taskQueue.ts`, `taskHandlers.ts`, `refresh.ts`, `workers/leadGenWorker.ts` |
| User side | `lib/leadgen/workspace.ts`, `controllers/leadGenController.ts`, `routers/leadGenRouter.ts` |
| Compliance / admin | `lib/leadgen/compliance.ts`, `controllers/leadGenAdminController.ts` |
| Web | `web/src/pages/LeadFinder.tsx`, `LeadSchedules.tsx`, `AdminLeadGen.tsx` |
| Chat | agent `LeadGenAgent`, `lib/leadgenArgs.ts`, `leadgenContext.ts`, `leadgenFormatters.ts`; MCP `mcp/tools/leadgen/` |

## Setup

```bash
cd Email_Management-main/backend
npx tsx scripts/run-crm-migration.ts       # once, if the CRM tables are missing (workspace_leads references crm_contacts)
npm run leadgen:migrate                    # migration 0037 (safe to run again); --rollback drops all 19 tables
npm run leadgen:check                      # database matches schema.ts, sources seeded
npm run worker:leadgen                     # the worker; run more processes to go faster
```

Then set `LEADGEN_ENABLED=admin` (backend and worker) and give plans `lead_gen_enabled = true` when releasing to users.

### Environment

| Variable | Notes |
|---|---|
| `LEADGEN_ENABLED` | `off` / `admin` / `on` (see above) |
| `LEADGEN_USER_AGENT` | Sent with every request; must identify the bot (Nominatim policy) |
| `LEADGEN_CONTACT_EMAIL` | Sent to Nominatim as `email` |
| `LEADGEN_SERP_PROVIDER` / `LEADGEN_SERP_API_KEY` | `serpapi` (key) or `dataforseo` (`login:password`). **Needed for search discovery and LinkedIn**: DuckDuckGo shows a CAPTCHA to our honest bot User-Agent on the first request. We never bypass it. |
| `LEADGEN_PDL_API_KEY` | Optional licensed provider (hot leads only). The `pdl` source must also be enabled by an admin. |
| `LEADGEN_WORKER_CONCURRENCY` | Tasks at once per worker process (default 4) |
| `LEADGEN_REFRESH_BATCH` | Companies refreshed per night (default 500) |
| `LEADGEN_NOMINATIM_URL`, `LEADGEN_OVERPASS_URL` | Self-hosted OSM endpoints for higher volume |
| `PUBLIC_API_URL` | Base URL of the privacy confirmation link (falls back to `TRACKING_BASE_URL`) |

## Rules worth knowing

- **Only new leads.** `workspace_leads` is unique per (user, company, person). A rejected lead never comes back.
- **One run per schedule per day.** `UNIQUE(schedule_id, run_date)` + `FOR UPDATE SKIP LOCKED`. A server that was down gets one run, not a backlog. Runs start 0-10 minutes after the time (jitter), never past local midnight.
- **Quotas.** `plans.lead_gen_daily_limit` new leads per day (user timezone), 10 active searches, 2 runs at once. A run that hits the limit ends `partial`.
- **Failures.** Tasks retry 3 times (1, 5, 30 minutes). A worker that stops sending heartbeats loses its tasks after 5 minutes. 3 failed runs in a row pause the schedule and ring the bell.
- **Blocks.** 429 / 403 / CAPTCHA put the source on a 1-hour cooldown (the rest of the day after 20 blocks, admins get a bell); its tasks are skipped and the run ends `partial`.
- **Dedupe.** Match order: domain, LinkedIn URL, same source id, name + city + phone, name + city + same spot. Two stored records that turn out to be one are merged in one transaction (`entity_merges`); the better workspace status survives.
- **LinkedIn.** Only links on the company's own site and search engine results. `linkedin.com` is never requested. A name that matches several different profiles is not saved.
- **Emails.** No guessing (no first.last@). Junk (noreply, example.com, `logo@2x.png`, hashes) is dropped. MX check, no SMTP ping. Campaigns only get MX-valid emails.
- **Provenance.** Every fact is an `observations` row (source, URL, run, confidence); the lead detail shows "where this came from". Raw HTML is never stored, only a hash per page.
- **Compliance (UC-12).** `POST /api/lead-gen/privacy/requests` (public) stores only a hash; email requests get a one-time link, LinkedIn/domain requests go to an admin. Erasure deletes the person / company everywhere, puts the email on `suppression_list` and the hash on `do_not_collect`, which every collector checks. A campaign unsubscribe also lands in `do_not_collect`.
- **Refresh and minimization.** Websites every 30 days (14 for hot leads), emails 90, people 60 (job change alerts to users who have the person in their CRM). Observations are purged after 180 days, unused records after 365.

## API (`/api/lead-gen`, login + switch + plan)

| Method | Path | |
|---|---|---|
| GET | `/usage`, `/categories` | quota numbers, category list |
| GET / POST | `/searches` | list (with schedule) / create (`category` words are mapped; no match = keyword search) |
| PATCH / DELETE | `/searches/:id` | rename, people, per run, active / delete (leads stay) |
| POST | `/searches/:id/run` | run now (429 when 2 runs are going or the quota is used) |
| POST | `/searches/:id/schedule` | create or replace the one schedule (`runAtLocal`, `timezone`, `frequency`, `weekdays`) |
| GET / PATCH / DELETE | `/schedules`, `/schedules/:id` | list / pause, resume, new time / delete |
| GET | `/runs`, `/runs/:id`; POST `/runs/:id/cancel` | runs of the user |
| GET | `/leads`, `/leads/:id` | filters `savedSearchId, foundToday, tier, status, hasEmail, hasDecisionMaker, q`; detail with field sources |
| POST | `/leads/reject`, `/leads/review`, `/leads/save-to-crm`, `/leads/add-to-campaign` | `{ leadIds }` (+ `campaignId`: draft or paused only) |

Admin (`admin` / `super_admin`): `GET /api/admin/lead-gen/overview`, `PATCH /api/admin/lead-gen/sources/:id`, `POST /api/admin/lead-gen/refresh`, `GET /api/admin/lead-gen/privacy`, `POST /api/admin/lead-gen/privacy/:id/process`.

## Chat

| User says | Intent | Tool | Approval |
|---|---|---|---|
| "Lahore ke dental clinics dhundo, owners bhi" | `generate_leads` | `create_saved_search` (runs now) | no |
| "find dentists in Lahore daily at 9" | `generate_leads` → `schedule_lead_search` | `create_search_schedule { newSearch }` | yes, one step |
| "isay roz subah 9 baje chalao" | `schedule_lead_search` | `create_search_schedule` (last search) | yes |
| "run it now" / "isay abhi chalao" | `run_lead_search` | `run_saved_search` | no |
| "mere schedules dikhao" / "Lahore wala band karo" | `list_lead_schedules` / `pause_lead_schedule` | `list_search_schedules` / `update_search_schedule` | no |
| "aaj kitni nayi leads aayi?" | `show_new_leads` | `list_workspace_leads` | no |
| "hot leads CRM mein daal do" | `save_leads_to_crm` | `save_leads_to_crm` | no |
| "inhein campaign 22 mein daal do" | `add_leads_to_campaign` | `add_leads_to_campaign` (leads shown last) | yes |
| "lead search status" | `lead_run_status` | `get_lead_run` | no |

"show hot leads" alone stays the CRM's hot leads. The arguments come from the same `classifyIntent` call (no extra OpenAI call), with a message parser for English and Roman Urdu when OpenAI is off. A lead-finder request while a bulk / enrichment / campaign flow waits for an answer gets the "finish it first" reply and leaves that flow alone.

## Tests

```bash
npm run test:leadgen                                                     # offline: fetch guard, robots, parsers, extractor, crawler, LinkedIn, scoring
LEADGEN_TEST_DATABASE_URL=postgres://.../throwaway npm run test:leadgen:db  # queue, scheduler, API, pipeline, merge, CRM, campaign, opt-out, refresh
```

The DB tests truncate the lead engine tables: use a throwaway database (a copy of the schema + `npm run leadgen:migrate`). Real-data coverage: `scripts/leadgenCoverage.ts`, results in [lead-engine-coverage.md](lead-engine-coverage.md). Manual checklist: [LEAD_ENGINE_E2E_CHECKLIST.md](LEAD_ENGINE_E2E_CHECKLIST.md).

Not legal advice: get the LinkedIn / people-data part reviewed by a lawyer before a public launch, especially for EU targets.
