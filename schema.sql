-- Al-Jarida WhatsApp Service — D1 Database Schema
--
-- Run once to set up the database:
--   wrangler d1 execute aljarida-db --file=schema.sql
--
-- To reset (WARNING: deletes all data):
--   wrangler d1 execute aljarida-db --command="DROP TABLE IF EXISTS subscribers;"
--   wrangler d1 execute aljarida-db --command="DROP TABLE IF EXISTS messages;"
--   wrangler d1 execute aljarida-db --command="DROP TABLE IF EXISTS consent_log;"
--   wrangler d1 execute aljarida-db --command="DROP TABLE IF EXISTS message_status;"
--   wrangler d1 execute aljarida-db --command="DROP TABLE IF EXISTS payments;"
--   Then re-run this schema file.

-- ----------------------------------------------------------------------------
-- Subscribers
-- ----------------------------------------------------------------------------
-- One row per unique phone number that has ever messaged us.
-- State machine values:
--   'new'              → never messaged before (shouldn't persist — quickly moves to offered)
--   'offered'          → we sent the subscription offer, awaiting response
--   'yes'              → said yes, about to receive payment link
--   'awaiting_payment' → payment link sent, waiting for completion
--   'active'           → paid, receiving daily PDF
--   'no'               → declined the offer
--   'unsubscribed'     → was active, then opted out
--   'payment_failed'   → payment attempt failed; they may retry

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

-- ----------------------------------------------------------------------------
-- Messages (audit log of every message in and out)
-- ----------------------------------------------------------------------------
-- Used for debugging, Meta compliance audits, and support.
-- Keep for at least 90 days (Meta compliance requirement).

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT UNIQUE,
  phone            TEXT NOT NULL,
  direction        TEXT NOT NULL,       -- 'inbound' or 'outbound'
  message_type     TEXT NOT NULL,       -- 'text', 'interactive', 'template', etc.
  content          TEXT,                -- JSON payload
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- ----------------------------------------------------------------------------
-- Consent Log (Meta compliance proof)
-- ----------------------------------------------------------------------------
-- Records every opt-in and opt-out with timestamp and exact message text shown
-- at the time of consent. This is our legal audit trail if Meta ever asks for
-- proof of consent — which they do sometimes ask news publishers.

CREATE TABLE IF NOT EXISTS consent_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL,
  consent_type     TEXT NOT NULL,       -- 'subscription_opt_in', 'opt_out'
  consent_text     TEXT NOT NULL,       -- exact message the user saw/sent
  timestamp        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_log(phone);
CREATE INDEX IF NOT EXISTS idx_consent_type ON consent_log(consent_type);

-- ----------------------------------------------------------------------------
-- Message Status (delivery tracking)
-- ----------------------------------------------------------------------------
-- Meta sends status webhooks for every outbound message: sent, delivered,
-- read, failed. We store these to monitor delivery quality and debug issues.

CREATE TABLE IF NOT EXISTS message_status (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id    TEXT NOT NULL,
  status           TEXT NOT NULL,       -- 'sent', 'delivered', 'read', 'failed'
  timestamp        INTEGER NOT NULL,
  recipient        TEXT,
  error_code       INTEGER,
  error_title      TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_status_msg ON message_status(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_status ON message_status(status);

-- ----------------------------------------------------------------------------
-- Payments (Piece 2 will populate this)
-- ----------------------------------------------------------------------------
-- Tracks payment attempts and subscription lifecycle.
-- Placeholder for now — MyFatoorah integration comes in Piece 2.

CREATE TABLE IF NOT EXISTS payments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  phone                TEXT NOT NULL,
  reference            TEXT UNIQUE,         -- our internal reference
  gateway_ref          TEXT,                -- MyFatoorah invoice ID
  amount_kwd           REAL NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'KWD',
  status               TEXT NOT NULL,       -- 'pending', 'paid', 'failed', 'refunded'
  payment_method       TEXT,                -- 'knet', 'visa', 'mastercard', etc.
  created_at           INTEGER NOT NULL,
  paid_at              INTEGER,
  subscription_start   INTEGER,
  subscription_end     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(reference);
