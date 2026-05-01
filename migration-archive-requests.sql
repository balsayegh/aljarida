-- Subscriber-initiated archive requests (request an old edition by date).
-- Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-archive-requests.sql
--
-- Each row records one request: paid-yearly subscriber asks for a past
-- edition by date. Status reflects what we did:
--   sent          — PDF delivered via template
--   not_found     — URL HEAD failed (edition not in archive)
--   rate_limited  — daily quota or 5-min cooldown
--   not_eligible  — non-paid plan, paused, etc.
--   send_failed   — Meta API error during send

CREATE TABLE IF NOT EXISTS archive_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT NOT NULL,
  requested_date  TEXT NOT NULL,        -- 'YYYY-MM-DD' canonical
  pdf_url         TEXT,
  status          TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  wa_message_id   TEXT
);

-- Rate-limit lookups join on phone + recent timestamp range, so this is the
-- index that matters.
CREATE INDEX IF NOT EXISTS idx_archive_phone_time
  ON archive_requests(phone, requested_at DESC);
