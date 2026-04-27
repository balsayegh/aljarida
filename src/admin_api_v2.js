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
import { createAndSendCheckoutLink } from './payment.js';
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
export async function extendSubscriptionAction(request, env, phone) {
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
  });

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
export async function changePhoneAction(request, env, phone) {
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
    await logEvent(env, new_phone, 'phone_change_requested', {
      old_phone: phone,
      new_phone: new_phone,
      reason: reason || null,
      expires_at: expiresAt,
    });

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
export async function addTagAction(request, env, phone) {
  const { tag } = await request.json();
  if (!tag || !tag.trim()) return jsonResponse({ error: 'Tag required' }, 400);
  const cleaned = tag.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(cleaned) && !/^[\u0600-\u06FF\s]+$/.test(tag.trim())) {
    return jsonResponse({ error: 'Tag must be alphanumeric (English) or Arabic' }, 400);
  }
  try {
    const tags = await addTag(env, phone, tag.trim());
    return jsonResponse({ success: true, tags });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}

/**
 * DELETE /admin/api/subscribers/:phone/tags/:tag
 */
export async function removeTagAction(request, env, phone, tag) {
  try {
    const tags = await removeTag(env, phone, tag);
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
export async function changePlanAction(request, env, phone) {
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
  });

  return jsonResponse({ success: true, plan, subscription_end_at: newEndAt });
}

/**
 * POST /admin/api/subscribers/:phone/payments
 * Body: { amount_kwd, method, reference?, notes?, plan?, payment_date? }
 */
export async function addPaymentAction(request, env, phone) {
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
      reference || null, notes || null, plan || PLAN_YEARLY
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
export async function sendPaymentLinkAction(request, env, phone) {
  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) return jsonResponse({ error: 'المشترك غير موجود' }, 404);
  if (sub.state === 'unsubscribed') {
    return jsonResponse({ error: 'لا يمكن إرسال رابط دفع لمن ألغى الاشتراك' }, 409);
  }

  const result = await createAndSendCheckoutLink(env, phone, sub);

  if (result.success) {
    await logEvent(env, phone, 'payment_link_sent', {
      session_id: result.sessionId,
      sent_by: 'admin',
    }, 'admin');
    return jsonResponse({ success: true, session_id: result.sessionId, checkout_url: result.checkoutUrl });
  }

  // Distinguish "Ottu refused" (Ottu down / config issue) from "WhatsApp send
  // failed" (subscriber outside 24h CSW). The latter still leaves a usable
  // checkout_url the admin can copy/paste manually.
  if (result.error === 'whatsapp_send_failed') {
    await logEvent(env, phone, 'payment_link_send_failed', {
      session_id: result.sessionId,
      reason: 'whatsapp_send_failed',
    }, 'admin');
    return jsonResponse({
      error: 'تم إنشاء الرابط في Ottu لكن فشل إرساله عبر واتساب (قد يكون خارج نافذة 24 ساعة). الرابط:',
      checkout_url: result.checkoutUrl,
    }, 502);
  }

  return jsonResponse({ error: result.error || 'فشل إنشاء رابط الدفع' }, 502);
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
