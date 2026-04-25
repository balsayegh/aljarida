-- Add payment_intents table for Ottu checkout sessions.
-- Apply with: wrangler d1 execute aljarida-db --remote --file=migration-payment-intents.sql

CREATE TABLE IF NOT EXISTS payment_intents (
  session_id       TEXT PRIMARY KEY,
  order_no         TEXT NOT NULL,
  phone            TEXT NOT NULL,
  amount_kwd       REAL NOT NULL,
  plan             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  checkout_url     TEXT,
  created_at       INTEGER NOT NULL,
  paid_at           INTEGER,
  raw_webhook      TEXT
);

CREATE INDEX IF NOT EXISTS idx_intents_phone ON payment_intents(phone);
CREATE INDEX IF NOT EXISTS idx_intents_created ON payment_intents(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_order ON payment_intents(order_no);
