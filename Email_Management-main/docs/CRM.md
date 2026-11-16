# CRM module

The CRM turns every campaign recipient into a **lead** and moves leads through a **pipeline** by itself, based on what happens to your emails: sent, opened, replied, bounced, unsubscribed.

Everything is per user. One user never sees or changes another user's leads, pipelines, tags or rules. All `/api/crm/*` and `/api/tags` routes need a login and a plan with CRM switched on (admins and users without a plan always have it).

## How it fits together

```
send / open / webhook / IMAP reply / unsubscribe
        │  (returns at once, never slowed down)
        ▼
CRM background queue (max 3 jobs at a time)
        │
        ├─ reply labeling  ──► label on the reply (🟢🔴🟡🔵🟣⚪⚫)
        ▼
CRM event ──► rule engine ──► move stage, tags, stop follow-ups, notify, score
                   │
                   └─► lead score recalculated, "needs reply" updated

CRM worker (npm run dev): planned follow-ups every minute, reminders every 15 min,
time rules + old scores every 30 min
```

| Part | Code |
|---|---|
| Tables | `crm_*` in `backend/src/db/schema.ts`, migrations `backend/drizzle/0031` … `0036` |
| Events | `lib/crm/events.ts`, `lib/crm/emit.ts`, queue `lib/crm/backgroundQueue.ts` |
| Rules | `lib/crm/ruleEngine.ts`, `conditions.ts`, `movePolicy.ts`, `ruleValidation.ts` |
| Labels | `lib/replyLabeling.ts`, `lib/crm/labelReply.ts` |
| Reminders | `lib/crm/needsReply.ts` |
| Scoring | `lib/crm/leadScoring.ts` |
| Worker | `workers/crmWorker.ts` |
| Pages | `/crm` (dashboard), `/crm/pipelines`, Inbox → Needs reply, Settings → CRM |

## Pipelines

A pipeline is a list of **stages**. Each user gets a default **Sales Pipeline**:

New Lead → Contacted → Engaged → Replied → Interested → Meeting Booked → Won / Lost

- **Stage types:** `normal`, `won` or `lost`. Won and Lost are final: rules never move a lead out of them. You still can, by hand.
- **Stop follow-ups:** when a lead sits in a stage with this on (Interested, Meeting Booked, Won and Lost by default), bulk follow-up jobs skip it.
- **Manual only:** rules never move a lead into or out of this stage.
- **Templates:** Sales Outreach, Simple and Recruiting. Build or edit pipelines in the Pipeline Builder (`/crm/pipelines`).
- **Default pipeline:** one per user. A campaign can send its new leads to a different pipeline and add tags to them automatically (campaign page → CRM settings).
- **Moving leads by hand:** drag a card on the board, or use the table, the lead drawer or "Move to…" on phones. Every move is saved in the stage history.

## Rules

A rule is **WHEN** (trigger) + **IF** (conditions) + **THEN** (actions). Each rule belongs to one pipeline and can be limited to leads in one stage ("from stage").

- **Triggers:**
  - `email_sent`, `email_delivered`, `email_opened`
  - `reply_received`, `reply_labeled`
  - `bounced`, `unsubscribed`
  - `follow_up_sent`
  - `manual_move`
  - `time_tick` (every 30 minutes)
- **Condition fields:**
  - `reply_label`, `reply_count`, `open_count`, `follow_up_count`
  - `days_since_last_outbound`, `days_since_last_reply`, `days_in_stage`
  - `reply_text_contains`, `has_tag`, `score`, `campaign_id`, `current_stage`
  - `custom_field.<name>`
- **Operators:** `equals`, `not_equals`, `gt`, `gte`, `lt`, `lte`, `contains`, `not_contains`, `in`, `exists`. Conditions can be grouped with AND / OR (nested up to 5 levels deep).
- **Actions:** `move_to_stage`, `add_tag`, `remove_tag`, `stop_follow_ups`, `schedule_follow_up`, `notify_user`, `add_score`.

**Order:** the rules of the lead's pipeline run highest priority first. Every matching rule runs its other actions. The first matching rule whose move is allowed moves the lead. With **forward only** (the default), a rule only moves a lead to a later stage; Won and Lost are always allowed.

**Default rules:**

| Rule | What it does |
|---|---|
| Email sent | moves the lead to Contacted |
| Opened 2+ times | moves the lead to Engaged |
| Real reply (not an auto-reply) | moves the lead to Replied |
| Interested | moves the lead to Interested, stops follow-ups and notifies you |
| Meeting booked | moves the lead to Meeting Booked |
| Not interested / unsubscribe | moves the lead to Lost and stops follow-ups |
| Out of office | plans a follow-up in 7 days |
| 3 follow-ups, no reply, 5 days | moves the lead to Lost |

**Loop safety:**

- Actions never create new events, so one event cannot set off another.
- A lead moves at most 3 times per event.
- Events that repeat on their own are limited:
  - `time_tick` runs `notify_user` and `add_score` only once while the lead stays in a stage.
  - `schedule_follow_up` runs once per rule while the lead stays in a stage, and plans at most 5 follow-ups per lead in total. So "follow-up sent → plan a follow-up" can never email a lead forever.
- Notifications for the same lead and rule are also never repeated within 10 minutes.

**Test a rule:** Pipeline Builder → **Test rules** runs the rules against a real lead without changing anything.

**Emergency switch:** `CRM_RULES_DISABLED=true` in `backend/.env` stops all rules. Scores still update.

## Reply labels

Every inbound reply gets one label, in the background after it is saved (saving never waits for it):

| | Label | Meaning |
|---|---|---|
| 🟢 | Interested | wants to talk or know more |
| 🔴 | Not Interested | says no |
| 🟡 | Out of Office | automatic away reply |
| 🔵 | Question | asks something, no clear yes or no |
| 🟣 | Meeting Booked | a call or meeting is set |
| ⚪ | Neutral | none of the above |
| ⚫ | Bounce / Unsubscribe | delivery failure, or "remove me" |

**How a label is chosen:**

1. Auto-reply headers and out-of-office subjects or text give Out of Office.
2. Mailer-daemon senders and "unsubscribe / remove me" give Bounce / Unsubscribe.
3. Otherwise keywords decide. Quoted history is ignored.
4. With `AI_LABELING_API_KEY` set (any OpenAI-compatible API; also `AI_LABELING_BASE_URL` and `AI_LABELING_MODEL`), unclear replies are asked to the AI. If the AI fails, the keyword label is kept.

You can change a label in the Inbox or in the lead drawer. That is saved as `manual`, and the rules run again (`reply_labeled`).

The Inbox shows the label of each thread. It can filter by label, and shows Interested threads first.

**Old replies:** to label replies you had before the CRM, run `POST /api/crm/relabel` (or `scripts/crmRelabel.ts`).

## Needs-reply reminders

- A lead **needs a reply** when its newest real reply is newer than your last message to it.
- It stops needing one when:
  - you answer from the Inbox
  - you click **Done**
  - the lead is snoozed (it comes back after the snooze)
- **Where it shows:** Inbox → **Needs reply** tab, the dashboard KPI, the red "waiting 5h" on cards, and the 🔔 bell.
- **Reminder timing:** after `needs_reply_after_hours` (default 24, Settings → CRM). Interested and Question leads are reminded after half that time.
- **Daily digest email:** optional, Settings → CRM. It is sent from `CRM_DIGEST_HOUR` (default 8, server time) through your own SMTP settings.
- Old replies from before step 6 never create reminders.

## Lead scoring

Each lead has a score from **0 to 100** and a tier: **🔥 Hot ≥ 70**, **Warm ≥ 40**, **Cold** below 40. You can change the thresholds and all weights in Settings → Lead scoring.

| Points | For |
|---|---|
| +5 | each open, at most +15 |
| +20 | the lead replied |
| +50 | latest label Meeting Booked |
| +40 | latest label Interested |
| +25 | latest label Question |
| +5 | latest label Neutral |
| 0 | latest label Out of Office |
| −50 | latest label Not Interested |
| −100 | latest label Bounce / Unsubscribe |
| −5 | each follow-up with no reply |
| −10 | every 14 days with no activity |
| your own | per tag and per custom-field value |
| your own | the `add_score` rule action |

- **When it is calculated:** after every event, and after every tag change.
- **Background refresh:** the worker recalculates scores older than 12 hours, so "no activity" counts even when nothing happens.
- **Why this score:** the lead drawer shows the parts of the score and the history of changes.
- **After changing weights:** use **Recalculate all** (it runs in batches of 200).

## Dashboard (`/crm`)

The page has:

- filters (kept in the URL)
- KPI tiles
- a board you can drag cards on, or a table with bulk move / tag and CSV export
- the funnel
- Hot leads
- the lead drawer, with the timeline, label change, tags, score and Reply

The list, the KPIs and the CSV all use the same filters, from `lib/crm/contactFilters.ts`.

## Running it

```bash
cd backend
npx tsx scripts/run-crm-migration.ts   # all CRM migrations, safe to run again (take a backup first)
npx tsx scripts/crmCheck.ts            # read-only health check: PASS / WARN / FAIL per step
npm run test:crm                       # all CRM unit tests (no database needed)
npm run dev                            # API + email worker + CRM worker
```

**Rollback:** `npx tsx scripts/run-crm-migration.ts --rollback-step9` (or `--rollback-step7`, `--rollback-step6`, `--rollback-step5`, `--rollback-step3`, `--rollback`). Each removes that step and every later one.

**Settings (`backend/.env`, all optional):**

| Variable | Default | |
|---|---|---|
| `CRM_TICK_MINUTES` | 30 | how often time rules run |
| `CRM_REMINDER_MINUTES` | 15 | how often reminders are checked |
| `CRM_DIGEST_HOUR` | 8 | hour of the daily digest (server time) |
| `CRM_BACKGROUND_CONCURRENCY` | 3 | CRM jobs at the same time (1–8). Keep it well below the DB pool size (pg default 10) |
| `CRM_RULES_DISABLED` | off | `true` stops all rules |
| `CRM_LOG_MOVES` | off | log every rule move |
| `AI_LABELING_API_KEY` | none | turns on AI labels |

## Performance

Tested with 50 000 leads per user (100 000 leads, 100 000 replies and 400 000 score events in the database):

- **CRM pages:** every CRM API call answers in under 300 ms. Most answer in under 30 ms.
- **Saving replies:** 500 replies arriving in one IMAP poll are saved in 1.6 s. The CRM finishes labeling and moving them about 8 s later, using at most 3 database connections, while other queries stay fast.
- **Indexes:** migration `0036_crm_indexes.sql` adds three:
  - one for threads in `email_replies`
  - one for replies per recipient in `email_replies`
  - one for the default sort of the CRM table

  The Inbox list went from 90 s to about 1.3 s with them.
