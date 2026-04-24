-- AlJarida Digital — Subscription Management v2 Migration
-- Run these statements in order against your D1 database.
-- Safe to run multiple times (uses IF NOT EXISTS / defensive checks).

-- ============================================================================
-- 1. Add new columns to subscribers table
-- ============================================================================

-- Subscription lifecycle
ALTER TABLE subscribers ADD COLUMN subscription_plan TEXT DEFAULT 'monthly';
ALTER TABLE subscribers ADD COLUMN subscription_start_at INTEGER;
-- subscription_end_at should already exist from v1 schema; skip if you get "duplicate column"

-- Payment tracking
ALTER TABLE subscribers ADD COLUMN last_payment_at INTEGER;
ALTER TABLE subscribers ADD COLUMN last_payment_amount_kwd REAL;
ALTER TABLE subscribers ADD COLUMN payment_count INTEGER DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN total_paid_kwd REAL DEFAULT 0;

-- Organization
ALTER TABLE subscribers ADD COLUMN tags TEXT; -- JSON array of strings
ALTER TABLE subscribers ADD COLUMN previous_phones TEXT; -- JSON array of {phone, changed_at, reason}

-- Phone change verification state
ALTER TABLE subscribers ADD COLUMN phone_change_pending TEXT; -- JSON: {old_phone, new_phone, requested_at, expires_at}

-- Last renewal reminder sent (to avoid double-sending)
ALTER TABLE subscribers ADD COLUMN last_reminder_sent_at INTEGER;
ALTER TABLE subscribers ADD COLUMN last_reminder_days_before INTEGER; -- 7 or 1

-- ============================================================================
-- 2. New table: subscription_events (lifecycle audit log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL,
  -- Event types: 'subscribed', 'activated', 'paused', 'resumed', 'extended',
  --              'phone_change_requested', 'phone_change_confirmed', 'phone_change_rejected',
  --              'phone_change_reverted', 'payment_received', 'plan_changed',
  --              'reminder_sent', 'auto_paused_expired', 'cancelled', 'unsubscribed',
  --              'tag_added', 'tag_removed'
  details TEXT, -- JSON with event-specific data
  performed_by TEXT, -- 'admin', 'subscriber', 'system', 'cron'
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_phone ON subscription_events(phone);
CREATE INDEX IF NOT EXISTS idx_events_created ON subscription_events(created_at DESC);

-- ============================================================================
-- 3. New table: payments (manual entries until payment gateway integration)
-- ============================================================================

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  amount_kwd REAL NOT NULL,
  payment_date INTEGER NOT NULL,
  payment_method TEXT, -- 'knet', 'visa', 'cash', 'bank_transfer', 'gift', 'manual', 'pilot'
  reference TEXT, -- transaction ID or admin notes
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  plan TEXT, -- 'monthly', 'yearly', 'custom'
  status TEXT DEFAULT 'completed', -- 'completed', 'pending', 'failed', 'refunded'
  notes TEXT,
  created_by TEXT DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);

-- ============================================================================
-- 4. Backfill existing subscribers with sensible defaults
-- ============================================================================

-- Default all existing subscribers to 'monthly' plan (already set by ALTER)
-- Set pilot plan for subscribers with "pilot" or "test" in internal_note
UPDATE subscribers
SET subscription_plan = 'pilot',
    tags = '["pilot"]'
WHERE (LOWER(internal_note) LIKE '%pilot%'
    OR LOWER(internal_note) LIKE '%test%'
    OR LOWER(internal_note) LIKE '%تجريب%')
  AND subscription_plan = 'monthly';

-- For existing active subscribers without subscription_start_at, set to first_contact_at
UPDATE subscribers
SET subscription_start_at = first_contact_at
WHERE state = 'active'
  AND subscription_start_at IS NULL
  AND first_contact_at IS NOT NULL;

-- For pilot users, set end_at to 1 year from now (so they never expire during pilot)
UPDATE subscribers
SET subscription_end_at = (unixepoch() + 365 * 24 * 60 * 60) * 1000
WHERE subscription_plan = 'pilot'
  AND (subscription_end_at IS NULL OR subscription_end_at < unixepoch() * 1000);

-- For monthly users without end_at, set to 30 days from their start (grace period)
UPDATE subscribers
SET subscription_end_at = subscription_start_at + (30 * 24 * 60 * 60 * 1000)
WHERE subscription_plan = 'monthly'
  AND subscription_end_at IS NULL
  AND subscription_start_at IS NOT NULL;

-- ============================================================================
-- 5. Indexes for performance
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_subs_end_at ON subscribers(subscription_end_at);
CREATE INDEX IF NOT EXISTS idx_subs_plan ON subscribers(subscription_plan);
CREATE INDEX IF NOT EXISTS idx_subs_state_plan ON subscribers(state, subscription_plan);
