-- Add scheduling support to broadcasts.
-- Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-scheduled-broadcasts.sql
--
-- New `scheduled_at` column is NULL for immediate (legacy) broadcasts.
-- Status semantics extended:
--   in_progress      — currently fanning out (existing)
--   completed        — all recipients accounted for (existing)
--   stalled          — stuck, no consumer activity (existing)
--   scheduled        — pending, scheduled_at not yet reached
--   canceled_scheduled — admin canceled before fire time
--
-- The */5 minute cron sweep promotes due scheduled rows to in_progress.

ALTER TABLE broadcasts ADD COLUMN scheduled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled
  ON broadcasts(status, scheduled_at)
  WHERE status = 'scheduled';
