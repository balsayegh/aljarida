/**
 * Multi-admin auth helpers — PBKDF2 password hashing + session encode/decode.
 *
 * Workers don't ship bcrypt natively, so we use Web Crypto's PBKDF2-SHA256
 * with 100k iterations. Salts are 16 random bytes per user, hex-encoded.
 *
 * Session format: `${expiresMs}.${adminId}.${hmacHex}` where hmacHex is
 * HMAC-SHA256 of the literal string `${expiresMs}.${adminId}` keyed by
 * env.ADMIN_PASSWORD (kept around as a session-signing secret only —
 * NOT a login credential after multi-admin auth lands).
 */

import { timingSafeEqual } from './crypto_util.js';

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH_BYTES = 32;
const SALT_BYTES = 16;

// ----------------------------------------------------------------------------
// Password hashing
// ----------------------------------------------------------------------------

/**
 * Hash a plaintext password. Returns { hash, salt } both hex-encoded.
 * Pass an existing saltHex to verify against a stored hash; omit to mint
 * a fresh salt for a new password.
 */
export async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8,
  );
  return {
    hash: bytesToHex(new Uint8Array(bits)),
    salt: bytesToHex(salt),
  };
}

/**
 * Constant-time check whether `password` matches a stored hash + salt.
 */
export async function verifyPassword(password, expectedHashHex, saltHex) {
  if (!expectedHashHex || !saltHex) return false;
  const { hash } = await hashPassword(password, saltHex);
  return timingSafeEqual(hash, expectedHashHex);
}

// ----------------------------------------------------------------------------
// Session cookie
// ----------------------------------------------------------------------------

/**
 * Build a signed session cookie value. Signing key is env.ADMIN_PASSWORD
 * (legacy env var kept for HMAC purposes; not a login credential).
 */
export async function createSessionCookie(env, adminId, durationMs) {
  const expiresAt = Date.now() + durationMs;
  const payload = `${expiresAt}.${adminId}`;
  const sig = await signHmac(payload, env.ADMIN_PASSWORD);
  return `${payload}.${sig}`;
}

/**
 * Verify a cookie value, return { adminId, expiresAt } or null.
 * Does NOT load the admin row — caller is responsible for confirming
 * the admin still exists and is active.
 */
export async function verifySessionCookie(cookieValue, env) {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [expiresStr, adminIdStr, sig] = parts;
  const payload = `${expiresStr}.${adminIdStr}`;
  const expected = await signHmac(payload, env.ADMIN_PASSWORD);
  if (!timingSafeEqual(sig, expected)) return null;
  const expiresAt = parseInt(expiresStr, 10);
  const adminId = parseInt(adminIdStr, 10);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(adminId)) return null;
  if (expiresAt <= Date.now()) return null;
  return { adminId, expiresAt };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function signHmac(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Role permissions
// ----------------------------------------------------------------------------

/**
 * Hard-coded role → permission mapping. Each route is gated against one
 * of these tags via `requireRole(allowed)`. Single source of truth so
 * role behavior is auditable from one file.
 *
 * Roles:
 *   - supervisor : everything, including managing other admins
 *   - billing    : subscriber CRUD + payment ops + global payments page
 *   - publisher  : broadcast trigger + broadcast history + DLQ failures
 */
export const ROLE_SUPERVISOR = 'supervisor';
export const ROLE_BILLING    = 'billing';
export const ROLE_PUBLISHER  = 'publisher';
export const ALL_ROLES = [ROLE_SUPERVISOR, ROLE_BILLING, ROLE_PUBLISHER];

/**
 * Look up the admin row by id. Returns the row or null. Used by route
 * dispatch to confirm session-bound admin still exists and is active.
 */
export async function loadAdmin(env, adminId) {
  if (!adminId) return null;
  return env.DB.prepare(
    `SELECT id, email, display_name, role, active, last_login_at
     FROM admins WHERE id = ? AND active = 1`
  ).bind(adminId).first();
}
