/**
 * Admin API endpoints for subscription management v2.
 *
 * Handles:
 *   - GET  /admin/api/subscribers/:phone — full detail with events + payments
 *   - POST /admin/api/subscribers/:phone/extend — add days to subscription
 *   - POST /admin/api/subscribers/:phone/change-phone — migrate to new number
 *   - POST /admin/api/subscribers/:phone/tags — add tag
 *   - DELETE /admin/api/subscribers/:phone/tags/:tag — remove tag
 *   - POST /admin/api/subscribers/:phone/plan — change plan type
 *   - POST /admin/api/subscribers/:phone/payments — record manual payment
 *   - GET  /admin/api/subscribers/:phone/events — event history
 *   - GET  /admin/api/subscribers/:phone/payments — payment history
 */

import {
  extendSubscription, activateSubscriber, recordPayment,
  logEvent, addTag, removeTag, parseTags, parsePreviousPhones,
  maskPhone, calculateEndAt, daysRemaining, expiryStatus,
  PLAN_YEARLY, PLAN_PILOT, PLAN_GIFT,
} from './subscription.js';
import { sendPhoneChangeVerification } from './whatsapp_v2.js';
import { sendTextMessage, sendDailyDeliveryTemplate } from './whatsapp.js';
import { createAndSendCheckoutLink } from './payment.js';
import { cancelCheckout, refundCheckout } from './ottu.js';
import { jsonResponse } from './admin.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PHONE_CHANGE_TIMEOUT_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * GET /admin/api/subscribers/:phone
 * Returns full subscriber detail with computed fields + recent events/payments.
 */
export async function getSubscriberDetail(request, env, phone) {
  const sub = await env.DB.prepare(
    `SELECT * FROM subscribers WHERE phone = ?`
  ).bind(phone).first();

  if (!sub) return jsonResponse({ error: 'Subscriber not found' }, 404);

  // Get recent events
  const { results: events } = await env.DB.prepare(
    `SELECT * FROM subscription_events
     WHERE phone = ?
     ORDER BY created_at DESC
     LIMIT 50`
  ).bind(phone).all();

  // Get payments
  const { results: payments } = await env.DB.prepare(
    `SELECT * FROM payments WHERE phone = ? ORDER BY payment_date DESC`
  ).bind(phone).all();

  // Get recent Ottu checkout intents (in-flight + history). The big
  // raw_webhook blob is intentionally excluded — admin UI doesn't need it
  // and it can be 10s of KB per row.
  const { results: paymentIntents } = await env.DB.prepare(
    `SELECT session_id, order_no, amount_kwd, plan, state, checkout_url,
            created_at, paid_at
     FROM payment_intents
     WHERE phone = ?
     ORDER BY created_at DESC
     LIMIT 10`
  ).bind(phone).all();

  // Get recent broadcast deliveries
  const { results: deliveries } = await env.DB.prepare(
    `SELECT br.*, b.date_string, b.started_at as broadcast_date
     FROM broadcast_recipients br
     LEFT JOIN broadcasts b ON b.id = br.broadcast_id
     WHERE br.phone = ?
     ORDER BY br.created_at DESC
     LIMIT 20`
  ).bind(phone).all();

  // Calculate derived fields
  const tags = parseTags(sub.tags);
  const previousPhones = parsePreviousPhones(sub.previous_phones);
  const days = daysRemaining(sub);
  const expiryStat = expiryStatus(sub);
  const hasPendingPhoneChange = !!sub.phone_change_pending;

  // Calculate read rate
  const totalDelivered = deliveries.filter(d => ['delivered', 'read'].includes(d.delivery_status)).length;
  const totalRead = deliveries.filter(d => d.delivery_status === 'read').length;
  const readRate = totalDelivered > 0 ? Math.round((totalRead / totalDelivered) * 100) : null;

  return jsonResponse({
    subscriber: {
      ...sub,
      tags,
      previous_phones: previousPhones,
      days_remaining: days === Infinity ? null : days,
      expiry_status: expiryStat,
      has_pending_phone_change: hasPendingPhoneChange,
      phone_change_pending: sub.phone_change_pending ? JSON.parse(sub.phone_change_pending) : null,
      read_rate: readRate,
    },
    events,
    payments,
    payment_intents: paymentIntents,
    recent_deliveries: deliveries.slice(0, 10),
  });
}

/**
 * POST /admin/api/subscribers/:phone/extend
 * Body: { days: number, reason?: string }
 */
export async function extendSubscriptionAction(request, env, phone, actor) {
  const { days, reason } = await request.json();

  if (!days || days <= 0 || days > 3650) {
    return jsonResponse({ error: 'عدد الأيام يجب أن يكون بين 1 و 3650' }, 400);
  }

  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'Subscriber not found' }, 404);

  const newEndAt = extendSubscription(sub.subscription_end_at, days);

  await env.DB.prepare(
    `UPDATE subscribers
     SET subscription_end_at = ?,
         last_reminder_sent_at = NULL,
         last_reminder_days_before = NULL
     WHERE phone = ?`
  ).bind(newEndAt, phone).run();

  // If they were paused due to expiry, reactivate
  if (sub.state === 'paused') {
    await env.DB.prepare(`UPDATE subscribers SET state = 'active' WHERE phone = ?`).bind(phone).run();
  }

  await logEvent(env, phone, 'extended', {
    days,
    reason: reason || null,
    new_end_at: newEndAt,
    previous_end_at: sub.subscription_end_at,
  }, actor.email);

  return jsonResponse({ success: true, new_end_at: newEndAt, days_added: days });
}

/**
 * POST /admin/api/subscribers/:phone/change-phone
 * Body: { new_phone: string, reason?: string, skip_verification?: boolean }
 *
 * Flow:
 *   1. Validate new phone format
 *   2. Check new phone not already a subscriber
 *   3. Archive old phone in previous_phones
 *   4. Update phone to new number
 *   5. Set phone_change_pending with 24-hour timeout
 *   6. Send verification template to new number
 *   7. Subscriber's new number taps تأكيد or رفض (handled in webhook)
 */
export async function changePhoneAction(request, env, phone, actor) {
  const { new_phone, reason, skip_verification } = await request.json();

  // Validate
  if (!new_phone || !/^\d{10,15}$/.test(new_phone)) {
    return jsonResponse({ error: 'رقم غير صالح — يجب أن يكون 10-15 رقم بدون +' }, 400);
  }
  if (new_phone === phone) {
    return jsonResponse({ error: 'الرقم الجديد مطابق للقديم' }, 400);
  }

  // Check new phone not already a subscriber
  const existing = await env.DB.prepare(
    `SELECT phone FROM subscribers WHERE phone = ?`
  ).bind(new_phone).first();
  if (existing) {
    return jsonResponse({ error: 'الرقم الجديد مستخدم لاشتراك آخر بالفعل' }, 400);
  }

  // Check no orphan history in related tables (e.g. from a deleted subscriber).
  // If found, merging would conflate two users' histories under one phone.
  const orphanTable = await findOrphanHistory(env.DB, new_phone);
  if (orphanTable) {
    return jsonResponse({
      error: `الرقم الجديد له سجلات سابقة في جدول ${orphanTable} — يرجى تنظيف السجلات أولاً`
    }, 400);
  }

  // Get current subscriber
  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'Subscriber not found' }, 404);

  // Check no pending change already
  if (sub.phone_change_pending) {
    return jsonResponse({ error: 'هناك طلب تغيير رقم معلق بالفعل' }, 400);
  }

  // Archive old phone in previous_phones
  const previousPhones = parsePreviousPhones(sub.previous_phones);
  previousPhones.push({
    phone: phone,
    changed_at: Date.now(),
    reason: reason || null,
    changed_to: new_phone,
  });

  const now = Date.now();
  const expiresAt = now + PHONE_CHANGE_TIMEOUT_MS;

  const pendingData = {
    old_phone: phone,
    new_phone: new_phone,
    requested_at: now,
    expires_at: expiresAt,
    reason: reason || null,
  };

  try {
    // Atomically move all phone references from the old number to the new one.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE subscribers
         SET phone = ?,
             previous_phones = ?,
             phone_change_pending = ?
         WHERE phone = ?`
      ).bind(new_phone, JSON.stringify(previousPhones), JSON.stringify(pendingData), phone),
      env.DB.prepare(`UPDATE messages SET phone = ? WHERE phone = ?`).bind(new_phone, phone),
      env.DB.prepare(`UPDATE consent_log SET phone = ? WHERE phone = ?`).bind(new_phone, phone),
      env.DB.prepare(`UPDATE broadcast_recipients SET phone = ? WHERE phone = ?`).bind(new_phone, phone),
      env.DB.prepare(`UPDATE subscription_events SET phone = ? WHERE phone = ?`).bind(new_phone, phone),
      env.DB.prepare(`UPDATE payments SET phone = ? WHERE phone = ?`).bind(new_phone, phone),
    ]);

    // Log event (on new phone now)
    // attribution: actor.email so the timeline shows who initiated
    await logEvent(env, new_phone, 'phone_change_requested', {
      old_phone: phone,
      new_phone: new_phone,
      reason: reason || null,
      expires_at: expiresAt,
    }, actor.email);

    // Send verification template to new phone (unless skipped)
    if (!skip_verification) {
      try {
        await sendPhoneChangeVerification(env, new_phone, maskPhone(phone));
      } catch (err) {
        console.error('Failed to send verification template:', err);
        // Continue anyway — admin can resend or user can contact support
      }
    }

    return jsonResponse({
      success: true,
      old_phone: phone,
      new_phone: new_phone,
      verification_expires_at: expiresAt,
      verification_sent: !skip_verification,
    });
  } catch (err) {
    return jsonResponse({ error: `Failed to change phone: ${err.message}` }, 500);
  }
}

/**
 * POST /admin/api/subscribers/:phone/tags
 * Body: { tag: string }
 */
export async function addTagAction(request, env, phone, actor) {
  const { tag } = await request.json();
  if (!tag || !tag.trim()) return jsonResponse({ error: 'Tag required' }, 400);
  const cleaned = tag.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(cleaned) && !/^[\u0600-\u06FF\s]+$/.test(tag.trim())) {
    return jsonResponse({ error: 'Tag must be alphanumeric (English) or Arabic' }, 400);
  }
  try {
    const tags = await addTag(env, phone, tag.trim(), actor.email);
    return jsonResponse({ success: true, tags });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}

/**
 * DELETE /admin/api/subscribers/:phone/tags/:tag
 */
export async function removeTagAction(request, env, phone, tag, actor) {
  try {
    const tags = await removeTag(env, phone, tag, actor.email);
    return jsonResponse({ success: true, tags });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}

/**
 * POST /admin/api/subscribers/:phone/plan
 * Body: { plan: 'monthly'|'yearly'|'pilot'|'gift', custom_days?: number }
 *
 * Changes the plan type. Does NOT extend subscription; use /extend or /payments for that.
 */
export async function changePlanAction(request, env, phone, actor) {
  const { plan, custom_days } = await request.json();
  const validPlans = [PLAN_YEARLY, PLAN_PILOT, PLAN_GIFT];
  if (!validPlans.includes(plan)) {
    return jsonResponse({ error: `Plan must be one of: ${validPlans.join(', ')}` }, 400);
  }

  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'Subscriber not found' }, 404);

  const oldPlan = sub.subscription_plan;

  // Recalculate end_at if plan changes and we have a start
  let newEndAt = sub.subscription_end_at;
  if (plan !== oldPlan && sub.subscription_start_at) {
    newEndAt = calculateEndAt(sub.subscription_start_at, plan, custom_days);
  }

  await env.DB.prepare(
    `UPDATE subscribers SET subscription_plan = ?, subscription_end_at = ? WHERE phone = ?`
  ).bind(plan, newEndAt, phone).run();

  await logEvent(env, phone, 'plan_changed', {
    old_plan: oldPlan,
    new_plan: plan,
    custom_days: custom_days || null,
    new_end_at: newEndAt,
  }, actor.email);

  return jsonResponse({ success: true, plan, subscription_end_at: newEndAt });
}

/**
 * POST /admin/api/subscribers/:phone/payments
 * Body: { amount_kwd, method, reference?, notes?, plan?, payment_date? }
 */
export async function addPaymentAction(request, env, phone, actor) {
  const body = await request.json();
  const { amount_kwd, method, reference, notes, plan } = body;

  if (!amount_kwd || amount_kwd <= 0) {
    return jsonResponse({ error: 'المبلغ مطلوب ويجب أن يكون أكبر من صفر' }, 400);
  }
  if (!method) {
    return jsonResponse({ error: 'طريقة الدفع مطلوبة' }, 400);
  }

  try {
    const result = await recordPayment(
      env, phone, parseFloat(amount_kwd), method,
      reference || null, notes || null, plan || PLAN_YEARLY,
      actor.email,
    );
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}

/**
 * POST /admin/api/subscribers/:phone/send-payment-link
 *
 * Admin-initiated resend of an Ottu checkout link. Creates a fresh
 * payment_intents row and sends the link over WhatsApp. Refuses on
 * unsubscribed subscribers (don't bypass opt-out).
 */
export async function sendPaymentLinkAction(request, env, phone, actor) {
  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'المشترك غير موجود' }, 404);
  if (sub.state === 'unsubscribed') {
    return jsonResponse({ error: 'لا يمكن إرسال رابط دفع لمن ألغى الاشتراك' }, 409);
  }

  const result = await createAndSendCheckoutLink(env, phone, sub);

  if (result.success) {
    await logEvent(env, phone, 'payment_link_sent', {
      session_id: result.sessionId,
      channel: result.channel || 'unknown',
      sent_by: actor.email,
    }, actor.email);
    return jsonResponse({
      success: true,
      session_id: result.sessionId,
      checkout_url: result.checkoutUrl,
      channel: result.channel,
    });
  }

  // Distinguish three failure modes — each gives the admin a different action:
  //   - csw_closed_no_template : no reliable delivery channel; URL is good,
  //     admin must hand it off out-of-band
  //   - whatsapp_send_failed   : Meta returned an actual error (rare; the
  //     usual silent-drop case never reaches here)
  //   - other / Ottu failure   : Ottu rejected the create call
  if (result.error === 'csw_closed_no_template' || result.error === 'whatsapp_send_failed') {
    await logEvent(env, phone, 'payment_link_send_failed', {
      session_id: result.sessionId,
      reason: result.error,
    }, actor.email);
    const msg = result.error === 'csw_closed_no_template'
      ? 'العميل خارج نافذة الـ24 ساعة وقالب الدفع غير مفعّل. تم إنشاء الرابط — أرسله يدوياً:'
      : 'تم إنشاء الرابط لكن فشل إرساله عبر واتساب. الرابط:';
    return jsonResponse({ error: msg, checkout_url: result.checkoutUrl }, 502);
  }

  return jsonResponse({ error: result.error || 'فشل إنشاء رابط الدفع' }, 502);
}

/**
 * POST /admin/api/subscribers/:phone/resend-last-edition
 *
 * Re-sends the most recent successfully-broadcast edition's PDF to a
 * single subscriber. Uses the approved `aljarida_daily_delivery_ar`
 * template — works regardless of CSW. Logs an `edition_resent` event
 * for the audit timeline.
 *
 * Customer-support primitive: when a subscriber claims they didn't
 * get today's PDF (whether they really lost it or deleted the chat),
 * the operator can re-send without re-broadcasting to everyone.
 */
export async function resendLastEditionAction(request, env, phone, actor) {
  const sub = await env.DB.prepare(
    `SELECT phone, state FROM subscribers WHERE phone = ?`
  ).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'المشترك غير موجود' }, 404);
  if (sub.state === 'unsubscribed') {
    return jsonResponse({ error: 'لا يمكن الإرسال لمن ألغى الاشتراك' }, 409);
  }

  // Most recent broadcast — prefer one that finished successfully, but fall
  // back to the most recent of any status (the PDF URL is what we need).
  const lastBroadcast = await env.DB.prepare(
    `SELECT id, date_string, pdf_url, started_at, status
     FROM broadcasts
     ORDER BY started_at DESC
     LIMIT 1`
  ).first();
  if (!lastBroadcast || !lastBroadcast.pdf_url) {
    return jsonResponse({ error: 'لا يوجد عدد سابق لإعادة إرساله' }, 404);
  }

  try {
    await sendDailyDeliveryTemplate(env, phone, lastBroadcast.pdf_url, lastBroadcast.date_string || '');
  } catch (err) {
    console.error(`[resend] failed for ${phone}:`, err);
    return jsonResponse({ error: 'فشل إرسال العدد: ' + (err.message || 'خطأ غير معروف') }, 502);
  }

  await logEvent(env, phone, 'edition_resent', {
    broadcast_id: lastBroadcast.id,
    date_string: lastBroadcast.date_string,
    pdf_url: lastBroadcast.pdf_url,
  }, actor.email);

  return jsonResponse({
    success: true,
    broadcast_id: lastBroadcast.id,
    date_string: lastBroadcast.date_string,
  });
}

/**
 * POST /admin/api/payments/:payment_id/refund
 * Body: { amount_kwd: number, reason?: string, notify?: boolean }
 *
 * Full or partial refund. Validates the amount against the payment's
 * remaining refundable balance (amount_kwd - refunded_amount_kwd), then
 * calls Ottu's Operations API. On success: updates the payments row
 * cumulatively, transitions state, and — if this completes a full refund —
 * pauses the subscriber and ends their subscription today.
 *
 * `notify=true` attempts a free-form WhatsApp message to the customer.
 * Skipped silently if CSW is closed (no Meta-approved refund template
 * yet — refunds are too rare to warrant one).
 */
export async function refundPaymentAction(request, env, paymentId, actor) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const requestedAmount = parseFloat(body.amount_kwd);
  const reason = (body.reason || '').trim() || null;
  const notify = !!body.notify;

  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return jsonResponse({ error: 'المبلغ المطلوب استرداده غير صالح' }, 400);
  }

  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE id = ?`
  ).bind(paymentId).first();

  if (!payment) return jsonResponse({ error: 'الدفعة غير موجودة' }, 404);
  if (payment.payment_method !== 'ottu' || !payment.reference) {
    return jsonResponse({
      error: 'لا يمكن استرداد دفعة يدوية تلقائياً — استرد من Ottu يدوياً ثم عدّل الحالة عبر SQL.',
    }, 400);
  }

  const refundedSoFar = Number(payment.refunded_amount_kwd) || 0;
  const remaining = Number(payment.amount_kwd) - refundedSoFar;
  // Guard against floating-point cruft (e.g. 12.000 - 11.999 = 0.001000…)
  if (remaining < 0.001) {
    return jsonResponse({ error: 'تم استرداد كامل المبلغ مسبقاً' }, 409);
  }
  if (requestedAmount > remaining + 0.001) {
    return jsonResponse({
      error: `المبلغ المطلوب أكبر من المتاح للاسترداد (${remaining.toFixed(3)} د.ك)`,
    }, 400);
  }

  // Call Ottu. If it throws, we don't touch local state — the customer
  // wasn't charged anything new and our row stays consistent.
  try {
    await refundCheckout(env, payment.reference, requestedAmount);
  } catch (err) {
    console.error(`[refund] Ottu rejected refund for payment id=${paymentId}:`, err);
    return jsonResponse({ error: err.message || 'فشل الاسترداد في Ottu' }, 502);
  }

  // Update payments row cumulatively. New state depends on whether this
  // empties the refundable balance.
  const newRefunded = refundedSoFar + requestedAmount;
  const isFullRefund = newRefunded + 0.001 >= Number(payment.amount_kwd);
  const newState = isFullRefund ? 'refunded' : 'partially_refunded';

  await env.DB.prepare(
    `UPDATE payments
     SET refunded_amount_kwd = ?, state = ?
     WHERE id = ?`
  ).bind(newRefunded, newState, paymentId).run();

  // Subscription consequence: only on FULL refund. Partial refunds leave
  // the subscription untouched — operator can adjust manually if needed.
  let subscriptionTerminated = false;
  if (isFullRefund) {
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE subscribers
       SET state = 'paused',
           subscription_end_at = ?,
           updated_at = ?
       WHERE phone = ?`
    ).bind(now, now, payment.phone).run();
    subscriptionTerminated = true;
  }

  await logEvent(env, payment.phone, 'payment_refunded', {
    payment_id: paymentId,
    session_id: payment.reference,
    amount_kwd: requestedAmount,
    refunded_total: newRefunded,
    is_full: isFullRefund,
    reason,
    subscription_terminated: subscriptionTerminated,
  }, actor.email);

  // Optional customer WhatsApp note. Free-form only — needs CSW open.
  let notified = false;
  if (notify) {
    const sub = await env.DB.prepare(
      `SELECT csw_open_until FROM subscribers WHERE phone = ?`
    ).bind(payment.phone).first();
    const cswOpen = sub?.csw_open_until && sub.csw_open_until > Date.now();
    if (cswOpen) {
      try {
        const msg = isFullRefund
          ? `تم استرداد كامل المبلغ (${requestedAmount.toFixed(3)} د.ك) من اشتراكك في *جريدة الجريدة* النسخة الرقمية.${reason ? '\n\nالسبب: ' + reason : ''}`
          : `تم استرداد جزئي بقيمة ${requestedAmount.toFixed(3)} د.ك من اشتراكك في *جريدة الجريدة* النسخة الرقمية.${reason ? '\n\nالسبب: ' + reason : ''}`;
        await sendTextMessage(env, payment.phone, msg);
        notified = true;
      } catch (err) {
        console.warn(`[refund] customer notify failed for ${payment.phone}:`, err);
      }
    }
  }

  return jsonResponse({
    success: true,
    refunded_amount_kwd: requestedAmount,
    refunded_total_kwd: newRefunded,
    state: newState,
    subscription_terminated: subscriptionTerminated,
    notified,
  });
}

/**
 * POST /admin/api/payment-intents/:session_id/cancel
 *
 * Cancel an unpaid Ottu checkout session. Internal Ottu operation — no
 * money has moved and no PG roundtrip. Idempotent: a second call on an
 * already-canceled intent returns success.
 *
 * Refuses to touch a `paid` intent (operator should use refund instead,
 * once that flow exists).
 */
export async function cancelPaymentIntentAction(request, env, sessionId, actor) {
  const intent = await env.DB.prepare(
    `SELECT * FROM payment_intents WHERE session_id = ?`
  ).bind(sessionId).first();

  if (!intent) return jsonResponse({ error: 'الرابط غير موجود' }, 404);

  if (intent.state === 'paid') {
    return jsonResponse({
      error: 'الرابط مدفوع بالفعل — لا يمكن إلغاؤه. استخدم الاسترداد بدلاً من ذلك.',
    }, 409);
  }

  if (intent.state === 'canceled' || intent.state === 'cancelled') {
    return jsonResponse({ success: true, already_canceled: true });
  }

  // Try cancel in Ottu. If Ottu rejects with an "invalid state" / "does not
  // exist" 400, it usually means the session has aged out on Ottu's side
  // (their default expiry is 7-30 days). The intent is functionally dead
  // either way, so flip our local row to canceled rather than leave it
  // forever in 'pending' nagging the dashboard.
  let ottuStaleSession = false;
  try {
    await cancelCheckout(env, sessionId);
  } catch (err) {
    const msg = err?.message || '';
    const looksStale =
      msg.includes('invalid state') ||
      msg.includes('does not exist');
    if (!looksStale) {
      console.error(`[ottu] cancel failed for ${sessionId}:`, err);
      return jsonResponse({ error: msg || 'فشل إلغاء الرابط في Ottu' }, 502);
    }
    console.warn(`[ottu] cancel rejected (treating as already-dead) for ${sessionId}:`, msg);
    ottuStaleSession = true;
  }

  await env.DB.prepare(
    `UPDATE payment_intents SET state = 'canceled' WHERE session_id = ?`
  ).bind(sessionId).run();

  await logEvent(env, intent.phone, 'payment_link_canceled', {
    session_id: sessionId,
    canceled_by: actor.email,
    ottu_stale: ottuStaleSession,
  }, actor.email);

  return jsonResponse({ success: true, ottu_stale: ottuStaleSession });
}

/**
 * GET /admin/api/subscribers/:phone/events
 */
export async function getEvents(request, env, phone) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM subscription_events WHERE phone = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(phone).all();
  return jsonResponse({ events: results });
}

/**
 * GET /admin/api/subscribers/:phone/payments
 */
export async function getPayments(request, env, phone) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM payments WHERE phone = ? ORDER BY payment_date DESC`
  ).bind(phone).all();
  return jsonResponse({ payments: results });
}

/**
 * Check whether a phone number has history rows in any non-subscribers table
 * (left over from a previously-deleted subscriber). Returns the table name of
 * the first match, or null. Used to block phone changes that would merge two
 * users' histories.
 */
async function findOrphanHistory(db, phone) {
  const tables = ['messages', 'consent_log', 'broadcast_recipients', 'subscription_events', 'payments'];
  for (const table of tables) {
    const row = await db.prepare(`SELECT 1 FROM ${table} WHERE phone = ? LIMIT 1`).bind(phone).first();
    if (row) return table;
  }
  return null;
}
