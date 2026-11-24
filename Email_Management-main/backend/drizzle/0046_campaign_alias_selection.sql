-- 0046_campaign_alias_selection
-- Let a campaign restrict which sending aliases it uses. NULL / empty [] = use every active
-- alias of the campaign's selected SMTP profile(s) (the existing behaviour). When non-empty,
-- the worker only sends from the listed alias ids (still honouring each alias's own daily quota).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS alias_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
