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

import { verifyOttuSignature } from './ottu.js';
import { recordPayment, PRICING, PLAN_YEARLY } from './subscription.js';
import { sendTextMessage } from './whatsapp.js';

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
    );

    // Update subscriber state from awaiting_payment -> active is handled
    // inside recordPayment (it sets state = 'active'). Send a confirmation.
    await sendTextMessage(
      env,
      intent.phone,
      `تم استلام دفعتك بنجاح ✅\n\nاشتراكك مفعّل لمدة سنة كاملة. شكراً لاختيارك جريدة الجريدة الرقمية.`
    );
  } catch (err) {
    console.error('[ottu] activatePaidSubscription failed', err);
  }
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
