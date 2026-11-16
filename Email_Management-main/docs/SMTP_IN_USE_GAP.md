# "One campaign per SMTP account" only checks the first account

Status: known gap, not fixed. Planned for a separate branch after the 116 QA bugs are deployed.

## What is wrong

The rule "only one campaign or follow-up can use an SMTP account at a time" is checked only against each
campaign's **first (primary) account** (`campaigns.smtp_settings_id`). The other accounts a campaign rotates
through (`campaigns.smtp_setting_ids`, jsonb array) are never checked. Two campaigns can therefore run at the same
time and send from the same account.

The 20 emails/day cap per account is **not** affected: `countSendsTodayForSmtp` counts every send from that
account, whatever campaign sent it. Only the one-campaign rule is broken.

## Steps to reproduce (local)

1. Settings: have at least 3 SMTP accounts, A, B and C (on a plan that allows 3+).
2. Create campaign **X**, select accounts **A and B** (A first), upload 2+ recipients, Start. X is `in_progress`.
3. Create campaign **Y**, select accounts **B and C** (B first), upload 2+ recipients, Start.
4. Expected: Start of Y is refused with `409 SMTP_IN_USE` ("This SMTP account is already running campaign X"),
   because B belongs to X.
   Actual: Y starts. The check compares Y's primary B with X's primary A only.
5. Make it visible: set A's daily limit to 1 in Settings (or let A reach 20). X then rotates to B
   (`pickAvailableSmtp` takes the first account with quota left), while Y also sends from B.
   `recipients.used_smtp_email` shows B for recipients of both X and Y in the same period.

Same gap, other entry points: Resume (step 3 with Resume instead of Start), the worker's auto-resume, and
follow-up jobs on a campaign whose secondary account is busy.

## Files that would need to change

| File | Where | Change |
|---|---|---|
| `backend/src/lib/dailySendQuota.ts` | `isSmtpInUse()` (~line 187) | Match a running campaign / running follow-up job when the id is its `smtp_settings_id` **or** is in `smtp_setting_ids` (`smtp_setting_ids @> '[<id>]'::jsonb`). Possibly add `isAnySmtpInUse(ids[], excludeCampaignId)` that checks a list in one query. |
| `backend/src/controllers/campaignController.ts` | `startCampaign` (~line 1390) and `resumeCampaign` (~line 1526) | Check **every** id of the campaign (`smtpSettingIds`, fallback `smtpSettingsId`), not only `campaign[0].smtpSettingsId`. |
| `backend/src/workers/emailWorker.ts` | auto-resume loop (~line 785-801) | Same: check all of the campaign's accounts before resuming. |
| `backend/src/workers/followUpJobWorker.ts` | job start (~line 188) and account pick (~line 414) | Same: use the campaign's full account list. |

Optional: `pickAvailableSmtp()` in `emailWorker.ts` (~line 225) could skip an account that another running
campaign is using, instead of refusing the whole Start.

## Things to check when fixing

- Decide the rule: refuse the whole Start when **any** account is busy (simple, strict), or start and only skip
  busy accounts while sending (more flexible). The error text and the `SMTP_IN_USE` 409 response are used by the
  web app (`CampaignDetail.tsx`) and possibly by the AI agent (`Email_agent/mailflow-mcp-server`, do not edit there).
- Legacy campaigns have `smtp_setting_ids = []` and only `smtp_settings_id`; keep that fallback.
- With up to 100 accounts per campaign, use one query (jsonb `?|` / `@>`), not 100 queries.
- Regression: single-account campaigns, campaigns with several accounts, follow-up jobs, and the F-25 20/day limit.
