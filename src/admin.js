/**
 * Admin panel and broadcast endpoint.
 *
 * Routes:
 *   GET  /admin              → login page or dashboard (depending on session)
 *   POST /admin/login        → authenticate and set session cookie
 *   POST /admin/logout       → clear session
 *   GET  /admin/stats        → JSON with subscriber counts
 *   POST /admin/broadcast    → send daily template to all active subscribers
 *   POST /admin/add-subscriber → manually add a pilot subscriber (bypass payment)
 *
 * Authentication: single shared password stored as ADMIN_PASSWORD secret.
 * Session: signed cookie with a timestamp, expires after 8 hours.
 */

import { sendDailyDeliveryTemplate } from './whatsapp.js';

const SESSION_COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

export async function handleAdminRequest(request, env, ctx, url) {
  const path = url.pathname;

  // Login endpoint (no auth required)
  if (path === '/admin/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  // Everything else requires auth
  const isAuthenticated = await verifySession(request, env);

  // If not authenticated, show login page
  if (!isAuthenticated) {
    if (path === '/admin' && request.method === 'GET') {
      return htmlResponse(renderLoginPage());
    }
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Logout
  if (path === '/admin/logout' && request.method === 'POST') {
    return handleLogout();
  }

  // Dashboard
  if (path === '/admin' && request.method === 'GET') {
    return htmlResponse(renderDashboard());
  }

  // Stats API
  if (path === '/admin/stats' && request.method === 'GET') {
    return handleStats(env);
  }

  // Broadcast daily delivery
  if (path === '/admin/broadcast' && request.method === 'POST') {
    return handleBroadcast(request, env, ctx);
  }

  // Add pilot subscriber manually
  if (path === '/admin/add-subscriber' && request.method === 'POST') {
    return handleAddSubscriber(request, env);
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
    console.error('Login error:', err);
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

    const expiresAt = parseInt(payload, 10);
    return expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function signHmac(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ----------------------------------------------------------------------------
// Stats endpoint
// ----------------------------------------------------------------------------

async function handleStats(env) {
  const [activeResult, totalResult, todayResult] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as count FROM subscribers WHERE state = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM subscribers`).first(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM subscribers WHERE first_contact_at > ?`)
      .bind(Date.now() - 24 * 60 * 60 * 1000).first(),
  ]);

  return jsonResponse({
    active: activeResult.count,
    total: totalResult.count,
    newToday: todayResult.count,
  });
}

// ----------------------------------------------------------------------------
// Add pilot subscriber manually
// ----------------------------------------------------------------------------

async function handleAddSubscriber(request, env) {
  try {
    const { phone, name } = await request.json();

    if (!phone || !/^\d{10,15}$/.test(phone)) {
      return jsonResponse({ error: 'Phone must be 10-15 digits, no + sign' }, 400);
    }

    const now = Date.now();
    const cleanPhone = phone.replace(/\D/g, '');

    // Use INSERT OR REPLACE to handle re-adding
    await env.DB.prepare(
      `INSERT INTO subscribers
       (phone, state, tier, profile_name, first_contact_at, activated_at, updated_at)
       VALUES (?, 'active', 'standard', ?, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET
         state = 'active',
         activated_at = COALESCE(activated_at, ?),
         updated_at = ?`
    ).bind(cleanPhone, name || null, now, now, now, now, now).run();

    // Log the manual addition
    await env.DB.prepare(
      `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
       VALUES (?, 'pilot_manual_add', 'Manually added as pilot subscriber by admin', ?)`
    ).bind(cleanPhone, now).run();

    return jsonResponse({ success: true, phone: cleanPhone });
  } catch (err) {
    console.error('Add subscriber error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

// ----------------------------------------------------------------------------
// Broadcast daily delivery
// ----------------------------------------------------------------------------

async function handleBroadcast(request, env, ctx) {
  try {
    const { date, headlines, override } = await request.json();

    if (!date || !headlines || headlines.length !== 3) {
      return jsonResponse({ error: 'Missing date or 3 headlines' }, 400);
    }

    // Construct today's PDF URL from the date
    const kuwaitNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
    const year = kuwaitNow.getFullYear();
    const month = String(kuwaitNow.getMonth() + 1).padStart(2, '0');
    const day = String(kuwaitNow.getDate()).padStart(2, '0');
    const dateSlug = `${year}${month}${day}`;
    const pdfUrl = `${env.ALJARIDA_PDF_BASE_URL}/${year}/${month}/${day}/aljarida-${dateSlug}-1.pdf`;

    // Check if it's Saturday (no edition normally)
    const dayOfWeek = kuwaitNow.getDay(); // 0 = Sunday, 6 = Saturday
    if (dayOfWeek === 6 && !override) {
      return jsonResponse({
        error: 'Today is Saturday — no edition is normally published',
        warning: 'saturday',
        pdfUrl,
      }, 400);
    }

    // Verify the PDF is accessible
    try {
      const headResp = await fetch(pdfUrl, { method: 'HEAD' });
      if (!headResp.ok) {
        return jsonResponse({
          error: `PDF not found at ${pdfUrl}`,
          status: headResp.status,
        }, 400);
      }
    } catch (err) {
      return jsonResponse({
        error: `Could not reach PDF URL: ${err.message}`,
      }, 400);
    }

    // Get all active subscribers
    const { results: subscribers } = await env.DB.prepare(
      `SELECT phone FROM subscribers WHERE state = 'active' ORDER BY phone`
    ).all();

    if (subscribers.length === 0) {
      return jsonResponse({
        error: 'No active subscribers to send to',
        count: 0,
      }, 400);
    }

    // Send sequentially (fine for pilot size; refactor to queue at scale)
    const results = [];
    for (const sub of subscribers) {
      try {
        await sendDailyDeliveryTemplate(env, sub.phone, pdfUrl, date, headlines);
        results.push({ phone: sub.phone, ok: true });

        // Update last_delivery_at
        await env.DB.prepare(
          `UPDATE subscribers SET last_delivery_at = ? WHERE phone = ?`
        ).bind(Date.now(), sub.phone).run();
      } catch (err) {
        console.error(`Failed to send to ${sub.phone}:`, err.message);
        results.push({ phone: sub.phone, ok: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.ok).length;
    const failCount = results.filter(r => !r.ok).length;

    return jsonResponse({
      success: true,
      total: subscribers.length,
      sent: successCount,
      failed: failCount,
      pdfUrl,
      results,
    });
  } catch (err) {
    console.error('Broadcast error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

// ----------------------------------------------------------------------------
// HTML rendering
// ----------------------------------------------------------------------------

function renderLoginPage(errorMessage = null) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تسجيل الدخول — جريدة الجريدة الرقمية</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif;
    background: #f5f5f7; margin: 0; padding: 20px;
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: white; padding: 40px; border-radius: 12px; max-width: 400px; width: 100%;
    box-shadow: 0 4px 20px rgba(0,0,0,0.08);
  }
  h1 { margin: 0 0 8px; color: #1a1a1a; font-size: 24px; }
  .subtitle { color: #666; margin: 0 0 30px; font-size: 14px; }
  input[type="password"] {
    width: 100%; padding: 12px 16px; font-size: 16px; border: 1px solid #ddd;
    border-radius: 8px; margin-bottom: 16px; direction: ltr; text-align: left;
  }
  input[type="password"]:focus { outline: none; border-color: #0066cc; }
  button {
    width: 100%; padding: 12px; font-size: 16px; background: #0066cc; color: white;
    border: none; border-radius: 8px; cursor: pointer; font-weight: 600;
  }
  button:hover { background: #0052a3; }
  .error { color: #c00; background: #fee; padding: 10px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
  <h1>جريدة الجريدة الرقمية</h1>
  <p class="subtitle">لوحة التحكم — تسجيل الدخول</p>
  ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="كلمة المرور" required autofocus>
    <button type="submit">دخول</button>
  </form>
</div>
</body>
</html>`;
}

function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>لوحة التحكم — جريدة الجريدة الرقمية</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif;
    background: #f5f5f7; margin: 0; padding: 0;
  }
  header {
    background: white; padding: 20px 30px; border-bottom: 1px solid #e5e5e7;
    display: flex; justify-content: space-between; align-items: center;
  }
  h1 { margin: 0; font-size: 20px; color: #1a1a1a; }
  .logout { background: none; border: none; color: #666; cursor: pointer; font-size: 14px; }
  .container { max-width: 900px; margin: 0 auto; padding: 30px; }
  .stats {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 30px;
  }
  .stat-card {
    background: white; padding: 20px; border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .stat-label { color: #666; font-size: 13px; margin-bottom: 8px; }
  .stat-value { font-size: 32px; font-weight: 700; color: #1a1a1a; }
  .card {
    background: white; padding: 30px; border-radius: 12px; margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  h2 { margin: 0 0 20px; font-size: 18px; color: #1a1a1a; }
  label { display: block; font-size: 14px; color: #333; margin-bottom: 6px; font-weight: 500; }
  input[type="text"], input[type="tel"] {
    width: 100%; padding: 12px 14px; font-size: 15px; border: 1px solid #ddd;
    border-radius: 8px; margin-bottom: 16px; direction: rtl;
  }
  input[dir="ltr"] { direction: ltr; text-align: left; }
  input:focus { outline: none; border-color: #0066cc; }
  button.primary {
    background: #0066cc; color: white; border: none; padding: 14px 24px;
    font-size: 15px; border-radius: 8px; cursor: pointer; font-weight: 600;
  }
  button.primary:hover { background: #0052a3; }
  button.primary:disabled { background: #999; cursor: not-allowed; }
  button.secondary {
    background: white; color: #333; border: 1px solid #ddd; padding: 10px 20px;
    font-size: 14px; border-radius: 8px; cursor: pointer;
  }
  .status {
    margin-top: 20px; padding: 14px 18px; border-radius: 8px; font-size: 14px;
    display: none;
  }
  .status.visible { display: block; }
  .status.success { background: #e6f4ea; color: #137333; }
  .status.error { background: #fce8e6; color: #c5221f; }
  .status.warning { background: #fff8e1; color: #856400; }
  .progress-bar {
    width: 100%; height: 8px; background: #f0f0f0; border-radius: 4px;
    margin-top: 10px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: #0066cc; width: 0; transition: width 0.3s;
  }
  .pdf-info {
    background: #f5f5f7; padding: 14px; border-radius: 8px; margin-bottom: 20px;
    font-size: 13px; color: #666; direction: ltr; text-align: left;
    font-family: 'SF Mono', Monaco, monospace;
  }
</style>
</head>
<body>
<header>
  <h1>جريدة الجريدة الرقمية — لوحة التحكم</h1>
  <form method="POST" action="/admin/logout" style="margin:0">
    <button type="submit" class="logout">تسجيل الخروج</button>
  </form>
</header>

<div class="container">

  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">المشتركون النشطون</div>
      <div class="stat-value" id="stat-active">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">إجمالي الأرقام</div>
      <div class="stat-value" id="stat-total">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">جدد خلال 24 ساعة</div>
      <div class="stat-value" id="stat-new">—</div>
    </div>
  </div>

  <div class="card">
    <h2>إرسال عدد اليوم</h2>

    <div class="pdf-info" id="pdfInfo">جارٍ تحميل رابط PDF...</div>

    <label>تاريخ العدد (بالعربية)</label>
    <input type="text" id="date" placeholder="مثال: الثلاثاء 23 إبريل 2026">

    <label>العنوان الأول</label>
    <input type="text" id="headline1" placeholder="أبرز خبر اليوم">

    <label>العنوان الثاني</label>
    <input type="text" id="headline2" placeholder="خبر ثانٍ">

    <label>العنوان الثالث</label>
    <input type="text" id="headline3" placeholder="خبر ثالث">

    <button class="primary" id="sendBtn" onclick="sendBroadcast()">إرسال لجميع المشتركين</button>

    <div class="status" id="sendStatus"></div>
    <div class="progress-bar" id="progressBar" style="display:none">
      <div class="progress-fill" id="progressFill"></div>
    </div>
  </div>

  <div class="card">
    <h2>إضافة مشترك للمرحلة التجريبية</h2>
    <p style="color:#666; font-size:14px; margin-top:0">أضف مشتركاً يدوياً دون المرور بمرحلة الدفع — للاستخدام الداخلي فقط خلال المرحلة التجريبية.</p>

    <label>رقم الهاتف (بدون +، مع رمز الدولة)</label>
    <input type="tel" id="newPhone" placeholder="965XXXXXXXX" dir="ltr">

    <label>الاسم (اختياري، للمرجع الداخلي)</label>
    <input type="text" id="newName" placeholder="أحمد أحمد">

    <button class="secondary" onclick="addSubscriber()">إضافة</button>

    <div class="status" id="addStatus"></div>
  </div>

</div>

<script>
function getTodayUrl() {
  const d = new Date();
  const kuwait = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
  const y = kuwait.getFullYear();
  const m = String(kuwait.getMonth() + 1).padStart(2, '0');
  const dd = String(kuwait.getDate()).padStart(2, '0');
  return \`https://www.aljarida.com/uploads/pdf/\${y}/\${m}/\${dd}/aljarida-\${y}\${m}\${dd}-1.pdf\`;
}

function getArabicDate() {
  const months = ['يناير','فبراير','مارس','إبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const days = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
  return \`\${days[d.getDay()]} \${d.getDate()} \${months[d.getMonth()]} \${d.getFullYear()}\`;
}

document.getElementById('pdfInfo').textContent = getTodayUrl();
document.getElementById('date').value = getArabicDate();

// Load stats on page load
async function loadStats() {
  try {
    const resp = await fetch('/admin/stats');
    const data = await resp.json();
    document.getElementById('stat-active').textContent = data.active;
    document.getElementById('stat-total').textContent = data.total;
    document.getElementById('stat-new').textContent = data.newToday;
  } catch (err) {
    console.error('Stats error:', err);
  }
}
loadStats();
setInterval(loadStats, 30000);

async function sendBroadcast() {
  const date = document.getElementById('date').value.trim();
  const h1 = document.getElementById('headline1').value.trim();
  const h2 = document.getElementById('headline2').value.trim();
  const h3 = document.getElementById('headline3').value.trim();

  if (!date || !h1 || !h2 || !h3) {
    showStatus('sendStatus', 'يُرجى تعبئة التاريخ والعناوين الثلاثة', 'error');
    return;
  }

  const isSaturday = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' })).getDay() === 6;
  let override = false;
  if (isSaturday) {
    if (!confirm('اليوم السبت — لا يصدر عدد عادةً. هل أنت متأكد من الإرسال؟')) {
      return;
    }
    override = true;
  } else {
    if (!confirm(\`هل تريد إرسال عدد اليوم لجميع المشتركين النشطين؟\`)) {
      return;
    }
  }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الإرسال...';
  showStatus('sendStatus', 'جارٍ الإرسال، قد يستغرق ذلك بضع دقائق...', 'warning');
  document.getElementById('progressBar').style.display = 'block';
  document.getElementById('progressFill').style.width = '30%';

  try {
    const resp = await fetch('/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        headlines: [h1, h2, h3],
        override,
      }),
    });

    const data = await resp.json();
    document.getElementById('progressFill').style.width = '100%';

    if (data.success) {
      showStatus('sendStatus', \`تم الإرسال: \${data.sent} بنجاح، \${data.failed} فشل من أصل \${data.total} مشترك\`, 'success');
    } else {
      showStatus('sendStatus', data.error || 'فشل الإرسال', 'error');
    }
  } catch (err) {
    showStatus('sendStatus', 'خطأ في الاتصال: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'إرسال لجميع المشتركين';
    loadStats();
  }
}

async function addSubscriber() {
  const phone = document.getElementById('newPhone').value.trim();
  const name = document.getElementById('newName').value.trim();

  if (!phone || !/^\\d{10,15}$/.test(phone)) {
    showStatus('addStatus', 'الرجاء إدخال رقم صحيح (10-15 رقم بدون +)', 'error');
    return;
  }

  try {
    const resp = await fetch('/admin/add-subscriber', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name }),
    });

    const data = await resp.json();

    if (data.success) {
      showStatus('addStatus', 'تمت إضافة المشترك بنجاح', 'success');
      document.getElementById('newPhone').value = '';
      document.getElementById('newName').value = '';
      loadStats();
    } else {
      showStatus('addStatus', data.error || 'فشل الإضافة', 'error');
    }
  } catch (err) {
    showStatus('addStatus', 'خطأ: ' + err.message, 'error');
  }
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status visible ' + type;
}
</script>

</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Response helpers
// ----------------------------------------------------------------------------

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
