-- AlJarida Subscription Management v2 - TABLES ONLY
-- Run this FIRST before the columns migration
-- This creates the new tables that are independent of existing schema.

CREATE TABLE IF NOT EXISTS subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT,
  performed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  amount_kwd REAL NOT NULL,
  payment_date INTEGER NOT NULL,
  payment_method TEXT,
  reference TEXT,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  plan TEXT,
  status TEXT DEFAULT 'completed',
  notes TEXT,
  created_by TEXT DEFAULT 'admin',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_phone ON subscription_events(phone);
CREATE INDEX IF NOT EXISTS idx_events_created ON subscription_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phone);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date DESC);
