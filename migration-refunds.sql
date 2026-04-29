-- Add refunded_amount_kwd to payments. Tracks cumulative refunds across
-- multiple partial refund operations on the same payment.
--
-- Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-refunds.sql
--
-- payments.state semantics extended:
--   'paid'                 — refunded_amount_kwd = 0
--   'partially_refunded'   — 0 < refunded_amount_kwd < amount_kwd
--   'refunded'             — refunded_amount_kwd = amount_kwd
--   (other states unchanged)

ALTER TABLE payments ADD COLUMN refunded_amount_kwd REAL DEFAULT 0;
