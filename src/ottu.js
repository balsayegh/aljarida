/**
 * Ottu payment gateway integration.
 *
 * Phase 1: one-off `e_commerce` checkout. Customer taps subscribe_yes →
 * createCheckout() → we send the returned checkout_url over WhatsApp →
 * Ottu posts back to /payment/webhook on completion.
 *
 * Tokenization / auto-debit for renewals is intentionally deferred to Phase 2.
 */

import { timingSafeEqual } from './crypto_util.js';

// Fields Ottu uses to compute the webhook signature, per
// https://docs.ottu.net/developers/webhooks/verify-signatures
// Filtered to keys present with non-empty values, sorted alphabetically,
// concatenated as "k1v1k2v2..." then HMAC-SHA256(secret, message).
const SIGNATURE_FIELDS = [
  'amount',
  'currency_code',
  'customer_first_name',
  'customer_last_name',
  'customer_email',
  'customer_phone',
  'customer_address_line1',
  'customer_address_line2',
  'customer_address_city',
  'customer_address_state',
  'customer_address_country',
  'customer_address_postal_code',
  'gateway_account',
  'gateway_name',
  'order_no',
  'reference_number',
  'result',
  'state',
];

/**
 * Create an Ottu checkout session and return { session_id, checkout_url }.
 *
 * @param {object} env - Worker env (needs OTTU_API_KEY, OTTU_BASE_URL, OTTU_PG_CODES, WORKER_BASE_URL)
 * @param {object} args - { phone, amountKwd, orderNo, customerFirstName? }
 */
export async function createCheckout(env, { phone, amountKwd, orderNo, customerFirstName }) {
  const baseUrl = env.OTTU_BASE_URL?.replace(/\/$/, '');
  const apiKey = env.OTTU_API_KEY;
  const pgCodes = (env.OTTU_PG_CODES || 'knet').split(',').map(s => s.trim()).filter(Boolean);
  const workerBase = env.WORKER_BASE_URL?.replace(/\/$/, '');

  if (!baseUrl || !apiKey || !workerBase) {
    throw new Error('Ottu config missing: need OTTU_BASE_URL, OTTU_API_KEY, WORKER_BASE_URL');
  }

  const amountStr = amountKwd.toFixed(3);

  // Production Ottu plugin config marks merchant_defined_data 3-8 and 20 as
  // required. Ottu rejects the create call without them ("This field is
  // required"). We don't actually use these slots downstream — they exist
  // only to satisfy the plugin's required-field check — so we populate them
  // with sensible non-empty values derived from what we already have.
  const extra = {
    merchant_defined_data3: phone,
    merchant_defined_data4: 'yearly',
    merchant_defined_data5: amountStr,
    merchant_defined_data6: orderNo,
    merchant_defined_data7: 'whatsapp',
    merchant_defined_data8: customerFirstName || phone,
    merchant_defined_data20: 'aljarida',
  };

  const body = {
    type: 'e_commerce',
    pg_codes: pgCodes,
    amount: amountStr,
    currency_code: 'KWD',
    customer_phone: phone,
    customer_id: phone,
    order_no: orderNo,
    webhook_url: `${workerBase}/payment/webhook`,
    redirect_url: `${workerBase}/payment/success`,
    payment_type: 'one_off',
    extra,
    ...(customerFirstName ? { customer_first_name: customerFirstName } : {}),
  };

  const res = await fetch(`${baseUrl}/b/checkout/v1/pymt-txn/`, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ottu checkout failed: ${res.status} ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ottu returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!data.session_id || !data.checkout_url) {
    throw new Error(`Ottu response missing session_id or checkout_url: ${text.slice(0, 200)}`);
  }

  return { session_id: data.session_id, checkout_url: data.checkout_url, raw: data };
}

/**
 * Cancel an unpaid Ottu checkout session via the Operations API.
 *
 * Internal operation — no PG roundtrip, instant. Applicable to transactions
 * in `created`, `pending`, `cod`, or `attempted` state. Ottu rejects cancel
 * on `paid` (use refund) and `canceled` (already canceled — caller should
 * treat as success).
 *
 * https://docs.ottu.net/developers/operations
 */
export async function cancelCheckout(env, sessionId) {
  const baseUrl = env.OTTU_BASE_URL?.replace(/\/$/, '');
  const apiKey = env.OTTU_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('Ottu config missing: need OTTU_BASE_URL, OTTU_API_KEY');
  }

  const res = await fetch(`${baseUrl}/b/pbl/v2/operation/`, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operation: 'cancel', session_id: sessionId }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ottu cancel failed: ${res.status} ${text}`);
  }

  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Refund (full or partial) a paid Ottu transaction via the Operations API.
 *
 * External operation — Ottu actually calls the payment gateway, which moves
 * funds back to the customer's card/KNET. Supports partial: pass `amountKwd`
 * to refund less than the original total. Pass null/undefined to refund the
 * full remaining amount (Ottu defaults to that).
 *
 * Caller is responsible for tracking cumulative refunded amount locally —
 * Ottu accepts repeated partial refund calls as long as the sum stays
 * below the original amount.
 *
 * https://docs.ottu.net/developers/operations
 */
export async function refundCheckout(env, sessionId, amountKwd) {
  const baseUrl = env.OTTU_BASE_URL?.replace(/\/$/, '');
  const apiKey = env.OTTU_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error('Ottu config missing: need OTTU_BASE_URL, OTTU_API_KEY');
  }

  const body = { operation: 'refund', session_id: sessionId };
  if (amountKwd != null) body.amount = Number(amountKwd).toFixed(3);

  const res = await fetch(`${baseUrl}/b/pbl/v2/operation/`, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ottu refund failed: ${res.status} ${text}`);
  }

  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Verify an Ottu webhook payload's HMAC-SHA256 signature.
 * Returns true iff the computed signature matches `payload.signature`.
 */
export async function verifyOttuSignature(payload, secret) {
  if (!payload || typeof payload !== 'object') return false;
  if (!secret) return false;
  const provided = payload.signature;
  if (typeof provided !== 'string' || !provided) return false;

  const message = buildSignatureMessage(payload);
  const expected = await hmacSha256Hex(secret, message);
  return timingSafeEqual(provided.toLowerCase(), expected);
}

/**
 * Build the canonical message string Ottu signs.
 * Exposed for testing / debugging signature mismatches.
 */
export function buildSignatureMessage(payload) {
  const present = SIGNATURE_FIELDS
    .filter(k => payload[k] !== undefined && payload[k] !== null && String(payload[k]) !== '')
    .sort();
  return present.map(k => `${k}${payload[k]}`).join('');
}

async function hmacSha256Hex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
