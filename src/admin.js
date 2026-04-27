/**
 * Admin router and authentication.
 *
 * Pages:
 *   GET  /admin                      → dashboard (stats + send today)
 *   GET  /admin/subscribers          → subscriber list
 *   GET  /admin/subscribers/:phone   → single subscriber detail
 *   GET  /admin/broadcasts           → broadcast history
 *   GET  /admin/broadcasts/:id       → broadcast detail with per-recipient status
 *
 * API endpoints:
 *   POST /admin/login
 *   POST /admin/logout
 *   GET  /admin/api/stats
 *   GET  /admin/api/subscribers?state=X&search=Y
 *   POST /admin/api/subscribers/add
 *   PATCH /admin/api/subscribers/:phone
 *   DELETE /admin/api/subscribers/:phone
 *   POST /admin/api/broadcast
 *   GET  /admin/api/broadcasts
 *   GET  /admin/api/broadcasts/:id
 *
 *   [v2 additions]
 *   GET  /admin/api/subscribers/:phone         → full detail with events + payments
 *   POST /admin/api/subscribers/:phone/extend  → extend subscription
 *   POST /admin/api/subscribers/:phone/change-phone  → change phone with verification
 *   POST /admin/api/subscribers/:phone/tags    → add tag
 *   DELETE /admin/api/subscribers/:phone/tags/:tag  → remove tag
 *   POST /admin/api/subscribers/:phone/plan    → change plan type
 *   POST /admin/api/subscribers/:phone/payments → record manual payment
 *   GET  /admin/api/subscribers/:phone/payments → list payments
 *   GET  /admin/api/subscribers/:phone/events  → event history
 */

import { renderLoginPage } from './admin_pages.js';
import { renderDashboardPage, renderSubscribersPage, renderBroadcastsPage, renderBroadcastDetailPage, renderFailuresPage } from './admin_pages.js';
import { renderSubscriberDetailPage } from './admin_subscriber_detail.js';
import { renderPaymentsPage, handlePaymentsApi } from './admin_payments.js';
import { handleBroadcast } from './admin_broadcast.js';
import {
  getSubscriberDetail, extendSubscriptionAction, changePhoneAction,
  addTagAction, removeTagAction, changePlanAction, addPaymentAction,
  getEvents, getPayments, sendPaymentLinkAction, cancelPaymentIntentAction,
} from './admin_api_v2.js';
import { timingSafeEqual } from './crypto_util.js';
import { getKuwaitDateParts } from './date_util.js';
import { createAndSendCheckoutLink } from './payment.js';
import { sendGiftWelcomeTemplate } from './whatsapp.js';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

export async function handleAdminRequest(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/admin/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  const isAuthed = await verifySession(request, env);

  if (!isAuthed) {
    // JSON 401 for API calls; login page for any HTML route (so new pages work without this list)
    if (method === 'GET' && !path.startsWith('/admin/api/')) {
      return htmlResponse(renderLoginPage());
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (path === '/admin/logout' && method === 'POST') {
    return handleLogout();
  }

  // HTML pages
  if (method === 'GET') {
    if (path === '/admin') return htmlResponse(renderDashboardPage());
    if (path === '/admin/subscribers') return htmlResponse(renderSubscribersPage());
    if (path === '/admin/payments') return htmlResponse(renderPaymentsPage());
    if (path === '/admin/broadcasts') return htmlResponse(renderBroadcastsPage());
    if (path === '/admin/failures') return htmlResponse(renderFailuresPage());

    const subDetailMatch = path.match(/^\/admin\/subscribers\/([^\/]+)$/);
    if (subDetailMatch) return htmlResponse(renderSubscriberDetailPage(decodeURIComponent(subDetailMatch[1])));

    const bcMatch = path.match(/^\/admin\/broadcasts\/(\d+)$/);
    if (bcMatch) return htmlResponse(renderBroadcastDetailPage(bcMatch[1]));
  }

  // JSON API endpoints
  if (path === '/admin/api/stats' && method === 'GET') {
    return handleApiStats(env);
  }

  if (path === '/admin/api/subscribers' && method === 'GET') {
    return handleApiSubscribersList(request, env);
  }

  if (path === '/admin/api/subscribers/add' && method === 'POST') {
    return handleApiSubscriberAdd(request, env);
  }

  const apiDetailMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)$/);
  if (apiDetailMatch && method === 'GET') {
    return getSubscriberDetail(request, env, apiDetailMatch[1]);
  }
  if (apiDetailMatch && method === 'PATCH') {
    return handleApiSubscriberUpdate(request, env, apiDetailMatch[1]);
  }
  if (apiDetailMatch && method === 'DELETE') {
    return handleApiSubscriberDelete(env, apiDetailMatch[1]);
  }

  const apiExtendMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/extend$/);
  if (apiExtendMatch && method === 'POST') {
    return extendSubscriptionAction(request, env, apiExtendMatch[1]);
  }

  const apiChangePhoneMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/change-phone$/);
  if (apiChangePhoneMatch && method === 'POST') {
    return changePhoneAction(request, env, apiChangePhoneMatch[1]);
  }

  const apiTagsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/tags$/);
  if (apiTagsMatch && method === 'POST') {
    return addTagAction(request, env, apiTagsMatch[1]);
  }

  const apiTagRemoveMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/tags\/(.+)$/);
  if (apiTagRemoveMatch && method === 'DELETE') {
    return removeTagAction(request, env, apiTagRemoveMatch[1], decodeURIComponent(apiTagRemoveMatch[2]));
  }

  const apiPlanMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/plan$/);
  if (apiPlanMatch && method === 'POST') {
    return changePlanAction(request, env, apiPlanMatch[1]);
  }

  const apiPaymentsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/payments$/);
  if (apiPaymentsMatch) {
    if (method === 'POST') return addPaymentAction(request, env, apiPaymentsMatch[1]);
    if (method === 'GET') return getPayments(request, env, apiPaymentsMatch[1]);
  }

  const apiSendLinkMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/send-payment-link$/);
  if (apiSendLinkMatch && method === 'POST') {
    return sendPaymentLinkAction(request, env, apiSendLinkMatch[1]);
  }

  // Cancel an Ottu payment intent. session_id is hex (40 chars typically),
  // so we accept any non-slash chars rather than constraining the pattern.
  const apiCancelIntent = path.match(/^\/admin\/api\/payment-intents\/([^\/]+)\/cancel$/);
  if (apiCancelIntent && method === 'POST') {
    return cancelPaymentIntentAction(request, env, decodeURIComponent(apiCancelIntent[1]));
  }

  const apiEventsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/events$/);
  if (apiEventsMatch && method === 'GET') {
    return getEvents(request, env, apiEventsMatch[1]);
  }

  if (path === '/admin/api/broadcast' && method === 'POST') {
    return handleBroadcast(request, env, ctx);
  }

  if (path === '/admin/api/broadcasts' && method === 'GET') {
    return handleApiBroadcastsList(env);
  }

  const broadcastDetailMatch = path.match(/^\/admin\/api\/broadcasts\/(\d+)$/);
  if (broadcastDetailMatch && method === 'GET') {
    return handleApiBroadcastDetail(env, broadcastDetailMatch[1], request);
  }

  if (path === '/admin/api/failures' && method === 'GET') {
    return handleApiFailures(request, env);
  }

  if (path === '/admin/api/payments' && method === 'GET') {
    return handlePaymentsApi(request, env);
  }

  return new Response('Not found', { status: 404 });
}

async function handleApiFailures(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));

  const [{ results }, total] = await Promise.all([
    env.DB.prepare(
      `SELECT f.id, f.broadcast_id, f.phone, f.payload, f.failed_at,
              b.date_string, b.status as broadcast_status
       FROM broadcast_failures f
       LEFT JOIN broadcasts b ON b.id = f.broadcast_id
       ORDER BY f.failed_at DESC
       LIMIT ?`
    ).bind(limit).all(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM broadcast_failures`).first(),
  ]);

  return jsonResponse({ failures: results, total: total?.c || 0 });
}

// ----------------------------------------------------------------------------
// Authentication
// ----------------------------------------------------------------------------

async function handleLogin(request, env) {
  try {
    const formData = await request.formData();
    const password = formData.get('password');

    if (!password || password !== env.ADMIN_PASSWORD) {
      return htmlResponse(renderLoginPage('كلمة المرور غير صحيحة'));
    }

    const token = await createSessionToken(env);
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/admin',
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}`,
      },
    });
  } catch (err) {
    return htmlResponse(renderLoginPage('حدث خطأ، حاول مجدداً'));
  }
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/admin',
      'Set-Cookie': `${SESSION_COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    },
  });
}

async function createSessionToken(env) {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const payload = `${expiresAt}`;
  const signature = await signHmac(payload, env.ADMIN_PASSWORD);
  return `${btoa(payload)}.${signature}`;
}

async function verifySession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return false;

  const [encodedPayload, signature] = match[1].split('.');
  if (!encodedPayload || !signature) return false;

  try {
    const payload = atob(encodedPayload);
    const expectedSignature = await signHmac(payload, env.ADMIN_PASSWORD);
    if (!timingSafeEqual(signature, expectedSignature)) return false;
    return parseInt(payload, 10) > Date.now();
  } catch {
    return false;
  }
}

async function signHmac(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ----------------------------------------------------------------------------
// API: Stats
// ----------------------------------------------------------------------------

async function handleApiStats(env) {
  const now = Date.now();

  // Calendar-month start in Kuwait wallclock. Asia/Kuwait is UTC+3, no DST,
  // so midnight Kuwait on day 1 = UTC midnight on day 1 minus 3 hours.
  const kp = getKuwaitDateParts(new Date(now));
  const monthStartMs = Date.UTC(kp.year, kp.month - 1, 1) - 3 * 60 * 60 * 1000;

  // Stuck-pending threshold: a 'pending' intent older than an hour is
  // suspicious — the customer either bailed or hit a problem. Worth
  // surfacing on the dashboard.
  const STUCK_PENDING_MS = 60 * 60 * 1000;

  const [active, total, newToday, unsubscribed, awaiting, lastBroadcast,
         monthPaid, stuckPending, lastPayment] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE first_contact_at > ?`).bind(now - 86400000).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state = 'unsubscribed'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state IN ('offered', 'yes', 'awaiting_payment')`).first(),
    env.DB.prepare(`SELECT * FROM broadcasts ORDER BY started_at DESC LIMIT 1`).first(),
    // Paid this month: total + count. Treat NULL state as paid for legacy
    // manual rows (admin "add payment" entries).
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_kwd), 0) AS total_kwd, COUNT(*) AS c
       FROM payments
       WHERE payment_date >= ? AND (state = 'paid' OR state IS NULL)`
    ).bind(monthStartMs).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c
       FROM payment_intents
       WHERE state = 'pending' AND created_at < ?`
    ).bind(now - STUCK_PENDING_MS).first(),
    env.DB.prepare(
      `SELECT phone, amount_kwd, gateway, payment_date
       FROM payments
       WHERE state = 'paid' OR state IS NULL
       ORDER BY payment_date DESC
       LIMIT 1`
    ).first(),
  ]);

  return jsonResponse({
    active: active.c,
    total: total.c,
    newToday: newToday.c,
    unsubscribed: unsubscribed.c,
    inFlight: awaiting.c,
    lastBroadcast: lastBroadcast ? {
      id: lastBroadcast.id,
      date_string: lastBroadcast.date_string,
      sent_count: lastBroadcast.sent_count,
      failed_count: lastBroadcast.failed_count,
      target_count: lastBroadcast.target_count,
      started_at: lastBroadcast.started_at,
    } : null,
    payments: {
      month_total_kwd: monthPaid?.total_kwd || 0,
      month_count:     monthPaid?.c         || 0,
      stuck_pending:   stuckPending?.c      || 0,
      last_payment:    lastPayment ? {
        phone:        lastPayment.phone,
        amount_kwd:   lastPayment.amount_kwd,
        gateway:      lastPayment.gateway,
        payment_date: lastPayment.payment_date,
      } : null,
    },
  });
}

// ----------------------------------------------------------------------------
// API: Subscribers
// ----------------------------------------------------------------------------

async function handleApiSubscribersList(request, env) {
  const url = new URL(request.url);
  const stateFilter = url.searchParams.get('state') || 'all';
  const search = url.searchParams.get('search') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

  let query = 'SELECT * FROM subscribers';
  const conditions = [];
  const params = [];

  if (stateFilter !== 'all') {
    conditions.push('state = ?');
    params.push(stateFilter);
  }

  if (search) {
    conditions.push('(phone LIKE ? OR profile_name LIKE ? OR internal_note LIKE ?)');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ` ORDER BY COALESCE(updated_at, first_contact_at) DESC LIMIT ${limit}`;

  const { results } = await env.DB.prepare(query).bind(...params).all();

  const totalCount = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers').first();

  return jsonResponse({
    subscribers: results,
    returned: results.length,
    total: totalCount.c,
  });
}

async function handleApiSubscriberAdd(request, env) {
  try {
    const body = await request.json();
    const { phone, name, note } = body;
    const type = body.type || 'paid';
    const consented = !!body.consented;
    const giftDays = Number.isFinite(body.gift_days) ? Math.floor(body.gift_days) : 7;

    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return jsonResponse({ error: 'Phone must be 10-15 digits, no + sign' }, 400);
    }
    if (!['paid', 'tester', 'gift'].includes(type)) {
      return jsonResponse({ error: 'Invalid type' }, 400);
    }
    if (type === 'paid' && !consented) {
      return jsonResponse({ error: 'Admin must confirm subscriber consent for paid type' }, 400);
    }
    if (type === 'gift' && (giftDays < 1 || giftDays > 3650)) {
      return jsonResponse({ error: 'gift_days must be between 1 and 3650' }, 400);
    }

    const now = Date.now();
    const cleanPhone = phone.replace(/\D/g, '');
    const DAY = 24 * 60 * 60 * 1000;

    // Don't silently reactivate someone who opted out — Meta compliance & UX.
    const existing = await env.DB.prepare(
      'SELECT state FROM subscribers WHERE phone = ?'
    ).bind(cleanPhone).first();
    if (existing && existing.state === 'unsubscribed') {
      return jsonResponse({
        error: 'هذا الرقم سبق أن ألغى الاشتراك. افتح صفحة تفاصيله واضغط "تفعيل" لإعادة تفعيله.'
      }, 409);
    }
    if (existing && existing.state === 'active') {
      return jsonResponse({
        error: 'هذا الرقم نشط بالفعل. افتح صفحة تفاصيله للتعديل.'
      }, 409);
    }

    // Per-type config: state on insert, plan code, tags, end_at, consent_log type
    let dbState, plan, tagsJson, endAt;
    let consentType, consentText;
    if (type === 'paid') {
      // Insert as awaiting_payment with NO end_at — webhook will set it after payment
      dbState = 'awaiting_payment';
      plan = 'yearly';
      tagsJson = '[]';
      endAt = null;
      consentType = 'paid_admin_initiated';
      consentText = 'Admin initiated paid subscription with attested customer consent';
    } else if (type === 'tester') {
      dbState = 'active';
      plan = 'pilot';
      tagsJson = '["pilot"]';
      endAt = now + 365 * DAY;
      consentType = 'pilot_manual_add';
      consentText = 'Manually added by admin (tester)';
    } else {
      // gift
      dbState = 'active';
      plan = 'gift';
      tagsJson = '[]';
      endAt = now + giftDays * DAY;
      consentType = 'gift_admin_added';
      consentText = `Admin added free gift subscription (${giftDays} days)`;
    }

    // For paid: subscription_start_at and end_at stay NULL until webhook fires.
    // For gift/tester: set start=now, end=computed.
    await env.DB.prepare(
      `INSERT INTO subscribers (
         phone, state, tier, profile_name, internal_note,
         first_contact_at, activated_at, updated_at,
         subscription_plan, subscription_start_at, subscription_end_at, tags
       )
       VALUES (?, ?, 'standard', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         state = excluded.state,
         profile_name = COALESCE(excluded.profile_name, profile_name),
         internal_note = COALESCE(excluded.internal_note, internal_note),
         activated_at = COALESCE(activated_at, excluded.activated_at),
         updated_at = excluded.updated_at,
         subscription_plan = excluded.subscription_plan,
         subscription_start_at = COALESCE(excluded.subscription_start_at, subscription_start_at),
         subscription_end_at = COALESCE(excluded.subscription_end_at, subscription_end_at),
         tags = excluded.tags`
    ).bind(
      cleanPhone, dbState, name || null, note || null,
      now,
      type === 'paid' ? null : now,    // activated_at: NULL for paid (set by webhook)
      now,
      plan,
      type === 'paid' ? null : now,    // subscription_start_at: NULL for paid
      endAt,
      tagsJson,
    ).run();

    await env.DB.prepare(
      `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
       VALUES (?, ?, ?, ?)`
    ).bind(cleanPhone, consentType, consentText, now).run();

    // Audit event — different for paid (no activation yet) vs free
    try {
      const eventType = type === 'paid' ? 'manual_add_pending_payment' : 'activated';
      const details = type === 'paid'
        ? { plan, manual_add: true, type: 'paid' }
        : { plan, manual_add: true, type, gift_days: type === 'gift' ? giftDays : undefined };
      await env.DB.prepare(
        `INSERT INTO subscription_events (phone, event_type, details, performed_by, created_at)
         VALUES (?, ?, ?, 'admin', ?)`
      ).bind(cleanPhone, eventType, JSON.stringify(details), now).run();
    } catch {}

    // Side effects per type (after the row exists, so the WhatsApp send and
    // the payment-link flow have something to attach to)
    let extra = {};

    if (type === 'paid') {
      // Fire-and-await the link creation. CSW is closed (subscriber never
      // messaged us), so this MUST go via template — handled inside the
      // helper. If template isn't configured or fails, we still return
      // success on the row insert; admin can use the resend button.
      const subRow = await env.DB.prepare(
        `SELECT * FROM subscribers WHERE phone = ?`
      ).bind(cleanPhone).first();
      const result = await createAndSendCheckoutLink(env, cleanPhone, subRow);
      extra.payment_link_status = result.success ? 'sent' : 'fallback';
      if (!result.success && result.checkoutUrl) {
        extra.checkout_url = result.checkoutUrl;
      }
    } else if (type === 'gift') {
      // Welcome template — silent skip if not configured (template still
      // pending Meta approval).
      if (env.WHATSAPP_GIFT_WELCOME_TEMPLATE_NAME) {
        try {
          const endDateAr = new Intl.DateTimeFormat('ar', {
            year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kuwait',
          }).format(new Date(endAt));
          await sendGiftWelcomeTemplate(env, cleanPhone, name, endDateAr);
        } catch (err) {
          console.warn(`[admin/add] gift welcome failed for ${cleanPhone}:`, err);
          extra.gift_welcome_skipped = true;
        }
      } else {
        extra.gift_welcome_skipped = true;
      }
    }
    // tester: no WhatsApp side effect

    return jsonResponse({ success: true, phone: cleanPhone, type, ...extra });
  } catch (err) {
    console.error('Add subscriber error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleApiSubscriberUpdate(request, env, phone) {
  try {
    const { state, name, note, subscriptionEndAt } = await request.json();
    const allowedStates = ['active', 'paused', 'unsubscribed', 'new', 'offered'];

    const updates = [];
    const values = [];

    if (state) {
      if (!allowedStates.includes(state)) {
        return jsonResponse({ error: `Invalid state. Allowed: ${allowedStates.join(', ')}` }, 400);
      }
      updates.push('state = ?');
      values.push(state);

      if (state === 'active') {
        updates.push('activated_at = COALESCE(activated_at, ?)');
        values.push(Date.now());
      }
      if (state === 'unsubscribed') {
        updates.push('unsubscribed_at = ?');
        values.push(Date.now());
      }
    }

    if (name !== undefined) {
      updates.push('profile_name = ?');
      values.push(name);
    }

    if (note !== undefined) {
      updates.push('internal_note = ?');
      values.push(note);
    }

    if (subscriptionEndAt !== undefined) {
      updates.push('subscription_end_at = ?');
      values.push(subscriptionEndAt);
    }

    if (updates.length === 0) {
      return jsonResponse({ error: 'Nothing to update' }, 400);
    }

    updates.push('updated_at = ?');
    values.push(Date.now());
    values.push(phone);

    await env.DB.prepare(
      `UPDATE subscribers SET ${updates.join(', ')} WHERE phone = ?`
    ).bind(...values).run();

    if (state) {
      try {
        await env.DB.prepare(
          `INSERT INTO subscription_events (phone, event_type, details, performed_by, created_at)
           VALUES (?, ?, '{}', 'admin', ?)`
        ).bind(phone, state === 'paused' ? 'paused' : state === 'active' ? 'resumed' : state === 'unsubscribed' ? 'unsubscribed' : 'state_changed', Date.now()).run();
      } catch {}
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleApiSubscriberDelete(env, phone) {
  try {
    await env.DB.prepare('DELETE FROM subscribers WHERE phone = ?').bind(phone).run();
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ----------------------------------------------------------------------------
// API: Broadcasts
// ----------------------------------------------------------------------------

async function handleApiBroadcastsList(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND delivery_status = 'delivered') as delivered_count,
       (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND delivery_status = 'read') as read_count
     FROM broadcasts b
     ORDER BY started_at DESC
     LIMIT 100`
  ).all();

  return jsonResponse({ broadcasts: results });
}

async function handleApiBroadcastDetail(env, id, request) {
  const broadcast = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).first();
  if (!broadcast) return jsonResponse({ error: 'Not found' }, 404);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = Math.min(500, Math.max(1, parseInt(url.searchParams.get('per_page') || '100', 10)));
  const offset = (page - 1) * perPage;
  const filter = url.searchParams.get('filter');  // 'failed' to show only failed sends/deliveries

  // Aggregate stats via SQL — can't load 10k+ rows into JS memory at scale.
  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed_send,
       SUM(CASE WHEN delivery_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
       SUM(CASE WHEN delivery_status = 'read' THEN 1 ELSE 0 END) as read,
       SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) as failed_delivery
     FROM broadcast_recipients
     WHERE broadcast_id = ?`
  ).bind(id).first();

  let recipientsSql = 'SELECT * FROM broadcast_recipients WHERE broadcast_id = ?';
  const bindings = [id];
  if (filter === 'failed') {
    recipientsSql += ` AND (send_status = 'failed' OR delivery_status = 'failed')`;
  }
  recipientsSql += ' ORDER BY phone LIMIT ? OFFSET ?';
  bindings.push(perPage, offset);

  const { results: recipients } = await env.DB.prepare(recipientsSql).bind(...bindings).all();

  return jsonResponse({
    broadcast,
    recipients,
    stats: {
      total: stats?.total || 0,
      sent: stats?.sent || 0,
      failed_send: stats?.failed_send || 0,
      delivered: stats?.delivered || 0,
      read: stats?.read || 0,
      failed_delivery: stats?.failed_delivery || 0,
    },
    pagination: {
      page,
      per_page: perPage,
      total: stats?.total || 0,
      total_pages: Math.ceil((stats?.total || 0) / perPage),
    },
  });
}

// ----------------------------------------------------------------------------
// Response helpers
// ----------------------------------------------------------------------------

export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
