-- AlJarida Digital WhatsApp Service — D1 Database Schema
--
-- Run once to set up:
--   wrangler d1 execute aljarida-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
  phone              TEXT PRIMARY KEY,
  state              TEXT NOT NULL DEFAULT 'new',
  tier               TEXT NOT NULL DEFAULT 'standard',
  profile_name       TEXT,
  first_contact_at   INTEGER NOT NULL,
  yes_at             INTEGER,
  activated_at       INTEGER,
  unsubscribed_at    INTEGER,
  csw_open_until     INTEGER,
  last_delivery_at   INTEGER,
  updated_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subscribers_state ON subscribers(state);
CREATE INDEX IF NOT EXISTS idx_subscribers_csw ON subscribers(csw_open_until);

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

CREATE TABLE IF NOT EXISTS consent_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  consent_type     TEXT NOT NULL,
  consent_text     TEXT NOT NULL,
  timestamp        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_log(phone);
CREATE INDEX IF NOT EXISTS idx_consent_type ON consent_log(consent_type);

CREATE TABLE IF NOT EXISTS message_status (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT NOT NULL,
  status           TEXT NOT NULL,
  timestamp        INTEGER NOT NULL,
  recipient        TEXT,
  error_code       INTEGER,
  error_title      TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_status_msg ON message_status(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_status ON message_status(status);

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
