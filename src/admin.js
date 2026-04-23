/**
 * Admin router and authentication.
 *
 * Pages:
 *   GET  /admin                      → dashboard (stats + send today)
 *   GET  /admin/subscribers          → subscriber list
 *   GET  /admin/subscribers/:phone   → single subscriber detail (NOT YET)
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
 */

import { renderLoginPage } from './admin_pages.js';
import { renderDashboardPage, renderSubscribersPage, renderBroadcastsPage, renderBroadcastDetailPage } from './admin_pages.js';
import { handleBroadcast } from './admin_broadcast.js';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

export async function handleAdminRequest(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  // Login endpoint (no auth required)
  if (path === '/admin/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  // All other admin routes require authentication
  const isAuthed = await verifySession(request, env);

  if (!isAuthed) {
    // Redirect to login page for HTML requests
    if (method === 'GET' && (path === '/admin' || path.startsWith('/admin/subscribers') || path.startsWith('/admin/broadcasts'))) {
      return htmlResponse(renderLoginPage());
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Logout
  if (path === '/admin/logout' && method === 'POST') {
    return handleLogout();
  }

  // HTML pages
  if (method === 'GET') {
    if (path === '/admin') return htmlResponse(renderDashboardPage());
    if (path === '/admin/subscribers') return htmlResponse(renderSubscribersPage());
    if (path === '/admin/broadcasts') return htmlResponse(renderBroadcastsPage());

    // Broadcast detail: /admin/broadcasts/123
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

  // PATCH /admin/api/subscribers/:phone
  const patchMatch = path.match(/^\/admin\/api\/subscribers\/(\d+)$/);
  if (patchMatch && method === 'PATCH') {
    return handleApiSubscriberUpdate(request, env, patchMatch[1]);
  }
  if (patchMatch && method === 'DELETE') {
    return handleApiSubscriberDelete(env, patchMatch[1]);
  }

  if (path === '/admin/api/broadcast' && method === 'POST') {
    return handleBroadcast(request, env, ctx);
  }

  if (path === '/admin/api/broadcasts' && method === 'GET') {
    return handleApiBroadcastsList(env);
  }

  const broadcastDetailMatch = path.match(/^\/admin\/api\/broadcasts\/(\d+)$/);
  if (broadcastDetailMatch && method === 'GET') {
    return handleApiBroadcastDetail(env, broadcastDetailMatch[1]);
  }

  return new Response('Not found', { status: 404 });
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
    if (signature !== expectedSignature) return false;
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

  const [active, total, newToday, unsubscribed, awaiting, lastBroadcast] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE first_contact_at > ?`).bind(now - 86400000).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state = 'unsubscribed'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM subscribers WHERE state IN ('offered', 'yes', 'awaiting_payment')`).first(),
    env.DB.prepare(`SELECT * FROM broadcasts ORDER BY started_at DESC LIMIT 1`).first(),
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

  // Also return total count of ALL subscribers (unfiltered) for the header
  const totalCount = await env.DB.prepare('SELECT COUNT(*) as c FROM subscribers').first();

  return jsonResponse({
    subscribers: results,
    returned: results.length,
    total: totalCount.c,
  });
}

async function handleApiSubscriberAdd(request, env) {
  try {
    const { phone, name, note } = await request.json();

    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return jsonResponse({ error: 'Phone must be 10-15 digits, no + sign' }, 400);
    }

    const now = Date.now();
    const cleanPhone = phone.replace(/\D/g, '');

    await env.DB.prepare(
      `INSERT INTO subscribers (phone, state, tier, profile_name, internal_note, first_contact_at, activated_at, updated_at)
       VALUES (?, 'active', 'standard', ?, ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         state = 'active',
         profile_name = COALESCE(?, profile_name),
         internal_note = COALESCE(?, internal_note),
         activated_at = COALESCE(activated_at, ?),
         updated_at = ?`
    ).bind(
      cleanPhone, name || null, note || null, now, now, now,
      name || null, note || null, now, now
    ).run();

    await env.DB.prepare(
      `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
       VALUES (?, 'pilot_manual_add', 'Manually added by admin', ?)`
    ).bind(cleanPhone, now).run();

    return jsonResponse({ success: true, phone: cleanPhone });
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

async function handleApiBroadcastDetail(env, id) {
  const broadcast = await env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(id).first();
  if (!broadcast) return jsonResponse({ error: 'Not found' }, 404);

  const { results: recipients } = await env.DB.prepare(
    'SELECT * FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY phone'
  ).bind(id).all();

  const stats = {
    total: recipients.length,
    sent: recipients.filter(r => r.send_status === 'sent').length,
    failed_send: recipients.filter(r => r.send_status === 'failed').length,
    delivered: recipients.filter(r => r.delivery_status === 'delivered').length,
    read: recipients.filter(r => r.delivery_status === 'read').length,
    failed_delivery: recipients.filter(r => r.delivery_status === 'failed').length,
  };

  return jsonResponse({ broadcast, recipients, stats });
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
