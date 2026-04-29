/**
 * Admin router, authentication, role-based access control.
 *
 * Auth model (post-2026-04-29):
 *   - admins table holds email + PBKDF2 hash + role (supervisor/billing/publisher)
 *   - Login is email + password
 *   - Session cookie carries admin_id, signed with HMAC keyed by env.ADMIN_PASSWORD
 *     (kept around as a session-signing secret only — NOT a login credential)
 *   - Bootstrap: if the admins table is empty AND the entered password matches
 *     env.ADMIN_PASSWORD, the first login seeds a supervisor row. After that,
 *     ADMIN_PASSWORD is unused for login.
 *
 * Permission model:
 *   - supervisor : everything, including managing other admins
 *   - billing    : subscriber CRUD + payment ops + global payments page
 *   - publisher  : broadcast trigger + broadcast history + DLQ failures
 *
 * Each route declares the role(s) it accepts via requireRole(). Server-side
 * enforcement is the source of truth — UI hiding is for UX only.
 */

import { renderLoginPage } from './admin_pages.js';
import { renderDashboardPage, renderSubscribersPage, renderBroadcastsPage, renderBroadcastDetailPage, renderFailuresPage, renderAdminsPage, renderPublishPage } from './admin_pages.js';
import { renderSubscriberDetailPage } from './admin_subscriber_detail.js';
import { renderPaymentsPage, handlePaymentsApi } from './admin_payments.js';
import { handleBroadcast } from './admin_broadcast.js';
import {
  getSubscriberDetail, extendSubscriptionAction, changePhoneAction,
  addTagAction, removeTagAction, changePlanAction, addPaymentAction,
  getEvents, getPayments, sendPaymentLinkAction, cancelPaymentIntentAction,
  refundPaymentAction,
} from './admin_api_v2.js';
import {
  hashPassword, verifyPassword,
  createSessionCookie, verifySessionCookie,
  loadAdmin,
  ROLE_SUPERVISOR, ROLE_BILLING, ROLE_PUBLISHER, ALL_ROLES,
} from './auth.js';
import { getKuwaitDateParts } from './date_util.js';
import { createAndSendCheckoutLink } from './payment.js';
import { sendGiftWelcomeTemplate } from './whatsapp.js';
import { cancelCheckout } from './ottu.js';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

export async function handleAdminRequest(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  // Login is the one route that must work BEFORE auth — everything else
  // requires a valid session.
  if (path === '/admin/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  // Logout is symmetric — clears the cookie regardless of session state.
  if (path === '/admin/logout' && method === 'POST') {
    return handleLogout();
  }

  // From here every request requires a valid session. Resolve once and
  // pass the admin object into the dispatcher.
  const session = await resolveSession(request, env);
  if (!session.admin) {
    if (method === 'GET' && !path.startsWith('/admin/api/')) {
      return htmlResponse(renderLoginPage());
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  return dispatch(request, env, ctx, url, session.admin);
}

/**
 * Authenticated routing. `admin` is the resolved session-bound admin row
 * (id, email, display_name, role, active). `requireRole(admin, [...])`
 * returns a 403 response when the role doesn't match — caller propagates
 * by returning that response.
 */
async function dispatch(request, env, ctx, url, admin) {
  const path = url.pathname;
  const method = request.method;

  // ---------- HTML pages (GET) ----------
  if (method === 'GET') {
    if (path === '/admin')                       return htmlResponse(renderDashboardPage());
    if (path === '/admin/publish') {
      const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_PUBLISHER]);
      if (denied) return denied;
      return htmlResponse(renderPublishPage());
    }
    if (path === '/admin/subscribers') {
      const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
      if (denied) return denied;
      return htmlResponse(renderSubscribersPage());
    }
    if (path === '/admin/payments') {
      const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
      if (denied) return denied;
      return htmlResponse(renderPaymentsPage());
    }
    if (path === '/admin/broadcasts') {
      // All roles see broadcast history — billing for context, publisher for theirs
      return htmlResponse(renderBroadcastsPage());
    }
    if (path === '/admin/failures') {
      const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_PUBLISHER]);
      if (denied) return denied;
      return htmlResponse(renderFailuresPage());
    }
    if (path === '/admin/admins') {
      const denied = requireRole(admin, [ROLE_SUPERVISOR]);
      if (denied) return denied;
      return htmlResponse(renderAdminsPage());
    }

    const subDetailMatch = path.match(/^\/admin\/subscribers\/([^\/]+)$/);
    if (subDetailMatch) {
      const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
      if (denied) return denied;
      return htmlResponse(renderSubscriberDetailPage(decodeURIComponent(subDetailMatch[1])));
    }

    const bcMatch = path.match(/^\/admin\/broadcasts\/(\d+)$/);
    if (bcMatch) return htmlResponse(renderBroadcastDetailPage(bcMatch[1]));
  }

  // ---------- JSON API ----------

  // Self info — every admin can read their own row
  if (path === '/admin/api/me' && method === 'GET') {
    return jsonResponse({ admin: serializeAdmin(admin) });
  }

  // Stats (dashboard) — all roles see basic stats
  if (path === '/admin/api/stats' && method === 'GET') {
    return handleApiStats(env);
  }

  // Rich dashboard payload — KPIs + alerts + funnel + 30-day daily series
  if (path === '/admin/api/dashboard' && method === 'GET') {
    return handleApiDashboard(env);
  }

  // Recent activity feed
  if (path === '/admin/api/activity' && method === 'GET') {
    return handleApiActivity(request, env);
  }

  // Admin management (supervisor only)
  if (path === '/admin/api/admins' && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR]);
    if (denied) return denied;
    return handleApiAdminsList(env);
  }
  if (path === '/admin/api/admins' && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR]);
    if (denied) return denied;
    return handleApiAdminCreate(request, env, admin);
  }
  const apiAdminEditMatch = path.match(/^\/admin\/api\/admins\/(\d+)$/);
  if (apiAdminEditMatch && method === 'PATCH') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR]);
    if (denied) return denied;
    return handleApiAdminUpdate(request, env, parseInt(apiAdminEditMatch[1], 10), admin);
  }

  // Subscribers — supervisor + billing
  if (path === '/admin/api/subscribers' && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return handleApiSubscribersList(request, env);
  }

  if (path === '/admin/api/subscribers/add' && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return handleApiSubscriberAdd(request, env, admin);
  }

  const apiDetailMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)$/);
  if (apiDetailMatch && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return getSubscriberDetail(request, env, apiDetailMatch[1]);
  }
  if (apiDetailMatch && method === 'PATCH') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return handleApiSubscriberUpdate(request, env, apiDetailMatch[1], admin);
  }
  if (apiDetailMatch && method === 'DELETE') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return handleApiSubscriberDelete(env, apiDetailMatch[1]);
  }

  const apiExtendMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/extend$/);
  if (apiExtendMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return extendSubscriptionAction(request, env, apiExtendMatch[1], admin);
  }

  const apiChangePhoneMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/change-phone$/);
  if (apiChangePhoneMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return changePhoneAction(request, env, apiChangePhoneMatch[1], admin);
  }

  const apiTagsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/tags$/);
  if (apiTagsMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return addTagAction(request, env, apiTagsMatch[1], admin);
  }

  const apiTagRemoveMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/tags\/(.+)$/);
  if (apiTagRemoveMatch && method === 'DELETE') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return removeTagAction(request, env, apiTagRemoveMatch[1], decodeURIComponent(apiTagRemoveMatch[2]), admin);
  }

  const apiPlanMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/plan$/);
  if (apiPlanMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return changePlanAction(request, env, apiPlanMatch[1], admin);
  }

  const apiPaymentsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/payments$/);
  if (apiPaymentsMatch) {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    if (method === 'POST') return addPaymentAction(request, env, apiPaymentsMatch[1], admin);
    if (method === 'GET') return getPayments(request, env, apiPaymentsMatch[1]);
  }

  const apiSendLinkMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/send-payment-link$/);
  if (apiSendLinkMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return sendPaymentLinkAction(request, env, apiSendLinkMatch[1], admin);
  }

  // Cancel an Ottu payment intent. session_id is hex (40 chars typically),
  // so we accept any non-slash chars rather than constraining the pattern.
  const apiCancelIntent = path.match(/^\/admin\/api\/payment-intents\/([^\/]+)\/cancel$/);
  if (apiCancelIntent && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return cancelPaymentIntentAction(request, env, decodeURIComponent(apiCancelIntent[1]), admin);
  }

  // Refund a payment (full or partial). payment_id is the integer PK on payments.
  const apiRefundMatch = path.match(/^\/admin\/api\/payments\/(\d+)\/refund$/);
  if (apiRefundMatch && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return refundPaymentAction(request, env, apiRefundMatch[1], admin);
  }

  const apiEventsMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)\/events$/);
  if (apiEventsMatch && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return getEvents(request, env, apiEventsMatch[1]);
  }

  // Broadcasts trigger (publisher + supervisor)
  if (path === '/admin/api/broadcast' && method === 'POST') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_PUBLISHER]);
    if (denied) return denied;
    return handleBroadcast(request, env, ctx);
  }

  // Broadcasts list/detail — all roles
  if (path === '/admin/api/broadcasts' && method === 'GET') {
    return handleApiBroadcastsList(env);
  }

  const broadcastDetailMatch = path.match(/^\/admin\/api\/broadcasts\/(\d+)$/);
  if (broadcastDetailMatch && method === 'GET') {
    return handleApiBroadcastDetail(env, broadcastDetailMatch[1], request);
  }

  // Failures — supervisor + publisher
  if (path === '/admin/api/failures' && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_PUBLISHER]);
    if (denied) return denied;
    return handleApiFailures(request, env);
  }

  // Global payments page API — supervisor + billing
  if (path === '/admin/api/payments' && method === 'GET') {
    const denied = requireRole(admin, [ROLE_SUPERVISOR, ROLE_BILLING]);
    if (denied) return denied;
    return handlePaymentsApi(request, env);
  }

  return new Response('Not found', { status: 404 });
}

// ----------------------------------------------------------------------------
// Auth: session resolution + login + logout
// ----------------------------------------------------------------------------

/**
 * Read the cookie, verify the signature, look up the admin row.
 * Returns { admin: row | null }. Inactive or missing admin → null.
 */
async function resolveSession(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return { admin: null };

  const session = await verifySessionCookie(match[1], env);
  if (!session) return { admin: null };

  const admin = await loadAdmin(env, session.adminId);
  return { admin };
}

async function handleLogin(request, env) {
  try {
    const formData = await request.formData();
    const email = (formData.get('email') || '').toString().trim().toLowerCase();
    const password = (formData.get('password') || '').toString();

    if (!email || !password) {
      return htmlResponse(renderLoginPage('يرجى إدخال البريد وكلمة المرور'));
    }

    let admin = await env.DB.prepare(
      `SELECT id, email, display_name, role, active, password_hash, password_salt
       FROM admins WHERE email = ?`
    ).bind(email).first();

    // Bootstrap: if admins table is empty AND password matches the
    // legacy ADMIN_PASSWORD, seed a supervisor row from this login.
    if (!admin) {
      const anyAdmin = await env.DB.prepare(`SELECT 1 FROM admins LIMIT 1`).first();
      if (!anyAdmin && env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD) {
        admin = await bootstrapFirstSupervisor(env, email, password);
      }
    }

    if (!admin) {
      return htmlResponse(renderLoginPage('بيانات الدخول غير صحيحة'));
    }
    if (!admin.active) {
      return htmlResponse(renderLoginPage('هذا الحساب معطّل. تواصل مع المشرف.'));
    }

    const ok = await verifyPassword(password, admin.password_hash, admin.password_salt);
    if (!ok) {
      return htmlResponse(renderLoginPage('بيانات الدخول غير صحيحة'));
    }

    // Mint session cookie + record last_login_at
    const cookie = await createSessionCookie(env, admin.id, SESSION_DURATION_MS);
    await env.DB.prepare(`UPDATE admins SET last_login_at = ? WHERE id = ?`)
      .bind(Date.now(), admin.id).run();

    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/admin',
        'Set-Cookie': `${SESSION_COOKIE_NAME}=${cookie}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}`,
      },
    });
  } catch (err) {
    console.error('[admin] login error:', err);
    return htmlResponse(renderLoginPage('حدث خطأ، حاول مجدداً'));
  }
}

async function bootstrapFirstSupervisor(env, email, password) {
  const { hash, salt } = await hashPassword(password);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO admins (email, display_name, password_hash, password_salt, role, active, created_at, password_changed_at)
     VALUES (?, ?, ?, ?, 'supervisor', 1, ?, ?)`
  ).bind(email, email.split('@')[0], hash, salt, now, now).run();
  console.log(`[admin] bootstrapped first supervisor: ${email}`);
  return env.DB.prepare(
    `SELECT id, email, display_name, role, active, password_hash, password_salt
     FROM admins WHERE email = ?`
  ).bind(email).first();
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

// ----------------------------------------------------------------------------
// Permission helpers
// ----------------------------------------------------------------------------

/**
 * Returns null if the admin's role is in `allowed`. Otherwise returns a
 * 403 jsonResponse — caller propagates it directly. This pattern keeps
 * the route table dense and grep-friendly.
 */
function requireRole(admin, allowed) {
  if (allowed.includes(admin.role)) return null;
  return jsonResponse({ error: 'صلاحياتك لا تسمح بهذا الإجراء' }, 403);
}

function serializeAdmin(admin) {
  return {
    id: admin.id,
    email: admin.email,
    display_name: admin.display_name,
    role: admin.role,
  };
}

// ----------------------------------------------------------------------------
// Admin management API (supervisor only)
// ----------------------------------------------------------------------------

async function handleApiAdminsList(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, email, display_name, role, active, created_at, last_login_at, password_changed_at
     FROM admins
     ORDER BY active DESC, created_at DESC`
  ).all();
  return jsonResponse({ admins: results });
}

async function handleApiAdminCreate(request, env, actor) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    const display_name = (body.display_name || '').trim() || null;
    const role = body.role;
    const password = body.password || '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: 'بريد إلكتروني غير صالح' }, 400);
    }
    if (!ALL_ROLES.includes(role)) {
      return jsonResponse({ error: 'الدور غير صالح' }, 400);
    }
    if (password.length < 8) {
      return jsonResponse({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' }, 400);
    }

    const existing = await env.DB.prepare(`SELECT id FROM admins WHERE email = ?`).bind(email).first();
    if (existing) {
      return jsonResponse({ error: 'هذا البريد مستخدم مسبقاً' }, 409);
    }

    const { hash, salt } = await hashPassword(password);
    const now = Date.now();
    const result = await env.DB.prepare(
      `INSERT INTO admins (email, display_name, password_hash, password_salt, role, active, created_at, created_by, password_changed_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(email, display_name, hash, salt, role, now, actor.id, now).run();

    return jsonResponse({ success: true, id: result.meta?.last_row_id });
  } catch (err) {
    console.error('[admin] admin create error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * Update an admin row. Supports:
 *   { active: 0|1 }           — deactivate / reactivate
 *   { role: 'supervisor'|... } — change role
 *   { display_name: '...' }    — rename
 *   { password: '...' }        — reset password (no current-password check; supervisor-driven)
 *
 * Self-protection: a supervisor can't deactivate or demote themselves.
 */
async function handleApiAdminUpdate(request, env, targetId, actor) {
  try {
    const body = await request.json();
    const target = await env.DB.prepare(
      `SELECT id, email, role, active FROM admins WHERE id = ?`
    ).bind(targetId).first();
    if (!target) return jsonResponse({ error: 'المستخدم غير موجود' }, 404);

    const isSelf = target.id === actor.id;
    const updates = [];
    const values = [];

    if (typeof body.active === 'number' || typeof body.active === 'boolean') {
      const newActive = body.active ? 1 : 0;
      if (isSelf && newActive === 0) {
        return jsonResponse({ error: 'لا يمكنك تعطيل حسابك الخاص' }, 400);
      }
      updates.push('active = ?');
      values.push(newActive);
    }

    if (body.role !== undefined) {
      if (!ALL_ROLES.includes(body.role)) {
        return jsonResponse({ error: 'الدور غير صالح' }, 400);
      }
      if (isSelf && target.role === 'supervisor' && body.role !== 'supervisor') {
        // Refuse to demote the only supervisor — count first
        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM admins WHERE role = 'supervisor' AND active = 1`
        ).first();
        if ((count?.c || 0) <= 1) {
          return jsonResponse({ error: 'لا يمكن تخفيض دور آخر مشرف نشط' }, 400);
        }
      }
      updates.push('role = ?');
      values.push(body.role);
    }

    if (body.display_name !== undefined) {
      updates.push('display_name = ?');
      values.push((body.display_name || '').trim() || null);
    }

    if (body.password !== undefined) {
      const password = String(body.password || '');
      if (password.length < 8) {
        return jsonResponse({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' }, 400);
      }
      const { hash, salt } = await hashPassword(password);
      updates.push('password_hash = ?', 'password_salt = ?', 'password_changed_at = ?');
      values.push(hash, salt, Date.now());
    }

    if (updates.length === 0) {
      return jsonResponse({ error: 'لا يوجد ما يُحدَّث' }, 400);
    }

    values.push(targetId);
    await env.DB.prepare(
      `UPDATE admins SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('[admin] admin update error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
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
// API: Dashboard (rich payload — KPIs + alerts + funnel + daily series)
// ----------------------------------------------------------------------------

async function handleApiDashboard(env) {
  const now = Date.now();
  const DAY_MS = 86400000;

  // Kuwait month boundaries (UTC+3, no DST)
  const kp = getKuwaitDateParts(new Date(now));
  const monthStartMs    = Date.UTC(kp.year, kp.month - 1, 1) - 3 * 60 * 60 * 1000;
  const lastMonthStart  = Date.UTC(kp.year, kp.month - 2, 1) - 3 * 60 * 60 * 1000;
  const lastMonthEnd    = monthStartMs - 1;
  const last30DaysStart = now - 30 * DAY_MS;

  const STUCK_PENDING_MS = 60 * 60 * 1000;
  const EXPIRING_WINDOW_MS = 7 * DAY_MS;

  const [
    funnelCounts, lastBroadcast,
    monthRevenue, lastMonthRevenue, lastPayment,
    stuckPending, dlqCount, stalledCount, expiringSoonCount,
    revenueByDay, signupsByDay,
  ] = await Promise.all([
    // Funnel + active-by-plan in a single subscribers scan
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END)              AS active,
         SUM(CASE WHEN state = 'unsubscribed' THEN 1 ELSE 0 END)        AS unsubscribed,
         SUM(CASE WHEN state IN ('offered','yes','awaiting_payment') THEN 1 ELSE 0 END) AS in_flight,
         SUM(CASE WHEN first_contact_at > ? THEN 1 ELSE 0 END)          AS new_today,
         SUM(CASE WHEN state = 'active' AND subscription_plan = 'yearly' THEN 1 ELSE 0 END) AS active_yearly,
         SUM(CASE WHEN state = 'active' AND subscription_plan = 'pilot'  THEN 1 ELSE 0 END) AS active_pilot,
         SUM(CASE WHEN state = 'active' AND subscription_plan = 'gift'   THEN 1 ELSE 0 END) AS active_gift,
         COUNT(*)                                                       AS total
       FROM subscribers`
    ).bind(now - DAY_MS).first(),
    env.DB.prepare(`SELECT * FROM broadcasts ORDER BY started_at DESC LIMIT 1`).first(),

    // Revenue this month (treat NULL state as paid for legacy/manual rows)
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_kwd - COALESCE(refunded_amount_kwd, 0)), 0) AS total_kwd, COUNT(*) AS c
       FROM payments
       WHERE payment_date >= ? AND (state IN ('paid','partially_refunded') OR state IS NULL)`
    ).bind(monthStartMs).first(),

    // Revenue last month (for delta)
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount_kwd - COALESCE(refunded_amount_kwd, 0)), 0) AS total_kwd
       FROM payments
       WHERE payment_date BETWEEN ? AND ? AND (state IN ('paid','partially_refunded') OR state IS NULL)`
    ).bind(lastMonthStart, lastMonthEnd).first(),

    env.DB.prepare(
      `SELECT phone, amount_kwd, gateway, payment_date
       FROM payments
       WHERE state IN ('paid','partially_refunded') OR state IS NULL
       ORDER BY payment_date DESC
       LIMIT 1`
    ).first(),

    // Alerts
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM payment_intents
       WHERE state = 'pending' AND created_at < ?`
    ).bind(now - STUCK_PENDING_MS).first(),

    env.DB.prepare(`SELECT COUNT(*) AS c FROM broadcast_failures`).first(),

    env.DB.prepare(`SELECT COUNT(*) AS c FROM broadcasts WHERE status = 'stalled'`).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM subscribers
       WHERE state = 'active'
         AND subscription_plan != 'pilot'
         AND subscription_end_at IS NOT NULL
         AND subscription_end_at BETWEEN ? AND ?`
    ).bind(now, now + EXPIRING_WINDOW_MS).first(),

    // Daily series — last 30 days, grouped by Kuwait calendar day.
    // Kuwait is UTC+3 → shift the timestamp by +3h before formatting so
    // a payment at 23:00 UTC (= 02:00 Kuwait next day) buckets correctly.
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', (payment_date / 1000) + 10800, 'unixepoch') AS day,
              COALESCE(SUM(amount_kwd - COALESCE(refunded_amount_kwd, 0)), 0) AS total
       FROM payments
       WHERE payment_date >= ? AND (state IN ('paid','partially_refunded') OR state IS NULL)
       GROUP BY day
       ORDER BY day`
    ).bind(last30DaysStart).all(),

    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', (first_contact_at / 1000) + 10800, 'unixepoch') AS day,
              COUNT(*) AS c
       FROM subscribers
       WHERE first_contact_at >= ?
       GROUP BY day
       ORDER BY day`
    ).bind(last30DaysStart).all(),
  ]);

  return jsonResponse({
    kpis: {
      active: funnelCounts?.active || 0,
      revenue_month_kwd: monthRevenue?.total_kwd || 0,
      revenue_month_count: monthRevenue?.c || 0,
      revenue_last_month_kwd: lastMonthRevenue?.total_kwd || 0,
      last_broadcast: lastBroadcast ? {
        id: lastBroadcast.id,
        date_string: lastBroadcast.date_string,
        sent_count: lastBroadcast.sent_count,
        failed_count: lastBroadcast.failed_count,
        target_count: lastBroadcast.target_count,
        started_at: lastBroadcast.started_at,
        status: lastBroadcast.status,
      } : null,
      last_payment: lastPayment ? {
        phone: lastPayment.phone,
        amount_kwd: lastPayment.amount_kwd,
        gateway: lastPayment.gateway,
        payment_date: lastPayment.payment_date,
      } : null,
    },
    alerts: {
      expiring_7d:    expiringSoonCount?.c || 0,
      stuck_pending:  stuckPending?.c || 0,
      dlq_failures:   dlqCount?.c || 0,
      stalled_broadcasts: stalledCount?.c || 0,
    },
    funnel: {
      in_flight:    funnelCounts?.in_flight    || 0,
      new_today:    funnelCounts?.new_today    || 0,
      unsubscribed: funnelCounts?.unsubscribed || 0,
      total:        funnelCounts?.total        || 0,
    },
    active_by_plan: {
      yearly: funnelCounts?.active_yearly || 0,
      pilot:  funnelCounts?.active_pilot  || 0,
      gift:   funnelCounts?.active_gift   || 0,
    },
    series: {
      revenue_30d: (revenueByDay?.results || []).map(r => ({ day: r.day, value: Number(r.total) })),
      signups_30d: (signupsByDay?.results || []).map(r => ({ day: r.day, value: Number(r.c) })),
    },
  });
}

// ----------------------------------------------------------------------------
// API: Activity feed
// ----------------------------------------------------------------------------

async function handleApiActivity(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '15', 10)));

  const { results } = await env.DB.prepare(
    `SELECT e.id, e.phone, e.event_type, e.details, e.performed_by, e.created_at,
            s.profile_name
     FROM subscription_events e
     LEFT JOIN subscribers s ON s.phone = e.phone
     ORDER BY e.created_at DESC
     LIMIT ?`
  ).bind(limit).all();

  return jsonResponse({ events: results });
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

async function handleApiSubscriberAdd(request, env, actor) {
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
      // 7-day free trial. Distinct from plan='pilot' which is never-expires
      // for internal QA accounts. trial expires normally; cron auto-pauses
      // them on day 8.
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
         VALUES (?, ?, ?, ?, ?)`
      ).bind(cleanPhone, eventType, JSON.stringify(details), actor.email, now).run();
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

async function handleApiSubscriberUpdate(request, env, phone, actor) {
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
           VALUES (?, ?, '{}', ?, ?)`
        ).bind(phone, state === 'paused' ? 'paused' : state === 'active' ? 'resumed' : state === 'unsubscribed' ? 'unsubscribed' : 'state_changed', actor.email, Date.now()).run();
      } catch {}
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * Two-tier delete:
 *   - If subscriber has any `payments` row (real money flowed) → REFUSE
 *     with 409 and tell admin to use "إلغاء الاشتراك" instead. Preserves
 *     financial history for accounting / disputes / Kuwait tax.
 *   - Otherwise (test, gift, abandoned signup) → cascade across all
 *     per-phone tables. Best-effort cancel any pending Ottu intents in
 *     the gateway first; tolerate Ottu errors (we already mark canceled
 *     locally regardless).
 */
async function handleApiSubscriberDelete(env, phone) {
  try {
    const paid = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE phone = ?`
    ).bind(phone).first();
    if ((paid?.c || 0) > 0) {
      return jsonResponse({
        error: 'هذا المشترك لديه سجل دفعات. لا يمكن حذفه نهائياً — استخدم "إلغاء الاشتراك" للحفاظ على السجل المالي.',
      }, 409);
    }

    // Best-effort: cancel any pending Ottu sessions before nuking the local row
    const { results: pendingIntents } = await env.DB.prepare(
      `SELECT session_id FROM payment_intents WHERE phone = ? AND state = 'pending'`
    ).bind(phone).all();
    for (const intent of (pendingIntents || [])) {
      try {
        await cancelCheckout(env, intent.session_id);
      } catch (err) {
        // Tolerate — the row's about to be deleted anyway. Log for visibility.
        console.warn(`[delete] could not cancel Ottu intent ${intent.session_id}:`, err.message);
      }
    }

    // Cascade across every per-phone table. broadcasts.id stays around as
    // a historical summary; only per-recipient rows are removed.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM payment_intents WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM consent_log WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM messages WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM subscription_events WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM broadcast_recipients WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM broadcast_failures WHERE phone = ?').bind(phone),
      env.DB.prepare('DELETE FROM subscribers WHERE phone = ?').bind(phone),
    ]);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('[delete] cascade failed:', err);
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
// API: Failures (DLQ)
// ----------------------------------------------------------------------------

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
