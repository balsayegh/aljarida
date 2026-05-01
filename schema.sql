-- AlJarida Digital WhatsApp Service — D1 Database Schema (canonical)
--
-- This file represents the complete, current database structure.
-- Safe to run against a fresh D1 DB:
--   wrangler d1 execute aljarida-db --remote --file=schema.sql
--
-- For existing databases, see the dated migration files (migrations.sql,
-- migrations-v2.sql, migration-1/2/3-*.sql). This schema reflects the
-- resulting shape after all v1 + v2 migrations have been applied.

-- ----------------------------------------------------------------------------
-- Subscribers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  phone                      TEXT PRIMARY KEY,
  state                      TEXT NOT NULL DEFAULT 'new',
  tier                       TEXT NOT NULL DEFAULT 'standard',
  profile_name               TEXT,
  internal_note              TEXT,
  first_contact_at           INTEGER NOT NULL,
  yes_at                     INTEGER,
  activated_at               INTEGER,
  unsubscribed_at            INTEGER,
  csw_open_until             INTEGER,
  last_delivery_at           INTEGER,
  updated_at                 INTEGER,

  -- Subscription lifecycle (v2)
  subscription_plan          TEXT DEFAULT 'yearly',  -- 'yearly', 'pilot', 'gift' (legacy: 'monthly')
  subscription_start_at      INTEGER,
  subscription_end_at        INTEGER,

  -- Payment tracking (v2)
  last_payment_at            INTEGER,
  last_payment_amount_kwd    REAL,
  payment_count              INTEGER DEFAULT 0,
  total_paid_kwd             REAL DEFAULT 0,

  -- Organization (v2)
  tags                       TEXT,  -- JSON array
  previous_phones            TEXT,  -- JSON array of {phone, changed_at, reason, changed_to}

  -- Phone change verification (v2)
  phone_change_pending       TEXT,  -- JSON {old_phone, new_phone, requested_at, expires_at}

  -- Renewal reminders (v2)
  last_reminder_sent_at      INTEGER,
  last_reminder_days_before  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscribers_state ON subscribers(state);
CREATE INDEX IF NOT EXISTS idx_subscribers_csw ON subscribers(csw_open_until);
CREATE INDEX IF NOT EXISTS idx_subs_end_at ON subscribers(subscription_end_at);
CREATE INDEX IF NOT EXISTS idx_subs_plan ON subscribers(subscription_plan);
CREATE INDEX IF NOT EXISTS idx_subs_state_plan ON subscribers(state, subscription_plan);

-- ----------------------------------------------------------------------------
-- Messages (raw inbound/outbound log)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT UNIQUE,
  phone            TEXT NOT NULL,
  direction        TEXT NOT NULL,        -- 'inbound' or 'outbound'
  message_type     TEXT NOT NULL,        -- 'text', 'interactive', 'template', ...
  content          TEXT,                 -- JSON payload
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ----------------------------------------------------------------------------
-- Consent log (Meta compliance audit trail)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  consent_type     TEXT NOT NULL,        -- 'subscription_opt_in', 'opt_out', 'pilot_manual_add'
  consent_text     TEXT NOT NULL,        -- exact message the user saw/sent
  timestamp        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_log(phone);
CREATE INDEX IF NOT EXISTS idx_consent_type ON consent_log(consent_type);

-- ----------------------------------------------------------------------------
-- Message status (delivery/read tracking from Meta webhooks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_status (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT NOT NULL,
  status           TEXT NOT NULL,        -- 'sent', 'delivered', 'read', 'failed'
  timestamp        INTEGER NOT NULL,
  recipient        TEXT,
  error_code       INTEGER,
  error_title      TEXT,
  broadcast_id     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_message_status_msg ON message_status(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_status ON message_status(status);
CREATE INDEX IF NOT EXISTS idx_message_status_broadcast ON message_status(broadcast_id);
-- Idempotency: Meta retries webhook events on 5xx/timeout, so dedupe on (msg_id, status)
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_status_unique ON message_status(wa_message_id, status);

-- ----------------------------------------------------------------------------
-- Broadcasts (each daily delivery as a unit)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broadcasts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date_string        TEXT NOT NULL,
  pdf_url            TEXT NOT NULL,
  target_count       INTEGER NOT NULL,
  sent_count         INTEGER DEFAULT 0,
  failed_count       INTEGER DEFAULT 0,
  status             TEXT DEFAULT 'in_progress',
                                          -- 'in_progress' | 'completed' | 'stalled'
                                          -- | 'scheduled' | 'canceled_scheduled'
  triggered_by       TEXT,
  started_at         INTEGER NOT NULL,    -- when the row was created
  finished_at        INTEGER,
  scheduled_at       INTEGER               -- NULL for immediate; set for scheduled
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_started ON broadcasts(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled
  ON broadcasts(status, scheduled_at)
  WHERE status = 'scheduled';

-- ----------------------------------------------------------------------------
-- Broadcast recipients (per-subscriber delivery status for each broadcast)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id     INTEGER NOT NULL,
  phone            TEXT NOT NULL,
  wa_message_id    TEXT,
  send_status      TEXT NOT NULL,        -- 'sent', 'failed'
  delivery_status  TEXT,                 -- 'sent', 'delivered', 'read', 'failed' (from webhook)
  delivered_at     INTEGER,
  read_at          INTEGER,
  error_message    TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_br_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_recipients_phone ON broadcast_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_br_recipients_wa_id ON broadcast_recipients(wa_message_id);
-- Idempotency for queue consumer: dedupe (broadcast, phone) so a retried queue message won't double-send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_br_recipients_unique ON broadcast_recipients(broadcast_id, phone);

-- ----------------------------------------------------------------------------
-- Payments (manual entries; payment gateway integration pending)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  amount_kwd       REAL NOT NULL,
  payment_date     INTEGER NOT NULL,     -- when the payment actually happened (PG timestamp for Ottu)
  payment_method   TEXT,                 -- 'ottu', 'knet', 'visa', 'cash', 'bank_transfer', 'gift', 'manual', 'pilot'
  reference        TEXT,                 -- session_id (Ottu) or admin note (manual)
  period_start     INTEGER NOT NULL,
  period_end       INTEGER NOT NULL,
  plan             TEXT,                 -- 'yearly', 'gift', etc.
  status           TEXT DEFAULT 'completed',
  notes            TEXT,
  created_by       TEXT DEFAULT 'admin',
  created_at       INTEGER NOT NULL,
  -- Ottu-sourced details (NULL for manual/legacy rows)
  gateway          TEXT,                 -- 'KNET', 'Credit-Card', etc. (gateway_account)
  pg_reference     TEXT,                 -- pg_params.rrn || pg_params.transaction_id
  card_last4       TEXT,                 -- '1234' (NULL for KNET)
  state            TEXT,                 -- 'paid' | 'partially_refunded' | 'refunded' | 'voided'
  refunded_amount_kwd REAL DEFAULT 0      -- cumulative refunds (partial supported)
);

CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);

-- ----------------------------------------------------------------------------
-- Archive requests (paid subscribers asking for past editions via WhatsApp)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT NOT NULL,
  requested_date  TEXT NOT NULL,
  pdf_url         TEXT,
  status          TEXT NOT NULL,    -- sent / not_found / rate_limited / not_eligible / send_failed
  requested_at    INTEGER NOT NULL,
  wa_message_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_archive_phone_time
  ON archive_requests(phone, requested_at DESC);

-- ----------------------------------------------------------------------------
-- Admins (multi-user with roles: supervisor, billing, publisher)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  email                 TEXT UNIQUE NOT NULL,
  display_name          TEXT,
  password_hash         TEXT NOT NULL,
  password_salt         TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK(role IN ('supervisor', 'billing', 'publisher')),
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  created_by            INTEGER,
  last_login_at         INTEGER,
  password_changed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);

-- ----------------------------------------------------------------------------
-- Subscription events (lifecycle audit log)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  -- Event types: 'subscribed', 'activated', 'paused', 'resumed', 'extended',
  --              'phone_change_requested', 'phone_change_confirmed', 'phone_change_rejected',
  --              'phone_change_reverted', 'payment_received', 'plan_changed',
  --              'reminder_sent', 'auto_paused_expired', 'cancelled', 'unsubscribed',
  --              'tag_added', 'tag_removed'
  details          TEXT,                 -- JSON with event-specific data
  performed_by     TEXT,                 -- 'admin', 'subscriber', 'system', 'cron'
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_phone ON subscription_events(phone);
CREATE INDEX IF NOT EXISTS idx_events_created ON subscription_events(created_at DESC);

-- ----------------------------------------------------------------------------
-- Payment intents (Ottu checkout sessions)
-- ----------------------------------------------------------------------------
-- Each Ottu checkout we create is recorded here so the webhook can map
-- session_id -> phone, and so we can dedupe repeat webhooks (status flips
-- to 'paid' once; subsequent identical webhooks are ignored).
CREATE TABLE IF NOT EXISTS payment_intents (
  session_id       TEXT PRIMARY KEY,
  order_no         TEXT NOT NULL,
  phone            TEXT NOT NULL,
  amount_kwd       REAL NOT NULL,
  plan             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'paid', 'failed', 'canceled'
  checkout_url     TEXT,
  created_at       INTEGER NOT NULL,
  paid_at          INTEGER,
  raw_webhook      TEXT
);

CREATE INDEX IF NOT EXISTS idx_intents_phone ON payment_intents(phone);
CREATE INDEX IF NOT EXISTS idx_intents_created ON payment_intents(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_order ON payment_intents(order_no);

-- ----------------------------------------------------------------------------
-- Broadcast failures (DLQ landing zone)
-- ----------------------------------------------------------------------------
-- When a queue message exceeds max_retries, Cloudflare moves it to the DLQ.
-- The DLQ consumer drains those into this table for admin inspection.
CREATE TABLE IF NOT EXISTS broadcast_failures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id     INTEGER,
  phone            TEXT NOT NULL,
  payload          TEXT,                 -- JSON of the original queue message body
  failed_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failures_failed_at ON broadcast_failures(failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_failures_broadcast ON broadcast_failures(broadcast_id);
