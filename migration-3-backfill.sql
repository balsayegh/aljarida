-- AlJarida Subscription Management v2 - BACKFILL + INDEXES
-- Run this LAST, after tables and columns are in place.

-- Set pilot plan for subscribers with "pilot" or "test" in internal_note
UPDATE subscribers
SET subscription_plan = 'pilot',
    tags = '["pilot"]'
WHERE (LOWER(internal_note) LIKE '%pilot%'
    OR LOWER(internal_note) LIKE '%test%'
    OR LOWER(internal_note) LIKE '%تجريب%')
  AND (subscription_plan = 'monthly' OR subscription_plan IS NULL);

-- Default remaining subscribers to 'monthly' (in case DEFAULT didn't apply)
UPDATE subscribers SET subscription_plan = 'monthly'
WHERE subscription_plan IS NULL;

-- For existing active subscribers without start_at, use first_contact_at
UPDATE subscribers
SET subscription_start_at = first_contact_at
WHERE state = 'active'
  AND subscription_start_at IS NULL
  AND first_contact_at IS NOT NULL;

-- For pilot users, set end_at far in the future
UPDATE subscribers
SET subscription_end_at = (unixepoch() + 365 * 24 * 60 * 60) * 1000
WHERE subscription_plan = 'pilot'
  AND (subscription_end_at IS NULL OR subscription_end_at < unixepoch() * 1000);

-- For monthly users without end_at, set 30 days from start
UPDATE subscribers
SET subscription_end_at = COALESCE(subscription_start_at, unixepoch() * 1000) + (30 * 24 * 60 * 60 * 1000)
WHERE subscription_plan = 'monthly'
  AND subscription_end_at IS NULL;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_subs_end_at ON subscribers(subscription_end_at);
CREATE INDEX IF NOT EXISTS idx_subs_plan ON subscribers(subscription_plan);
CREATE INDEX IF NOT EXISTS idx_subs_state_plan ON subscribers(state, subscription_plan);
