-- Promote a small set of Ottu payment-gateway fields to typed columns on
-- the payments table, so the admin UI can list/filter without parsing the
-- raw_webhook JSON kept on payment_intents.
--
-- Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-payment-fields.sql
--
-- Columns are nullable because manual/legacy payments won't have these.

ALTER TABLE payments ADD COLUMN gateway      TEXT;  -- 'KNET', 'Credit-Card', etc.
ALTER TABLE payments ADD COLUMN pg_reference TEXT;  -- pg_params.rrn || transaction_id
ALTER TABLE payments ADD COLUMN card_last4   TEXT;  -- '1234' (NULL for KNET)
ALTER TABLE payments ADD COLUMN state        TEXT;  -- 'paid' | 'refunded' | 'voided'

CREATE INDEX IF NOT EXISTS idx_payments_state ON payments(state);
