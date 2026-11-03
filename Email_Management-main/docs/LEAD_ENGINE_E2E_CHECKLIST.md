# Lead Engine: manual end-to-end checklist

Run on staging with `LEADGEN_ENABLED=admin`, the worker running (`npm run worker:leadgen`) and an admin login. Tick each line; anything that fails blocks the release.

## Switch and access
- [ ] `LEADGEN_ENABLED=off`: Lead Finder page says "not switched on", chat answers "not switched on", `/api/lead-gen/searches` is 404.
- [ ] `admin`: admin sees the page and the Lead Engine Monitor; a normal user gets "not switched on".
- [ ] `on` + plan without `lead_gen_enabled`: the nav item is locked, the API says PLAN_FEATURE_REQUIRED, chat suggests upgrading.

## Web: Lead Finder
- [ ] Create "dental clinics" + "Lahore" + "Find leads now": toast, a "running" row under Recent runs, it ends `done` or `partial`.
- [ ] New leads appear with score, email/phone, status New; "New today" filter shows them.
- [ ] Open a lead: why this score, emails with "mail domain OK / no mail server", where each field came from (OSM / website, page, days ago).
- [ ] Select 2 leads → Save to CRM: they show "In CRM" and appear on the CRM page; a lead without email is reported as skipped.
- [ ] Select leads → Add to campaign: only draft/paused campaigns are offered; recipients are added, the campaign does not start.
- [ ] Reject a lead: it disappears and does not come back on the next run.
- [ ] Run a search with "Run daily at 09:00": it appears on Searches and schedules with the next run time.

## Web: Searches and schedules
- [ ] Change time / days; next run updates. Pause → "Paused"; Resume → next run in the future.
- [ ] Run now twice while two runs are going: the third answers "2 lead searches running".
- [ ] Delete a search: its leads stay in the Lead Finder.

## Chat
- [ ] "Lahore ke dental clinics dhundo, owners bhi" → search saved and started.
- [ ] "find dentists in Lahore" without city/category variants → asks "Kis shehar mein?" / "What kind of businesses?".
- [ ] "find real estate agencies in Dubai daily at 9" → one approval card (what, when, timezone) → Confirm → scheduled.
- [ ] "isay roz subah 9 baje chalao" right after a search → approval names that search.
- [ ] "mere schedules dikhao", "Lahore wala schedule band kar do", "aaj kitni nayi leads aayi?" work.
- [ ] After a lead list: "inhein campaign <id> mein daal do" → approval → added; "hot leads CRM mein daal do" → saved.
- [ ] "show hot leads" still shows CRM hot leads.
- [ ] During the AI campaign wizard: "find dentists in Lahore" → "finish it first" message; the wizard continues.

## Schedule and pipeline
- [ ] A schedule due now creates exactly one run, also with two workers running.
- [ ] Kill a worker in the middle of a run (Ctrl+C twice / kill -9): another worker finishes the tasks after 5 minutes.
- [ ] Next day: the schedule's run gives only businesses not seen the day before.
- [ ] With a SERP key set: search discovery and LinkedIn company pages appear; without it, the Monitor shows ddg / search_linkedin blocked or skipped, runs end `partial`, OSM + websites still work.
- [ ] Bell: "<search>: N new leads today" after a run.

## Admin monitor
- [ ] Runs today, queue, per-source requests / blocks / success, common errors, recent runs load.
- [ ] Turn a source off: new runs skip it. Clear a cooldown. Change a daily cap.
- [ ] "Start nightly refresh now" starts one refresh run; a second click says it already exists.

## Compliance
- [ ] `POST /api/lead-gen/privacy/requests {"email": ...}` → confirmation email with a link; the link removes the data and says so; opening it again says "not valid".
- [ ] After that, the next run does not bring the email back; it is on the suppression list.
- [ ] A LinkedIn URL / domain request shows in the Monitor; Process with the identifier erases it.
- [ ] A campaign unsubscribe adds the address to `do_not_collect`.

## Release
- [ ] `npm run leadgen:check` passes on the target database.
- [ ] All test suites green (backend `test:leadgen`, `test:leadgen:db` on a throwaway DB, MCP and agent `vitest`).
- [ ] `LEADGEN_ENABLED=admin` on backend + worker; plans updated only when opening to users.
