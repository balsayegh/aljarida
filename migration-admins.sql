-- Multi-admin auth — replaces the single ADMIN_PASSWORD env var with
-- per-user accounts and three roles. Apply with:
--   wrangler d1 execute aljarida-db --remote --file=migration-admins.sql
--
-- Roles:
--   supervisor — full access, manages other admins
--   billing    — subscribers, payments, refunds, send links, manual add
--   publisher  — broadcast trigger, broadcasts history, failures
--
-- Bootstrap: the first login attempt where the admins table is empty
-- AND the entered password matches env.ADMIN_PASSWORD seeds a supervisor
-- row from the email/password supplied. After that, ADMIN_PASSWORD is
-- effectively legacy. See src/admin.js handleLogin.

CREATE TABLE IF NOT EXISTS admins (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  email                 TEXT UNIQUE NOT NULL,
  display_name          TEXT,
  password_hash         TEXT NOT NULL,    -- PBKDF2-SHA256 hex (32 bytes)
  password_salt         TEXT NOT NULL,    -- random 16-byte hex salt
  role                  TEXT NOT NULL CHECK(role IN ('supervisor', 'billing', 'publisher')),
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  created_by            INTEGER,          -- admins.id of inviter; NULL for bootstrap
  last_login_at         INTEGER,
  password_changed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);
