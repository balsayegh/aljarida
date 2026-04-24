-- AlJarida Subscription Management v2 - COLUMN ADDITIONS
--
-- Run each ALTER TABLE individually. If any fails with "duplicate column",
-- that column already exists — just skip it and continue with the next.
--
-- RECOMMENDED: Run these one at a time with --command flag instead of --file
-- so a single "duplicate column" error doesn't abort the whole migration.

ALTER TABLE subscribers ADD COLUMN subscription_plan TEXT DEFAULT 'monthly';

ALTER TABLE subscribers ADD COLUMN subscription_start_at INTEGER;

ALTER TABLE subscribers ADD COLUMN last_payment_at INTEGER;

ALTER TABLE subscribers ADD COLUMN last_payment_amount_kwd REAL;

ALTER TABLE subscribers ADD COLUMN payment_count INTEGER DEFAULT 0;

ALTER TABLE subscribers ADD COLUMN total_paid_kwd REAL DEFAULT 0;

ALTER TABLE subscribers ADD COLUMN tags TEXT;

ALTER TABLE subscribers ADD COLUMN previous_phones TEXT;

ALTER TABLE subscribers ADD COLUMN phone_change_pending TEXT;

ALTER TABLE subscribers ADD COLUMN last_reminder_sent_at INTEGER;

ALTER TABLE subscribers ADD COLUMN last_reminder_days_before INTEGER;
