-- Migration: Add broadcast tracking and subscription fields
--
-- Run this ONLY if you already have an existing aljarida-db from Piece 1/3:
--   wrangler d1 execute aljarida-db --remote --file=migrations.sql
--
-- Safe to run multiple times — uses IF NOT EXISTS and CREATE TABLE IF NOT EXISTS.
-- NOTE: SQLite's ALTER TABLE ADD COLUMN does NOT support IF NOT EXISTS —
-- running this twice will produce "duplicate column name" errors for ALTER
-- statements, which are safe to ignore (the column already exists).

-- Add new columns to subscribers (safe if column already exists — just errors harmlessly)
ALTER TABLE subscribers ADD COLUMN internal_note TEXT;
ALTER TABLE subscribers ADD COLUMN subscription_end_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_subscribers_sub_end ON subscribers(subscription_end_at);

-- Add broadcast_id column to message_status to link statuses to broadcasts
ALTER TABLE message_status ADD COLUMN broadcast_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_message_status_broadcast ON message_status(broadcast_id);

-- Create broadcasts tracking tables
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

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcast_id     INTEGER NOT NULL,
  phone            TEXT NOT NULL,
  wa_message_id    TEXT,
  send_status      TEXT NOT NULL,
  delivery_status  TEXT,
  delivered_at     INTEGER,
  read_at          INTEGER,
  error_message    TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_br_recipients_broadcast ON broadcast_recipients(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_br_recipients_phone ON broadcast_recipients(phone);
CREATE INDEX IF NOT EXISTS idx_br_recipients_wa_id ON broadcast_recipients(wa_message_id);
