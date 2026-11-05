-- Plan limits and Basic price.
--   Limits: Basic 5 / Standard 100 / Premium unlimited SMTP profiles; 20 emails/day per SMTP account on every plan.
--   Price:  Basic $0.10 -> $9.99 (F-04: $0.10 was a test price). Standard $24.99 and Premium $49.99 unchanged.
--
-- REVIEW BEFORE RUNNING. Do not run this until it has been reviewed.
--
-- 0. BACK UP FIRST (plans and subscriptions), e.g.:
--      pg_dump "$DATABASE_URL" -t plans -t subscriptions --data-only -f plans_backup_YYYYMMDD.sql
--    Also note the current Basic stripe_price_id from step 1 (needed to find the old price in Stripe later).
--
-- NOTE: the backend's startup seed (backend/src/lib/planCatalog.ts -> seedPlans) writes exactly these values on every
-- server start. After the new code is deployed and restarted, this script is only needed as a check (step 1 should
-- then already show the new values). Do NOT run it while the OLD code is still deployed: the old seed would put the
-- old values back on the next restart.
--
-- "Unlimited" SMTP profiles = 999999 (plans.smtp_limit is INTEGER NOT NULL; same sentinel the code already uses).
--
-- STRIPE EFFECT of the price change (not done by this SQL; done by the seed, seedStripePrices in
-- backend/src/lib/seedSuperAdmin.ts, on the next server start with the real STRIPE_SECRET_KEY):
--   - it sees Basic's Stripe price ($0.10) no longer matches price_usd ($9.99),
--   - ARCHIVES the old $0.10 price (active = false; it is not deleted),
--   - CREATES a new "Basic Plan" product with a $9.99/month price and stores its id in plans.stripe_price_id.
--   - New Basic checkouts are charged $9.99.
--   - EXISTING Basic subscribers are NOT changed: their Stripe subscriptions stay on the archived $0.10 price and
--     keep renewing at $0.10 until each subscription is moved to the new price in Stripe (a separate, manual step).
--     They keep the Basic plan in MailFlow: renewal webhooks map by subscription metadata planCode, not by price id.
--   stripe_price_id is NOT changed here. If this SQL runs and the server is restarted, the seed then does the above.
--
-- crm_enabled, inbox_enabled and follow_up_enabled are not changed.

-- 1. PREVIEW: current plan rows, and how many subscriptions each plan has.
SELECT p.code, p.name, p.smtp_limit, p.daily_email_limit, p.price_usd, p.stripe_price_id,
       p.inbox_enabled, p.follow_up_enabled, p.crm_enabled,
       (SELECT count(*) FROM subscriptions s WHERE s.plan_code = p.code) AS subscriptions
FROM plans p
ORDER BY p.price_usd;

-- 1b. PREVIEW: existing Basic subscribers (they stay on $0.10 in Stripe until moved; keep this list).
SELECT s.user_id, u.email, s.status, s.stripe_subscription_id, s.current_period_end
FROM subscriptions s
JOIN users u ON u.id = s.user_id
WHERE s.plan_code = 'basic'
ORDER BY s.user_id;

-- 1c. PREVIEW: users who would have more SMTP accounts than the new limit allows (expected: no rows, all limits go up).
SELECT s.user_id, s.plan_code, count(x.id) AS smtp_accounts
FROM subscriptions s
JOIN smtp_settings x ON x.user_id = s.user_id
GROUP BY s.user_id, s.plan_code
HAVING count(x.id) > CASE s.plan_code WHEN 'basic' THEN 5 WHEN 'standard' THEN 100 ELSE 999999 END;

-- 2. UPDATE (in a transaction; check step 3 before COMMIT, ROLLBACK if anything looks wrong).
BEGIN;

UPDATE plans SET smtp_limit = 5,      daily_email_limit = 20, price_usd = 9.99  WHERE code = 'basic';
UPDATE plans SET smtp_limit = 100,    daily_email_limit = 20, price_usd = 24.99 WHERE code = 'standard';
UPDATE plans SET smtp_limit = 999999, daily_email_limit = 20, price_usd = 49.99 WHERE code = 'premium';

-- 3. VERIFY: expect basic 5/20/9.99, standard 100/20/24.99, premium 999999/20/49.99 (exactly 3 rows),
--    stripe_price_id unchanged from step 1.
SELECT code, smtp_limit, daily_email_limit, price_usd, stripe_price_id FROM plans ORDER BY price_usd;

COMMIT;
-- ROLLBACK;

-- UNDO (only if needed, after restoring the OLD code; otherwise the seed writes the new values again):
--   UPDATE plans SET smtp_limit = 1, daily_email_limit = 10, price_usd = 0.10  WHERE code = 'basic';
--   UPDATE plans SET smtp_limit = 3, daily_email_limit = 25                    WHERE code = 'standard';
--   UPDATE plans SET smtp_limit = 5, daily_email_limit = 50                    WHERE code = 'premium';
--   (If the seed already ran with the live Stripe key, the $0.10 price is archived in Stripe; it can be
--    re-activated in the Stripe dashboard and its id put back into plans.stripe_price_id.)
