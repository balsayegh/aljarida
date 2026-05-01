-- Subscriber-initiated fact-check requests (forwarded to Grok / xAI).
-- Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-factcheck-requests.sql
--
-- Each row records one request: an active subscriber sends "تحقق: ..." (or
-- an image with caption "تحقق ..."), we forward the content to Grok with
-- a fact-check prompt, and reply with the verdict.
--
-- status values:
--   replied        — Grok answered, reply sent to subscriber
--   rate_limited   — daily quota or 5-min cooldown
--   not_eligible   — non-active subscriber
--   model_error    — xAI API error or timeout
--   media_error    — couldn't download Meta image
--   send_failed    — Meta API error during reply send

CREATE TABLE IF NOT EXISTS factcheck_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  phone           TEXT NOT NULL,
  type            TEXT NOT NULL,        -- 'text' | 'image'
  prompt_text     TEXT,                 -- caption or text body (truncated to 2000)
  media_id        TEXT,                 -- WA media id for image requests
  verdict         TEXT,                 -- parsed verdict: ok / review / wrong / unknown
  response_text   TEXT,                 -- Grok's full response (truncated to 4000)
  status          TEXT NOT NULL,
  requested_at    INTEGER NOT NULL,
  latency_ms      INTEGER,
  error           TEXT,
  wa_message_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_factcheck_phone_time
  ON factcheck_requests(phone, requested_at DESC);
