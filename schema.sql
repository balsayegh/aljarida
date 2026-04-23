-- AlJarida Digital WhatsApp Service — D1 Database Schema
--
-- First-time setup:
--   wrangler d1 execute aljarida-db --remote --file=schema.sql
--
-- If upgrading from a previous version, see migrations.sql for incremental changes

-- ----------------------------------------------------------------------------
-- Subscribers
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscribers (
  phone                TEXT PRIMARY KEY,
  state                TEXT NOT NULL DEFAULT 'new',
  tier                 TEXT NOT NULL DEFAULT 'standard',
  profile_name         TEXT,
  internal_note        TEXT,
  first_contact_at     INTEGER NOT NULL,
  yes_at               INTEGER,
  activated_at         INTEGER,
  unsubscribed_at      INTEGER,
  csw_open_until       INTEGER,
  last_delivery_at     INTEGER,
  subscription_end_at  INTEGER,
  updated_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscribers_state ON subscribers(state);
CREATE INDEX IF NOT EXISTS idx_subscribers_csw ON subscribers(csw_open_until);
CREATE INDEX IF NOT EXISTS idx_subscribers_sub_end ON subscribers(subscription_end_at);

-- ----------------------------------------------------------------------------
-- Messages (raw inbound/outbound log)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT UNIQUE,
  phone            TEXT NOT NULL,
  direction        TEXT NOT NULL,
  message_type     TEXT NOT NULL,
  content          TEXT,
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
  consent_type     TEXT NOT NULL,
  consent_text     TEXT NOT NULL,
  timestamp        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_log(phone);
CREATE INDEX IF NOT EXISTS idx_consent_type ON consent_log(consent_type);

-- ----------------------------------------------------------------------------
-- Message status (delivery/read tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_status (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT NOT NULL,
  status           TEXT NOT NULL,
  timestamp        INTEGER NOT NULL,
  recipient        TEXT,
  error_code       INTEGER,
  error_title      TEXT,
  broadcast_id     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_message_status_msg ON message_status(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_status ON message_status(status);
CREATE INDEX IF NOT EXISTS idx_message_status_broadcast ON message_status(broadcast_id);

-- ----------------------------------------------------------------------------
-- Broadcasts (each daily delivery as a unit)
-- ----------------------------------------------------------------------------
-- Every time an admin clicks "Send", a row is created here.
-- Each individual message sent gets linked back to this broadcast_id
-- so we can show per-broadcast delivery stats.

CREATE TABLE IF NOT EXISTS broadcasts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date_string        TEXT NOT NULL,
  pdf_url            TEXT NOT NULL,
  headline_1         TEXT NOT NULL,
  headline_2         TEXT NOT NULL,
  headline_3         TEXT NOT NULL,
  target_count       INTEGER NOT NULL,
  sent_count         INTEGER DEFAULT 0,
  failed_count       INTEGER DEFAULT 0,
  status             TEXT DEFAULT 'in_progress',
  triggered_by       TEXT,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_started ON broadcasts(started_at DESC);

-- ----------------------------------------------------------------------------
-- Broadcast recipients (link between broadcast and individual message)
-- ----------------------------------------------------------------------------
-- When a broadcast sends to 50 subscribers, we create 50 rows here.
-- This gives us a clean "per-subscriber delivery status" view.

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id     INTEGER NOT NULL,
  phone            TEXT NOT NULL,
  wa_message_id    TEXT,
  send_status      TEXT NOT NULL,        -- 'sent', 'failed'
  delivery_status  TEXT,                  -- 'sent', 'delivered', 'read', 'failed' (from webhook)
  delivered_at     INTEGER,
  read_at          INTEGER,
  error_message    TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_br_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_recipients_phone ON broadcast_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_br_recipients_wa_id ON broadcast_recipients(wa_message_id);

-- ----------------------------------------------------------------------------
-- Payments (placeholder for Piece 2)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  phone                TEXT NOT NULL,
  reference            TEXT UNIQUE,
  gateway_ref          TEXT,
  amount_kwd           REAL NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'KWD',
  status               TEXT NOT NULL,
  payment_method       TEXT,
  created_at           INTEGER NOT NULL,
  paid_at              INTEGER,
  subscription_start   INTEGER,
  subscription_end     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(reference);
