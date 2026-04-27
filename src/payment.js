/**
 * Ottu webhook + redirect handlers.
 *
 * - POST /payment/webhook : Ottu posts payment events here. Verify HMAC,
 *   look up the intent, call recordPayment() on first transition to 'paid'.
 * - GET  /payment/success : where Ottu redirects the customer's browser
 *   after a successful payment. We render a thank-you page; the actual
 *   subscription activation has already happened (or will, idempotently)
 *   via the webhook.
 *
 * Returning 200 to Ottu's webhook tells it to redirect the customer to our
 * redirect_url. Anything else keeps them on the Ottu summary page.
 */

import { createCheckout, verifyOttuSignature } from './ottu.js';
import { recordPayment, PRICING, PLAN_YEARLY } from './subscription.js';
import { sendTextMessage, sendPaymentLinkTemplate } from './whatsapp.js';
import { messages as t } from './templates.js';

/**
 * Create a fresh Ottu checkout for a subscriber, persist a payment_intents
 * row, and send the checkout link over WhatsApp.
 *
 * Shared between:
 *  - the inbound WhatsApp flow (subscriber clicked نعم)
 *  - the admin "send payment link" button (support-initiated resend)
 *
 * Delivery strategy (in order):
 *   1. WhatsApp template message (if env.WHATSAPP_PAYMENT_TEMPLATE_NAME is
 *      set AND the template is approved by Meta). Works inside or outside
 *      the 24h CSW window — this is the durable channel.
 *   2. Free-form text — fallback when no template is configured. Only
 *      attempted when subscriber.csw_open_until > now, because Meta
 *      silently swallows free-form messages outside CSW (returns 200 OK,
 *      never delivers). Sending into the void is worse than failing loud.
 *   3. Fail with `csw_closed_no_template`. Caller surfaces the URL to the
 *      admin for out-of-band delivery.
 *
 * Returns:
 *   { success: true,  sessionId, checkoutUrl, channel }
 *   { success: false, sessionId, checkoutUrl, error }     (intent persisted)
 *   { success: false, error }                              (Ottu failure)
 */
export async function createAndSendCheckoutLink(env, phone, subscriber) {
  const plan = PLAN_YEARLY;
  const amountKwd = PRICING[plan];
  const orderNo = `aljarida-${phone}-${Date.now()}`;

  let checkout;
  try {
    checkout = await createCheckout(env, {
      phone,
      amountKwd,
      orderNo,
      customerFirstName: subscriber?.profile_name || undefined,
    });
  } catch (err) {
    console.error(`[ottu] checkout creation failed for ${phone}:`, err);
    // Best-effort fallback message; only attempt if CSW is open.
    if (subscriber?.csw_open_until && subscriber.csw_open_until > Date.now()) {
      sendTextMessage(env, phone, t.paymentPromptFallback).catch(() => {});
    }
    return { success: false, error: err.message || 'Ottu checkout creation failed' };
  }

  const { session_id, checkout_url } = checkout;

  await env.DB.prepare(
    `INSERT INTO payment_intents
      (session_id, order_no, phone, amount_kwd, plan, state, checkout_url, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(session_id, orderNo, phone, amountKwd, plan, checkout_url, Date.now()).run();

  const cswOpen = !!(subscriber?.csw_open_until && subscriber.csw_open_until > Date.now());
  const templateConfigured = !!env.WHATSAPP_PAYMENT_TEMPLATE_NAME;

  // Strategy 1: template (preferred — works in/out of CSW)
  if (templateConfigured) {
    try {
      await sendPaymentLinkTemplate(env, phone, subscriber?.profile_name, amountKwd, session_id);
      return { success: true, sessionId: session_id, checkoutUrl: checkout_url, channel: 'template' };
    } catch (err) {
      console.warn(`[ottu] template send failed for ${phone} (will try free-form if CSW open):`, err);
      // Fall through.
    }
  }

  // Strategy 2: free-form text (only if CSW open — outside CSW Meta drops
  // the message silently)
  if (cswOpen) {
    try {
      await sendTextMessage(env, phone, `${t.paymentPromptIntro}\n\n${checkout_url}\n\n${t.paymentPromptOutro}`);
      return { success: true, sessionId: session_id, checkoutUrl: checkout_url, channel: 'freeform' };
    } catch (err) {
      console.error(`[ottu] free-form send failed for ${phone}:`, err);
      return { success: false, sessionId: session_id, checkoutUrl: checkout_url, error: 'whatsapp_send_failed' };
    }
  }

  // Strategy 3: nothing reliable — surface URL so admin can deliver manually
  console.warn(`[ottu] no delivery channel for ${phone} (CSW closed, no template)`);
  return { success: false, sessionId: session_id, checkoutUrl: checkout_url, error: 'csw_closed_no_template' };
}

export async function handleOttuWebhook(request, env, ctx) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    console.warn('[ottu] webhook: invalid JSON');
    return new Response('Bad Request', { status: 400 });
  }

  const valid = await verifyOttuSignature(payload, env.OTTU_WEBHOOK_SECRET);
  if (!valid) {
    console.warn('[ottu] webhook: signature verification failed', {
      session_id: payload.session_id,
      order_no: payload.order_no,
    });
    return new Response('Forbidden', { status: 403 });
  }

  const sessionId = payload.session_id;
  const state = payload.state;
  const result = payload.result;

  if (!sessionId) {
    console.warn('[ottu] webhook: missing session_id');
    return new Response('OK', { status: 200 });
  }

  const intent = await env.DB.prepare(
    `SELECT * FROM payment_intents WHERE session_id = ?`
  ).bind(sessionId).first();

  if (!intent) {
    console.warn(`[ottu] webhook: unknown session_id ${sessionId}`);
    return new Response('OK', { status: 200 });
  }

  // Update intent state regardless of outcome (paid / failed / canceled / pending).
  // Idempotency: if it's already 'paid' we skip the second activation but still ack 200.
  if (state === 'paid' && result === 'success' && intent.state !== 'paid') {
    ctx.waitUntil(activatePaidSubscription(env, intent, payload));
  } else if (intent.state !== state) {
    await env.DB.prepare(
      `UPDATE payment_intents SET state = ?, raw_webhook = ? WHERE session_id = ?`
    ).bind(state || intent.state, JSON.stringify(payload), sessionId).run();
  }

  return new Response('OK', { status: 200 });
}

async function activatePaidSubscription(env, intent, payload) {
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE payment_intents
       SET state = 'paid', paid_at = ?, raw_webhook = ?
       WHERE session_id = ? AND state != 'paid'`
    ).bind(now, JSON.stringify(payload), intent.session_id).run();

    await recordPayment(
      env,
      intent.phone,
      intent.amount_kwd,
      'ottu',
      intent.session_id,
      `Ottu order_no=${intent.order_no}`,
      intent.plan || PLAN_YEARLY,
      'system',
      extractPaymentExtras(payload),
    );

    // Update subscriber state from awaiting_payment -> active is handled
    // inside recordPayment (it sets state = 'active'). Send a confirmation.
    await sendTextMessage(
      env,
      intent.phone,
      `تم استلام دفعتك بنجاح ✅\n\nتم تفعيل اشتراكك لمدة سنة كاملة. شكراً لاختيارك *جريدة الجريدة* النسخة الرقمية.`
    );
  } catch (err) {
    console.error('[ottu] activatePaidSubscription failed', err);
  }
}

/**
 * Pull the small set of gateway-specific fields we promote to typed columns
 * on the payments table. Everything else lives in payment_intents.raw_webhook
 * for forensic lookups.
 *
 * Note on pg_params shape: Ottu wraps most pg_params fields in an object with
 * { value, verbose_name_en, verbose_name_ar } rather than returning a flat
 * string (despite what the public docs imply). Some fields (rrn, card_number)
 * may also come back as plain `null` when the gateway doesn't supply them.
 * `unwrap()` handles both shapes.
 */
function extractPaymentExtras(payload) {
  const pg = payload.pg_params || {};
  return {
    gateway: payload.gateway_account || null,
    // Prefer RRN (the universal bank reconciliation key); fall back to
    // transaction_id for gateways that don't expose RRN (e.g. KNET).
    pgReference: unwrap(pg.rrn) || unwrap(pg.transaction_id) || null,
    cardLast4: extractCardLast4(unwrap(pg.card_number)),
    state: payload.state || null,
    paymentDate: parseOttuTimestamp(payload.timestamp_utc),
  };
}

/**
 * Unwrap Ottu's `{ value, verbose_name_en, verbose_name_ar }` pg_params
 * shape to a plain scalar. Returns null for null/undefined; passes scalars
 * through unchanged.
 */
function unwrap(v) {
  if (v == null) return null;
  if (typeof v === 'object' && 'value' in v) return v.value ?? null;
  return v;
}

function extractCardLast4(masked) {
  // Ottu masks like '411111******1111' or '411111XXXXXX1111'. Take last 4
  // and only return them if they're digits — anything else (e.g. KNET, where
  // card_number isn't present) becomes null.
  if (!masked || typeof masked !== 'string') return null;
  const last4 = masked.slice(-4);
  return /^\d{4}$/.test(last4) ? last4 : null;
}

function parseOttuTimestamp(ts) {
  // Ottu sends `timestamp_utc` as 'YYYY-MM-DD HH:MM:SS' (UTC, no tz marker).
  // JS's Date parser is inconsistent across runtimes for that format, so we
  // normalize to ISO 8601 with an explicit Z. Returns null on parse failure
  // so recordPayment falls back to Date.now().
  if (!ts || typeof ts !== 'string') return null;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export async function handlePaymentSuccess(request, env) {
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تم الدفع بنجاح — جريدة الجريدة الرقمية</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #f8f8f5; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { max-width: 460px; background: white; border-radius: 16px; padding: 40px 28px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
  .check { width: 64px; height: 64px; border-radius: 50%; background: #10b981; color: white; font-size: 36px; line-height: 64px; margin: 0 auto 20px; }
  h1 { font-size: 22px; margin: 0 0 12px; color: #111; }
  p  { font-size: 16px; line-height: 1.7; color: #444; margin: 0 0 8px; }
  small { color: #888; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>تم الدفع بنجاح</h1>
    <p>تم تفعيل اشتراكك السنوي في جريدة الجريدة الرقمية.</p>
    <p>سيصلك أول عدد على واتساب صباح الغد.</p>
    <p><small>يمكنك إغلاق هذه الصفحة.</small></p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
