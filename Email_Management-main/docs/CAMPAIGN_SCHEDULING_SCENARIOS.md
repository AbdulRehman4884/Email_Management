# Email Campaign Scheduling — Scenario Reference

**Product:** MailFlow Email Campaign Management System  
**Audience:** QA, support, and end users  
**Timezone:** All schedule logic uses the **server schedule timezone** (`DB_TIMEZONE` / `SCHEDULE_TZ`, default: `Asia/Karachi`), not the browser timezone.

**Critical prerequisite:** Background **email worker** must be running (`bun run worker` in `Email_Management-main/backend`). Without the worker, **no automatic start, pause, or resume** occurs—only manual **Start** / **Resume**.

---

## 1. Features Overview

| # | UI Setting | What it controls |
|---|------------|------------------|
| A | **Schedule for later** | First send time; also used as daily resume clock when set |
| B | **Spread sends (daily limit)** | Max emails per campaign per calendar day |
| C | **Send only during daily time window** | Send only between start/end times (e.g. 9 AM–5 PM) |
| D | **Auto-pause (date/time or duration)** | Pause at a fixed time or after X minutes of sending |
| E | **Only send on selected weekdays** | Send only on selected days (Mon–Sun, ISO 1–7) |
| F | **SMTP daily limit** (Settings, not campaign screen) | Account-wide cap (default **50**/day; **empty** = unlimited; **0** = block all sending) |

**Priority when multiple limits apply:** The campaign stops when **any** applicable rule blocks sending (whichever limit or rule is hit first).

---

## 2. Global Rules (Always Apply)

| Rule | Behavior |
|------|----------|
| Worker OFF | No auto-start, auto-pause, or auto-resume; user must use Start/Resume |
| Worker ON | Poll loop ~every 2 seconds handles scheduling |
| Manual **Pause** | Clears auto-pause reason; **never** auto-resumes |
| Manual **Resume** | Blocked if SMTP quota exhausted; blocked if outside send window (when window is set) |
| `pauseReason` values | `smtp_daily_limit`, `daily_campaign_cap`, `weekday_filter`, `send_window_closed` → can auto-resume; `null` (manual/timed pause) → manual Resume only |
| Auto-resume (quota/weekday) | Requires **next calendar day** after `pausedAt` (except send window—see section 3.3) |
| Auto-resume clock | **Schedule date/time** if set; otherwise default **09:00:00** server time |
| Create campaign | Schedule ON → date required; Daily spread ON → number required; Auto-pause ON → time or duration required |
| Send window on **Create** | Saved only if **Schedule for later** is also ON; on **Edit**, window can be saved independently |

---

## 3. Single Feature ON (All Others OFF)

### 3.1 Only **Schedule for later** (A ON)

| When | What happens |
|------|----------------|
| Before `scheduledAt` | Status `scheduled` or `in_progress` but worker **does not send** until time reached |
| At/after `scheduledAt` | Worker sets/keeps `in_progress` and **starts sending** |
| User clicks Start early | Queued until schedule time (message: sending begins at scheduled time) |
| Resume time next days | Uses **time from `scheduledAt`** for daily auto-resume checks |

---

### 3.2 Only **Spread sends / daily limit** (B ON)

*Note: On Create UI, daily spread is tied to Schedule ON for validation; if saved with cap only via Edit/API, behavior below applies.*

| When | What happens |
|------|----------------|
| Sending | Stops when **campaign daily count** ≥ cap |
| Pause reason | `daily_campaign_cap` |
| Same day after cap | Stays **paused** |
| Next day | Auto-resume after **09:00** server time (no schedule date) + worker ON |
| SMTP limit also | Whichever is **lower** hits first |

---

### 3.3 Only **Daily time window** (C ON)

*On Create: only effective if Schedule is also ON and saved together.*

| When | What happens |
|------|----------------|
| Inside window (e.g. 9 AM–5 PM) | Can send |
| Outside window | **Pause** — `send_window_closed` |
| Same day when window opens | **Can auto-resume** (no “next day” wait) |
| User Resume outside window | API error `SEND_WINDOW_CLOSED` |

---

### 3.4 Only **Auto-pause** (D ON)

| Mode | When | What happens |
|------|------|----------------|
| **Fixed date/time** | Clock reaches `pauseAt` | **Pause**, no `pauseReason` |
| **Duration** (e.g. 2 hours after start) | Elapsed time reached | **Pause**, no `pauseReason` |
| After auto-pause | | **Never auto-resumes** — user must click **Resume** |

---

### 3.5 Only **Weekdays** (E ON, e.g. Mon–Fri)

| When | What happens |
|------|----------------|
| Mon–Fri | Sends normally (subject to SMTP limit) |
| Sat–Sun | **Pause** — `weekday_filter` |
| Resume | First **allowed** weekday, after **09:00** server time (no schedule date), worker ON |
| User Resume on Sat/Sun | May start briefly, worker **pauses again** immediately |

---

### 3.6 Only **SMTP limit** (F — default 50, no campaign toggles)

| When | What happens |
|------|----------------|
| Under limit today | Sends |
| At limit today | **Pause** — `smtp_daily_limit` |
| Next allowed day | Auto-resume after resume clock (09:00 or schedule time) |
| SMTP limit empty | Unlimited (no SMTP cap pause) |
| SMTP limit = 0 | **No emails allowed** — sending is blocked entirely; Start/Resume rejected and campaigns pause with `smtp_daily_limit` |

---

## 4. Two Features ON — Common Pairs

### 4.1 **Schedule (A) + Daily limit (B)**

| Phase | Behavior |
|-------|----------|
| Before schedule time | No sending |
| Day 1 at schedule time | Start sending; stop at daily cap |
| Same day after cap | Paused |
| Next day at **schedule time** (not 9 AM default) | Auto-resume; send up to cap again |
| Example | 100 recipients, cap 50, Mon 10:00 → Mon 50 sent, Tue 10:00+ sends remaining 50 |

---

### 4.2 **Schedule (A) + Time window (C)**

| Phase | Behavior |
|-------|----------|
| Before schedule time | No sending |
| After schedule time | Send only **inside window** |
| After window ends | Pause `send_window_closed` |
| Next window | Auto-resume when window opens (same or next day) |

---

### 4.3 **Schedule (A) + Weekdays (E)**

| Phase | Behavior |
|-------|----------|
| Before schedule time | No sending |
| On allowed day at/after schedule time | Sends |
| On disallowed day | Pause `weekday_filter` |
| Next allowed day at/after **schedule time** | Auto-resume |

---

### 4.4 **Daily limit (B) + Weekdays (E)**

| Phase | Behavior |
|-------|----------|
| Allowed day | Send until daily cap |
| Cap reached | Pause `daily_campaign_cap`; resume next **allowed** day at 09:00 |
| Disallowed day | Pause `weekday_filter`; resume next allowed day at 09:00 |
| Weekend + cap | Sat/Sun no send; Mon continues remaining quota |

---

### 4.5 **Time window (C) + Weekdays (E)**

| Phase | Behavior |
|-------|----------|
| Allowed day + inside window | Sends |
| Outside window | Pause `send_window_closed`; resume when window opens |
| Disallowed day | Pause `weekday_filter`; resume next allowed day |

---

### 4.6 **Daily limit (B) + Time window (C)**

| Phase | Behavior |
|-------|----------|
| Inside window | Send until cap |
| Cap hit mid-day | Pause `daily_campaign_cap` |
| Window closes | Pause `send_window_closed` |
| Next day | Resume at window open + after daily resume clock |

---

### 4.7 **Any sending feature + Auto-pause (D)**

| Phase | Behavior |
|-------|----------|
| Until auto-pause triggers | Other rules apply normally |
| At auto-pause time/duration | **Pause** (no auto reason) |
| After that | **Manual Resume only** — daily/weekday auto-resume does **not** apply |

---

## 5. Three Features ON

### 5.1 **Schedule + Daily limit + Weekdays (A+B+E)**

| Step | Mon 10 AM (example) | Sat–Sun |
|------|---------------------|---------|
| 1 | Start at schedule time; send until cap | Paused `weekday_filter` |
| 2 | Pause `daily_campaign_cap` | No send |
| 3 | Tue 10 AM+ auto-resume | Mon 10 AM+ auto-resume |

---

### 5.2 **Schedule + Daily limit + Window (A+B+C)**

| Step | Behavior |
|------|----------|
| Send | Only after schedule time **and** inside 9–5 window |
| Cap or 5 PM | Pause (cap or window reason) |
| Next day | Resume at **schedule time** and when window opens (whichever is later) |

---

### 5.3 **Schedule + Window + Weekdays (A+C+E)**

| Step | Behavior |
|------|----------|
| Allowed day | Schedule time + inside window |
| Night/weekend | Window or weekday pause |
| Resume | Next allowed day: schedule time + window open |

---

### 5.4 **Daily limit + Window + Weekdays (B+C+E)** *(often via Edit)*

| Step | Behavior |
|------|----------|
| Allowed day 9–5 | Up to daily cap |
| After 5 PM | `send_window_closed` → resume next day 9 AM |
| Weekend | `weekday_filter` → resume Monday 9 AM |
| Cap hit | `daily_campaign_cap` → resume next allowed day |

---

## 6. ALL Features ON (A+B+C+D+E) + SMTP Limit

**Example config:**

- Start: Monday 10:00 AM
- Daily cap: 50
- Window: 9:00 AM – 5:00 PM
- Weekdays: Mon–Fri
- Auto-pause: Friday 5:00 PM
- SMTP limit: 50
- Worker: ON

| # | Situation | Runs? | How it resumes |
|---|-----------|-------|----------------|
| 1 | Mon 11 AM, 20 sent | Yes | — |
| 2 | Mon 4 PM, 50 sent | No | Tue 10 AM+ auto (`daily_campaign_cap`) |
| 3 | Mon 6 PM (window closed) | No | Tue 9 AM window + 10 AM schedule |
| 4 | Saturday | No | Mon per weekday + schedule + window |
| 5 | Friday 5 PM auto-pause fires | No | **Manual Resume** only |
| 6 | Tue 8 AM | No | Tue 10 AM+ (schedule) |
| 7 | Worker OFF | No | User must Resume/start worker |

**Rule of thumb:** Auto-pause **overrides** auto-resume for that pause event. Other pauses stack; strictest gate wins at resume time.

---

## 7. Master Matrix — When Campaign RUNS vs PAUSES

| Condition | RUNS | PAUSES |
|-----------|------|--------|
| Worker OFF | Only while user started and worker processes queue* | Stuck when auto logic expected |
| Before `scheduledAt` | No | Waiting |
| Wrong weekday | No | `weekday_filter` |
| Outside send window | No | `send_window_closed` |
| Campaign daily cap reached | No | `daily_campaign_cap` |
| SMTP daily cap reached | No | `smtp_daily_limit` |
| Auto-pause time reached | No | Paused (manual resume) |
| All rules OK | **Yes** | — |

\*Worker OFF: user can click Resume but emails only send when the worker is running.

---

## 8. Auto-Resume Cheat Sheet

| Pause reason | Next calendar day required? | Resume clock |
|--------------|----------------------------|--------------|
| `smtp_daily_limit` | Yes | Schedule time or 09:00 |
| `daily_campaign_cap` | Yes | Schedule time or 09:00 |
| `weekday_filter` | Yes* | Schedule time or 09:00 + must be allowed weekday |
| `send_window_closed` | No | When window opens |
| Manual / auto-pause timer | N/A | **Manual Resume only** |

\*Known gap: weekday resume also waits for calendar day after pause even on first allowed day; see implementation plan for fix.

---

## 9. UI Promises vs Actual Behavior

| UI text | Actual behavior |
|---------|-----------------|
| “Remaining sends continue the next day” | Yes **if** worker ON + quota pause + next day + resume clock |
| “Auto-resumes when the window opens” | Yes **if** worker ON + `send_window_closed` |
| “Resumes on the next allowed day” (weekdays) | Intended yes; requires worker + next day + 09:00/schedule time |
| Auto-pause | Never auto-resumes |

---

## 10. Quick Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Stays paused until Resume every day | Email worker not running |
| Stays paused on Monday (weekdays ON) | Still Sunday in server TZ; or before 09:00/schedule time; or worker OFF |
| Resumes but pauses instantly | Resume on wrong weekday or outside window |
| Never auto-resumes after Friday pause | Auto-pause was used (manual resume required) |
| Daily spread ON but no effect | Cap number empty (won’t save on Create) or worker OFF |
| Scheduled follow-up job shows **Paused – waiting for daily window** | SMTP/campaign daily limit reached; the job auto-resumes next allowed day (or use Resume manually). It no longer shows as **Failed**. |
| Nothing sends at all (SMTP limit = 0) | A limit of **0** blocks all sending. Set it to empty (unlimited) or 1–50 in Settings. |

---

## 11. Example Timelines

### 11.1 Weekdays only (Mon–Fri), 200 recipients, SMTP 50/day, worker ON

```
Fri 2 PM  → Start, 50 sent, pause (SMTP)
Mon 9 AM+ → Auto-resume, 50 sent, pause
Tue 9 AM+ → 50 sent …
~4 Mon–Fri weeks for 200 (weekends skipped)
```

### 11.2 Schedule Mon 10 AM + cap 50 + 100 recipients

```
Mon <10 AM → Waiting
Mon 10 AM+ → 50 sent, pause
Tue 10 AM+ → 50 sent, complete
```

### 11.3 All ON — 100 recipients, cap 50, Mon–Fri, 9–5, start Mon 10 AM

```
Mon 10–5 → up to 50 (or until cap)
Mon 5 PM → window pause OR already cap pause
Tue 10 AM+ → next batch
Sat–Sun → weekday pause
Mon → continue
```

---

## 12. Deployment Checklist

1. Run API: `bun run dev` (backend)
2. Run frontend: `bun run dev` (web)
3. Run worker: `bun run worker` (backend) — **required for automation**
4. Set `DB_TIMEZONE` to match business timezone
5. Confirm SMTP daily limit in Settings

---

## Related Code

| Area | Path |
|------|------|
| Worker poll + auto-resume | `backend/src/workers/emailWorker.ts` |
| Quota / pause reasons | `backend/src/lib/dailySendQuota.ts` |
| Weekdays | `backend/src/lib/weekdaySendSchedule.ts` |
| Send window | `backend/src/lib/dailySendWindow.ts` |
| Schedule time | `backend/src/lib/localDateTime.ts` |
| Create UI | `web/src/pages/CreateCampaign.tsx` |

---

*Last updated: May 2026 — reflects behavior as implemented in the email worker. Planned improvements: document worker in README, fix weekday auto-resume timing, weekday pause UI banner, resume API weekday guard.*
