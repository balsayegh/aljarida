/**
 * Admin HTML page renderers.
 *
 * Dashboard changes vs previous version:
 *   - Defaults to NEXT publishing day (Al-Jarida publishes tomorrow's edition evening before)
 *   - Date picker lets admin change target date
 *   - URL override: click "تعديل يدوي" to paste a custom URL
 *   - "Reset to auto" button to revert
 *   - URL validation (starts with https://)
 */

export const SHARED_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, Arial, sans-serif;
    background: #f5f5f7; margin: 0; padding: 0; color: #1a1a1a;
  }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .topnav {
    background: white; padding: 0 30px;
    border-bottom: 1px solid #e5e5e7;
    display: flex; justify-content: space-between; align-items: center;
    position: sticky; top: 0; z-index: 100;
  }
  .topnav-brand { font-size: 18px; font-weight: 600; padding: 16px 0; }
  .topnav-links { display: flex; gap: 4px; }
  .topnav-links a {
    padding: 16px 18px; color: #555; font-size: 14px;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
  }
  .topnav-links a:hover { color: #0066cc; text-decoration: none; }
  .topnav-links a.active { color: #0066cc; border-bottom-color: #0066cc; font-weight: 500; }
  .topnav-actions { display: flex; gap: 8px; align-items: center; }
  .topnav-actions button {
    background: none; border: none; color: #666; cursor: pointer; font-size: 14px;
    padding: 6px 12px;
  }
  .topnav-actions button:hover { color: #0066cc; }

  .container { max-width: 1100px; margin: 0 auto; padding: 30px 20px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  h2 { margin: 0 0 16px; font-size: 18px; }
  .subtitle { color: #666; margin: 0 0 24px; font-size: 14px; }

  .card {
    background: white; padding: 24px; border-radius: 12px; margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }

  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 20px;
  }
  .stat-card {
    background: white; padding: 18px; border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .stat-label { color: #666; font-size: 12px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #1a1a1a; }
  .stat-sublabel { color: #999; font-size: 11px; margin-top: 4px; }

  label {
    display: block; font-size: 13px; color: #333;
    margin-bottom: 6px; font-weight: 500;
  }
  .label-row {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 6px;
  }
  .label-row label { margin: 0; }
  input[type="text"], input[type="tel"], input[type="search"], input[type="url"],
  input[type="password"], input[type="number"], input[type="date"],
  select, textarea {
    width: 100%; padding: 10px 14px; font-size: 14px;
    border: 1px solid #d1d1d6; border-radius: 8px; margin-bottom: 14px;
    background: white; font-family: inherit;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: #0066cc;
    box-shadow: 0 0 0 3px rgba(0,102,204,0.1);
  }
  input[dir="ltr"] { direction: ltr; text-align: left; }
  input[type="url"] { direction: ltr; text-align: left; font-family: 'SF Mono', Monaco, monospace; font-size: 13px; }

  button.primary {
    background: #0066cc; color: white; border: none; padding: 11px 22px;
    font-size: 14px; border-radius: 8px; cursor: pointer; font-weight: 600;
  }
  button.primary:hover { background: #0052a3; }
  button.primary:disabled { background: #999; cursor: not-allowed; }

  button.secondary {
    background: white; color: #333; border: 1px solid #d1d1d6;
    padding: 9px 18px; font-size: 14px; border-radius: 8px; cursor: pointer;
  }
  button.secondary:hover { border-color: #0066cc; color: #0066cc; }

  button.link-btn {
    background: none; border: none; color: #0066cc; cursor: pointer;
    font-size: 13px; padding: 4px 8px; font-family: inherit;
  }
  button.link-btn:hover { text-decoration: underline; }

  button.danger {
    background: white; color: #c5221f; border: 1px solid #f5c1bf;
    padding: 6px 14px; font-size: 13px; border-radius: 6px; cursor: pointer;
  }
  button.danger:hover { background: #fce8e6; }

  button.small {
    padding: 6px 12px; font-size: 13px;
  }

  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 12px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
  }
  .badge-active { background: #e6f4ea; color: #137333; }
  .badge-offered { background: #fff4e5; color: #b45309; }
  .badge-yes, .badge-awaiting_payment { background: #fff4e5; color: #b45309; }
  .badge-no { background: #fce8e6; color: #c5221f; }
  .badge-unsubscribed { background: #fce8e6; color: #c5221f; }
  .badge-paused { background: #f0f0f0; color: #555; }
  .badge-new { background: #e0f2fe; color: #0369a1; }
  .badge-custom { background: #e0f2fe; color: #0369a1; }
  .badge-auto { background: #f0f0f0; color: #555; }

  .badge-delivered { background: #e6f4ea; color: #137333; }
  .badge-read { background: #e0f2fe; color: #0369a1; }
  .badge-sent { background: #fff4e5; color: #b45309; }
  .badge-failed { background: #fce8e6; color: #c5221f; }

  .alert { padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }
  .alert-success { background: #e6f4ea; color: #137333; }
  .alert-error { background: #fce8e6; color: #c5221f; }
  .alert-warning { background: #fff8e1; color: #856400; }
  .alert-info { background: #e0f2fe; color: #0369a1; }

  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 12px 14px; text-align: right; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
  th { background: #f9f9fb; color: #555; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  tr:hover { background: #f9f9fb; }
  .phone { font-family: 'SF Mono', Monaco, monospace; direction: ltr; text-align: left; }
  .mono  { font-family: 'SF Mono', Monaco, monospace; direction: ltr; font-size: 13px; }

  /* Clickable subscriber rows */
  .sub-row { cursor: pointer; transition: background 0.1s; }
  .sub-row:hover { background: #eef5fc !important; }
  .phone-link { color: #0066cc; text-decoration: none; font-weight: 500; }
  .phone-link:hover { text-decoration: underline; }
  .view-link { color: #0066cc; font-size: 13px; white-space: nowrap; text-decoration: none; font-weight: 500; }
  .view-link:hover { text-decoration: underline; }
  .actions-cell { white-space: nowrap; }

  .filters-row {
    display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;
  }
  .filters-row select, .filters-row input {
    margin-bottom: 0; width: auto; min-width: 180px;
  }
  .filters-row input[type="search"] { flex: 1; max-width: 320px; }

  .progress-bar {
    width: 100%; height: 6px; background: #f0f0f0; border-radius: 3px;
    margin-top: 8px; overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: #0066cc; width: 0; transition: width 0.3s;
  }

  .code, .url-display {
    background: #f5f5f7; padding: 10px 14px; border-radius: 6px;
    font-family: 'SF Mono', Monaco, monospace; font-size: 12px;
    direction: ltr; text-align: left; color: #444;
    word-break: break-all;
  }
  .url-display {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
  }
  .url-display .url-text {
    flex: 1; font-size: 13px;
  }

  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

  .empty-state {
    text-align: center; padding: 40px 20px; color: #999;
  }

  .muted { color: #888; font-size: 13px; }

  .url-check {
    display: flex; align-items: center; gap: 8px; margin-top: 6px;
    font-size: 12px;
  }
  .url-check.checking { color: #666; }
  .url-check.ok { color: #137333; }
  .url-check.fail { color: #c5221f; }

  @media (max-width: 700px) {
    .grid-2 { grid-template-columns: 1fr; }
    .topnav { padding: 0 16px; flex-wrap: wrap; }
    .topnav-links a { padding: 12px 10px; font-size: 13px; }
    .container { padding: 20px 14px; }
    th, td { padding: 10px 8px; font-size: 13px; }
  }
`;

export function pageShell(title, activePage, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — جريدة الجريدة الرقمية</title>
<style>${SHARED_CSS}</style>
</head>
<body>

<nav class="topnav">
  <div class="topnav-brand">جريدة الجريدة الرقمية</div>
  <div class="topnav-links">
    <a href="/admin" class="${activePage === 'dashboard' ? 'active' : ''}">الرئيسية</a>
    <a href="/admin/subscribers" class="${activePage === 'subscribers' ? 'active' : ''}">المشتركون</a>
    <a href="/admin/broadcasts" class="${activePage === 'broadcasts' ? 'active' : ''}">سجل الإرسال</a>
    <a href="/admin/failures" class="${activePage === 'failures' ? 'active' : ''}">التنبيهات</a>
  </div>
  <div class="topnav-actions">
    <form method="POST" action="/admin/logout" style="margin:0">
      <button type="submit">تسجيل الخروج</button>
    </form>
  </div>
</nav>

<div class="container">
${bodyHtml}
</div>

</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Login page
// ----------------------------------------------------------------------------

export function renderLoginPage(errorMessage = null) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تسجيل الدخول — جريدة الجريدة الرقمية</title>
<style>${SHARED_CSS}
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .login-card { background: white; padding: 40px; border-radius: 12px; max-width: 400px; width: 100%; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
  .login-card h1 { margin: 0 0 8px; font-size: 22px; }
  .login-card .subtitle { margin: 0 0 28px; }
</style>
</head>
<body>
<div class="login-card">
  <h1>جريدة الجريدة الرقمية</h1>
  <p class="subtitle">لوحة التحكم — تسجيل الدخول</p>
  ${errorMessage ? `<div class="alert alert-error">${errorMessage}</div>` : ''}
  <form method="POST" action="/admin/login">
    <input type="password" name="password" placeholder="كلمة المرور" required autofocus dir="ltr">
    <button type="submit" class="primary" style="width:100%">دخول</button>
  </form>
</div>
</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Dashboard — UPDATED with URL override
// ----------------------------------------------------------------------------

export function renderDashboardPage() {
  const body = `
<h1>الرئيسية</h1>
<p class="subtitle">إرسال العدد القادم ونظرة عامة</p>

<div class="stats-grid" id="statsGrid">
  <div class="stat-card"><div class="stat-label">المشتركون النشطون</div><div class="stat-value" id="stat-active">—</div></div>
  <div class="stat-card"><div class="stat-label">قيد الاشتراك</div><div class="stat-value" id="stat-inflight">—</div></div>
  <div class="stat-card"><div class="stat-label">جدد 24 ساعة</div><div class="stat-value" id="stat-new">—</div></div>
  <div class="stat-card"><div class="stat-label">ملغون</div><div class="stat-value" id="stat-unsub">—</div></div>
  <div class="stat-card"><div class="stat-label">الإجمالي</div><div class="stat-value" id="stat-total">—</div></div>
</div>

<div class="card">
  <h2>إرسال العدد القادم</h2>
  <p class="muted" style="margin:0 0 16px">
    تنشر الجريدة عدد اليوم التالي مساءً بعد الساعة 8. حدد التاريخ المستهدف ثم اضغط "إرسال".
  </p>

  <div class="grid-2">
    <div>
      <label>تاريخ العدد المستهدف</label>
      <input type="date" id="targetDate" dir="ltr">
      <div class="muted" style="margin-top:-10px; font-size:12px">افتراضياً: يوم الإصدار التالي</div>
    </div>
    <div>
      <label>عرض بالعربية (سيظهر في الرسالة)</label>
      <input type="text" id="date" placeholder="مثال: الجمعة 24 إبريل 2026">
    </div>
  </div>

  <!-- URL section with toggle between auto and manual -->
  <div class="label-row">
    <label>رابط PDF <span id="urlModeBadge" class="badge badge-auto" style="margin-right:6px">تلقائي</span></label>
    <button type="button" class="link-btn" id="urlToggleBtn" onclick="toggleUrlMode()">تعديل يدوي</button>
  </div>

  <!-- Auto mode: just display -->
  <div id="urlAutoView">
    <div class="url-display">
      <span class="url-text" id="pdfInfo">—</span>
    </div>
    <div class="url-check" id="urlCheck"></div>
  </div>

  <!-- Manual mode: input field -->
  <div id="urlManualView" style="display:none">
    <input type="url" id="customPdfUrl" placeholder="https://www.aljarida.com/uploads/pdf/...">
    <div class="muted" style="margin-top:-10px; font-size:12px">
      أدخل رابط PDF بالكامل. يجب أن يبدأ بـ https://
      <button type="button" class="link-btn" onclick="resetToAuto()">العودة إلى التلقائي</button>
    </div>
  </div>

  <button class="primary" id="sendBtn" onclick="sendBroadcast()" style="margin-top:16px">
    إرسال لجميع المشتركين النشطين
  </button>

  <div class="alert" id="sendStatus" style="display:none; margin-top:16px"></div>
  <div class="progress-bar" id="progressBar" style="display:none">
    <div class="progress-fill" id="progressFill"></div>
  </div>
</div>

<div class="card" id="lastBroadcastCard" style="display:none">
  <h2>آخر إرسال</h2>
  <div id="lastBroadcastContent"></div>
</div>

<script>
// --- Date helpers -----------------------------------------------------------

function getNextPublishingDate() {
  const kuwait = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
  const target = new Date(kuwait);
  target.setDate(target.getDate() + 1);
  if (target.getDay() === 6) target.setDate(target.getDate() + 1);
  return target;
}

function formatArabicDate(d) {
  const months = ['يناير','فبراير','مارس','إبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const days = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function formatUrlDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { y, m, dd, slug: y + m + dd, iso: y + '-' + m + '-' + dd };
}

function buildPdfUrl(d) {
  const { y, m, dd, slug } = formatUrlDate(d);
  return 'https://www.aljarida.com/uploads/pdf/' + y + '/' + m + '/' + dd + '/aljarida-' + slug + '-1.pdf';
}

// --- URL mode state ---------------------------------------------------------

let urlMode = 'auto';  // 'auto' or 'manual'

function toggleUrlMode() {
  if (urlMode === 'auto') {
    urlMode = 'manual';
    document.getElementById('urlAutoView').style.display = 'none';
    document.getElementById('urlManualView').style.display = 'block';
    document.getElementById('urlToggleBtn').textContent = 'الرجوع للتلقائي';
    document.getElementById('urlModeBadge').className = 'badge badge-custom';
    document.getElementById('urlModeBadge').textContent = 'يدوي';
    // Pre-fill with current auto-URL for convenience
    const autoUrl = document.getElementById('pdfInfo').textContent;
    if (autoUrl && autoUrl !== '—' && !document.getElementById('customPdfUrl').value) {
      document.getElementById('customPdfUrl').value = autoUrl;
    }
    document.getElementById('customPdfUrl').focus();
  } else {
    resetToAuto();
  }
}

function resetToAuto() {
  urlMode = 'auto';
  document.getElementById('urlAutoView').style.display = 'block';
  document.getElementById('urlManualView').style.display = 'none';
  document.getElementById('urlToggleBtn').textContent = 'تعديل يدوي';
  document.getElementById('urlModeBadge').className = 'badge badge-auto';
  document.getElementById('urlModeBadge').textContent = 'تلقائي';
  // Keep the custom value in the input in case they toggle back
  const url = document.getElementById('pdfInfo').textContent;
  if (url && url !== '—') checkUrl(url);
}

// --- Update fields from date ------------------------------------------------

function updateFieldsFromDate(date) {
  const { iso } = formatUrlDate(date);
  document.getElementById('targetDate').value = iso;
  document.getElementById('date').value = formatArabicDate(date);
  const url = buildPdfUrl(date);
  document.getElementById('pdfInfo').textContent = url;
  if (urlMode === 'auto') checkUrl(url);
}

const nextDate = getNextPublishingDate();
updateFieldsFromDate(nextDate);

document.getElementById('targetDate').addEventListener('change', function(e) {
  const val = e.target.value;
  if (!val) return;
  const parts = val.split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  updateFieldsFromDate(d);
});

// --- URL check --------------------------------------------------------------

async function checkUrl(url) {
  const el = document.getElementById('urlCheck');
  el.className = 'url-check checking';
  el.textContent = '🔄 جارٍ التحقق...';

  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors' });
    el.className = 'url-check ok';
    el.textContent = '✓ الرابط يبدو صالحاً (التحقق النهائي عند الإرسال)';
  } catch (err) {
    el.className = 'url-check fail';
    el.textContent = '⚠ تعذّر التحقق من الرابط — قد لا يكون العدد منشوراً بعد';
  }
}

// --- Stats loader -----------------------------------------------------------

async function loadStats() {
  try {
    const r = await fetch('/admin/api/stats');
    const d = await r.json();
    document.getElementById('stat-active').textContent = d.active;
    document.getElementById('stat-inflight').textContent = d.inFlight;
    document.getElementById('stat-new').textContent = d.newToday;
    document.getElementById('stat-unsub').textContent = d.unsubscribed;
    document.getElementById('stat-total').textContent = d.total;

    if (d.lastBroadcast) {
      document.getElementById('lastBroadcastCard').style.display = 'block';
      const b = d.lastBroadcast;
      document.getElementById('lastBroadcastContent').innerHTML =
        '<p><strong>' + escapeHtml(b.date_string) + '</strong></p>' +
        '<p class="muted">أُرسل إلى ' + b.target_count + ' — نجح: ' + b.sent_count + '، فشل: ' + b.failed_count + '</p>' +
        '<p><a href="/admin/broadcasts/' + b.id + '">عرض التفاصيل →</a></p>';
    }
  } catch (err) { console.error(err); }
}
loadStats();
setInterval(loadStats, 30000);

// --- Broadcast --------------------------------------------------------------

async function sendBroadcast() {
  const targetDateIso = document.getElementById('targetDate').value;
  const date = document.getElementById('date').value.trim();

  if (!date) {
    showAlert('sendStatus', 'يُرجى تعبئة التاريخ', 'error');
    return;
  }

  let customUrl = null;
  if (urlMode === 'manual') {
    customUrl = document.getElementById('customPdfUrl').value.trim();
    if (!customUrl) {
      showAlert('sendStatus', 'يُرجى إدخال رابط PDF أو الرجوع للوضع التلقائي', 'error');
      return;
    }
    if (!customUrl.startsWith('https://') && !customUrl.startsWith('http://')) {
      showAlert('sendStatus', 'يجب أن يبدأ الرابط بـ https:// أو http://', 'error');
      return;
    }
    if (!customUrl.toLowerCase().includes('.pdf')) {
      if (!confirm('الرابط لا يحتوي على ".pdf" — هل أنت متأكد أنه رابط ملف PDF؟')) return;
    }
  }

  // Saturday check
  const parts = targetDateIso.split('-');
  const targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const isSaturday = targetDate.getDay() === 6;

  let override = false;
  if (isSaturday) {
    if (!confirm('اليوم المستهدف هو السبت — لا يصدر عدد عادةً. هل أنت متأكد؟')) return;
    override = true;
  } else {
    const urlInfo = customUrl ? '\\n\\nرابط مخصص: ' + customUrl : '';
    if (!confirm('هل تريد إرسال عدد "' + date + '" لجميع المشتركين النشطين؟' + urlInfo)) return;
  }

  const btn = document.getElementById('sendBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الإرسال...';
  showAlert('sendStatus', 'جارٍ الإرسال، قد يستغرق ذلك بضع دقائق...', 'warning');
  document.getElementById('progressBar').style.display = 'block';
  document.getElementById('progressFill').style.width = '30%';

  try {
    const r = await fetch('/admin/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        override,
        targetDateOverride: targetDateIso,
        customPdfUrl: customUrl,
      }),
    });
    const d = await r.json();
    document.getElementById('progressFill').style.width = '100%';

    if (d.success && d.status === 'queued') {
      showAlert('sendStatus',
        'تم جدولة الإرسال لـ ' + d.total + ' مشترك. التقدم يظهر في صفحة تفاصيل الإرسال. ' +
        '<a href="/admin/broadcasts/' + d.broadcast_id + '">عرض التفاصيل ←</a>',
        'info');
    } else if (d.success) {
      showAlert('sendStatus',
        'تم الإرسال: ' + d.sent + ' بنجاح، ' + d.failed + ' فشل من أصل ' + d.total + ' مشترك. ' +
        '<a href="/admin/broadcasts/' + d.broadcast_id + '">عرض التفاصيل</a>',
        'success');
    } else {
      let msg = d.error || 'فشل الإرسال';
      if (d.pdfUrl) msg += '<br><span class="code" style="display:inline-block;margin-top:6px">' + escapeHtml(d.pdfUrl) + '</span>';
      showAlert('sendStatus', msg, 'error');
    }
  } catch (err) {
    showAlert('sendStatus', 'خطأ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'إرسال لجميع المشتركين النشطين';
    loadStats();
  }
}

function showAlert(id, html, type) {
  const el = document.getElementById(id);
  el.innerHTML = html;
  el.className = 'alert alert-' + type;
  el.style.display = 'block';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
  `;
  return pageShell('الرئيسية', 'dashboard', body);
}

// ----------------------------------------------------------------------------
// Subscribers page (UNCHANGED)
// ----------------------------------------------------------------------------

export function renderSubscribersPage() {
  const body = `
<h1>المشتركون</h1>
<p class="subtitle">إدارة قائمة المشتركين وحالاتهم</p>

<div class="card">
  <div class="filters-row">
    <select id="filterState">
      <option value="all">جميع الحالات</option>
      <option value="active">نشط</option>
      <option value="offered">عرض الاشتراك</option>
      <option value="yes">وافق (لم يدفع)</option>
      <option value="awaiting_payment">بانتظار الدفع</option>
      <option value="paused">معلّق</option>
      <option value="no">رفض</option>
      <option value="unsubscribed">ألغى الاشتراك</option>
      <option value="new">جديد</option>
    </select>
    <input type="search" id="searchInput" placeholder="بحث عن رقم أو اسم...">
    <button class="secondary small" onclick="loadSubscribers()">تحديث</button>
  </div>

  <div id="subscribersContainer">
    <div class="empty-state">جارٍ التحميل...</div>
  </div>
</div>

<div class="card">
  <h2>إضافة مشترك يدوياً</h2>
  <p class="muted" style="margin:0 0 16px">للمرحلة التجريبية — يُضاف المشترك كنشط مباشرةً دون الدفع.</p>

  <div class="grid-2">
    <div>
      <label>رقم الهاتف (بدون +)</label>
      <input type="tel" id="newPhone" placeholder="965XXXXXXXX" dir="ltr">
    </div>
    <div>
      <label>الاسم (اختياري)</label>
      <input type="text" id="newName" placeholder="أحمد السالم">
    </div>
  </div>

  <label>ملاحظة داخلية (اختياري)</label>
  <input type="text" id="newNote" placeholder="مثال: فريق التحرير">

  <button class="primary" onclick="addSubscriber()">إضافة</button>

  <div class="alert" id="addStatus" style="display:none; margin-top:16px"></div>
</div>

<script>
async function loadSubscribers() {
  const state = document.getElementById('filterState').value;
  const search = document.getElementById('searchInput').value.trim();

  const params = new URLSearchParams();
  if (state !== 'all') params.set('state', state);
  if (search) params.set('search', search);

  const container = document.getElementById('subscribersContainer');
  container.innerHTML = '<div class="empty-state">جارٍ التحميل...</div>';

  try {
    const r = await fetch('/admin/api/subscribers?' + params);
    const d = await r.json();

    if (!d.subscribers || d.subscribers.length === 0) {
      container.innerHTML = '<div class="empty-state">لا يوجد مشتركون لعرضهم</div>';
      return;
    }

    container.innerHTML = renderTable(d.subscribers, d.total);
  } catch (err) {
    container.innerHTML = '<div class="alert alert-error">خطأ في التحميل: ' + err.message + '</div>';
  }
}

function renderTable(subs, total) {
  const rows = subs.map(function(s) {
    const detailUrl = '/admin/subscribers/' + encodeURIComponent(s.phone);
    return '<tr class="sub-row" onclick="openDetail(\\''+ s.phone +'\\', event)">' +
      '<td class="phone"><a href="' + detailUrl + '" class="phone-link" onclick="event.stopPropagation()">' + escapeHtml(s.phone) + '</a></td>' +
      '<td>' + (escapeHtml(s.profile_name) || '<span class="muted">—</span>') + '</td>' +
      '<td>' + renderBadge(s.state) + '</td>' +
      '<td>' + formatDate(s.first_contact_at) + '</td>' +
      '<td>' + (s.last_delivery_at ? formatDate(s.last_delivery_at) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + (escapeHtml(s.internal_note) || '<span class="muted">—</span>') + '</td>' +
      '<td class="actions-cell" onclick="event.stopPropagation()">' + renderActions(s) + '</td>' +
      '<td onclick="event.stopPropagation()"><a href="' + detailUrl + '" class="view-link">عرض ←</a></td>' +
    '</tr>';
  }).join('');

  return '<p class="muted" style="margin:0 0 12px">عرض ' + subs.length + ' من أصل ' + total + ' مشترك</p>' +
    '<div style="overflow-x:auto"><table>' +
    '<thead><tr>' +
      '<th>الهاتف</th><th>الاسم</th><th>الحالة</th>' +
      '<th>أول تواصل</th><th>آخر إرسال</th><th>ملاحظة</th><th>إجراءات</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function openDetail(phone, event) {
  // Only navigate if not clicking on an action button or link
  if (event.target.tagName === 'BUTTON' || event.target.tagName === 'A') return;
  location.href = '/admin/subscribers/' + encodeURIComponent(phone);
}

function renderBadge(state) {
  const labels = {
    active: 'نشط', offered: 'عرض', yes: 'وافق',
    awaiting_payment: 'ينتظر الدفع', paused: 'معلّق', no: 'رفض',
    unsubscribed: 'ألغى', new: 'جديد'
  };
  return '<span class="badge badge-' + state + '">' + (labels[state] || state) + '</span>';
}

function renderActions(s) {
  const buttons = [];
  if (s.state !== 'active') {
    buttons.push('<button class="secondary small" onclick="setState(\\''+ s.phone +'\\', \\'active\\')">تفعيل</button>');
  }
  if (s.state === 'active') {
    buttons.push('<button class="secondary small" onclick="setState(\\''+ s.phone +'\\', \\'paused\\')">تعليق</button>');
  }
  if (s.state !== 'unsubscribed') {
    buttons.push('<button class="danger" onclick="setState(\\''+ s.phone +'\\', \\'unsubscribed\\')">إلغاء</button>');
  }
  buttons.push('<button class="danger" onclick="deleteSub(\\''+ s.phone +'\\')">حذف</button>');
  return buttons.join(' ');
}

async function setState(phone, state) {
  const labels = { active: 'تفعيل', paused: 'تعليق', unsubscribed: 'إلغاء' };
  if (!confirm(labels[state] + ' هذا المشترك؟')) return;

  try {
    const r = await fetch('/admin/api/subscribers/' + phone, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const d = await r.json();
    if (d.success) loadSubscribers();
    else alert(d.error || 'فشل التحديث');
  } catch (err) { alert(err.message); }
}

async function deleteSub(phone) {
  if (!confirm('حذف هذا المشترك نهائياً من قاعدة البيانات؟')) return;
  try {
    const r = await fetch('/admin/api/subscribers/' + phone, { method: 'DELETE' });
    const d = await r.json();
    if (d.success) loadSubscribers();
    else alert(d.error || 'فشل الحذف');
  } catch (err) { alert(err.message); }
}

async function addSubscriber() {
  const phone = document.getElementById('newPhone').value.trim();
  const name = document.getElementById('newName').value.trim();
  const note = document.getElementById('newNote').value.trim();

  if (!phone || !/^\\d{10,15}$/.test(phone)) {
    showAlert('addStatus', 'الرجاء إدخال رقم صحيح (10-15 رقم بدون +)', 'error');
    return;
  }

  try {
    const r = await fetch('/admin/api/subscribers/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name, note }),
    });
    const d = await r.json();

    if (d.success) {
      showAlert('addStatus', 'تمت الإضافة بنجاح', 'success');
      document.getElementById('newPhone').value = '';
      document.getElementById('newName').value = '';
      document.getElementById('newNote').value = '';
      loadSubscribers();
    } else {
      showAlert('addStatus', d.error || 'فشل الإضافة', 'error');
    }
  } catch (err) { showAlert('addStatus', err.message, 'error'); }
}

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const diffMs = Date.now() - ts;
  const diffH = diffMs / 3600000;
  if (diffH < 1) return 'منذ دقائق';
  if (diffH < 24) return 'منذ ' + Math.floor(diffH) + ' ساعة';
  const days = Math.floor(diffH / 24);
  if (days < 30) return 'منذ ' + days + ' يوم';
  return d.toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' });
}

function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'alert alert-' + type;
  el.style.display = 'block';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.getElementById('filterState').addEventListener('change', loadSubscribers);

let searchTimeout;
document.getElementById('searchInput').addEventListener('input', function() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadSubscribers, 300);
});

loadSubscribers();
</script>
  `;
  return pageShell('المشتركون', 'subscribers', body);
}

// ----------------------------------------------------------------------------
// Broadcasts list page (UNCHANGED)
// ----------------------------------------------------------------------------

export function renderBroadcastsPage() {
  const body = `
<h1>سجل الإرسال</h1>
<p class="subtitle">جميع عمليات إرسال العدد اليومي</p>

<div class="card">
  <div id="broadcastsContainer">
    <div class="empty-state">جارٍ التحميل...</div>
  </div>
</div>

<script>
async function loadBroadcasts() {
  try {
    const r = await fetch('/admin/api/broadcasts');
    const d = await r.json();

    if (!d.broadcasts || d.broadcasts.length === 0) {
      document.getElementById('broadcastsContainer').innerHTML =
        '<div class="empty-state">لم يتم إرسال أي عدد حتى الآن</div>';
      return;
    }

    const rows = d.broadcasts.map(function(b) {
      const deliveryRate = b.target_count > 0 ?
        Math.round((b.delivered_count / b.target_count) * 100) : 0;
      const readRate = b.target_count > 0 ?
        Math.round((b.read_count / b.target_count) * 100) : 0;

      return '<tr onclick="location.href=\\'/admin/broadcasts/' + b.id + '\\'" style="cursor:pointer">' +
        '<td><strong>' + escapeHtml(b.date_string) + '</strong></td>' +
        '<td>' + b.target_count + '</td>' +
        '<td>' + b.sent_count + ' ✓</td>' +
        '<td>' + b.delivered_count + ' (' + deliveryRate + '%)</td>' +
        '<td>' + b.read_count + ' (' + readRate + '%)</td>' +
        '<td>' + (b.failed_count > 0 ? '<span style="color:#c5221f">' + b.failed_count + '</span>' : '—') + '</td>' +
        '<td>' + formatDate(b.started_at) + '</td>' +
      '</tr>';
    }).join('');

    document.getElementById('broadcastsContainer').innerHTML =
      '<div style="overflow-x:auto"><table>' +
      '<thead><tr>' +
        '<th>التاريخ</th><th>الهدف</th><th>أُرسل</th>' +
        '<th>وصل</th><th>مقروء</th><th>فشل</th><th>الوقت</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch (err) {
    document.getElementById('broadcastsContainer').innerHTML =
      '<div class="alert alert-error">خطأ: ' + err.message + '</div>';
  }
}

function formatDate(ts) {
  if (!ts) return '—';
  const diffH = (Date.now() - ts) / 3600000;
  if (diffH < 1) return 'منذ دقائق';
  if (diffH < 24) return 'منذ ' + Math.floor(diffH) + ' ساعة';
  const days = Math.floor(diffH / 24);
  if (days < 30) return 'منذ ' + days + ' يوم';
  return new Date(ts).toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

loadBroadcasts();
</script>
  `;
  return pageShell('سجل الإرسال', 'broadcasts', body);
}

// ----------------------------------------------------------------------------
// Broadcast detail page (UNCHANGED)
// ----------------------------------------------------------------------------

export function renderBroadcastDetailPage(broadcastId) {
  const body = `
<div style="margin-bottom:16px"><a href="/admin/broadcasts">← سجل الإرسال</a></div>

<div id="detailContainer">
  <div class="empty-state">جارٍ التحميل...</div>
</div>

<script>
const broadcastId = ${JSON.stringify(broadcastId)};
let currentPage = 1;
let currentFilter = '';  // '' = all, 'failed' = failed only
const PER_PAGE = 100;

async function loadDetail() {
  try {
    const params = new URLSearchParams({ page: currentPage, per_page: PER_PAGE });
    if (currentFilter) params.set('filter', currentFilter);
    const r = await fetch('/admin/api/broadcasts/' + broadcastId + '?' + params);
    const d = await r.json();

    if (d.error) {
      document.getElementById('detailContainer').innerHTML =
        '<div class="alert alert-error">' + d.error + '</div>';
      return;
    }

    const b = d.broadcast;
    const stats = d.stats;
    const pag = d.pagination;
    const deliveryRate = stats.total > 0 ? Math.round((stats.delivered / stats.total) * 100) : 0;
    const readRate = stats.total > 0 ? Math.round((stats.read / stats.total) * 100) : 0;

    const rows = d.recipients.map(function(r) {
      let deliveryBadge = '<span class="badge badge-sent">أُرسل</span>';
      if (r.send_status === 'failed') {
        deliveryBadge = '<span class="badge badge-failed">فشل الإرسال</span>';
      } else if (r.delivery_status === 'read') {
        deliveryBadge = '<span class="badge badge-read">مقروء</span>';
      } else if (r.delivery_status === 'delivered') {
        deliveryBadge = '<span class="badge badge-delivered">وصل</span>';
      } else if (r.delivery_status === 'failed') {
        deliveryBadge = '<span class="badge badge-failed">فشل التسليم</span>';
      }

      return '<tr>' +
        '<td class="phone">' + escapeHtml(r.phone) + '</td>' +
        '<td>' + deliveryBadge + '</td>' +
        '<td>' + (r.delivered_at ? formatTime(r.delivered_at) : '—') + '</td>' +
        '<td>' + (r.read_at ? formatTime(r.read_at) : '—') + '</td>' +
        '<td class="muted">' + (escapeHtml(r.error_message) || '—') + '</td>' +
      '</tr>';
    }).join('');

    const pagerHtml = renderPager(pag);

    document.getElementById('detailContainer').innerHTML =
      '<h1>عدد ' + escapeHtml(b.date_string) + '</h1>' +
      '<p class="subtitle">التفاصيل الكاملة للإرسال</p>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-label">الهدف</div><div class="stat-value">' + stats.total + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">أُرسل</div><div class="stat-value">' + stats.sent + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">وصل</div><div class="stat-value">' + stats.delivered + '</div><div class="stat-sublabel">' + deliveryRate + '%</div></div>' +
        '<div class="stat-card"><div class="stat-label">مقروء</div><div class="stat-value">' + stats.read + '</div><div class="stat-sublabel">' + readRate + '%</div></div>' +
        '<div class="stat-card"><div class="stat-label">فشل</div><div class="stat-value">' + (stats.failed_send + stats.failed_delivery) + '</div></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>تفاصيل العدد</h2>' +
        '<p><strong>التاريخ:</strong> ' + escapeHtml(b.date_string) + '</p>' +
        '<p><strong>ملف PDF:</strong></p>' +
        '<div class="code">' + escapeHtml(b.pdf_url) + '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
          '<h2 style="margin:0">المستلمون</h2>' +
          '<div>' +
            '<button class="' + (currentFilter === '' ? 'primary' : 'secondary') + ' small" onclick="setFilter(\\'\\')">الكل</button> ' +
            '<button class="' + (currentFilter === 'failed' ? 'primary' : 'secondary') + ' small" onclick="setFilter(\\'failed\\')">الفاشلة فقط</button>' +
          '</div>' +
        '</div>' +
        '<p class="muted">ملاحظة: حالة "مقروء" تظهر فقط للمشتركين الذين فعّلوا إيصالات القراءة في إعدادات واتساب.</p>' +
        '<div style="overflow-x:auto"><table>' +
        '<thead><tr>' +
          '<th>الهاتف</th><th>الحالة</th>' +
          '<th>وصل في</th><th>قُرئ في</th><th>خطأ</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        pagerHtml +
      '</div>';
  } catch (err) {
    document.getElementById('detailContainer').innerHTML =
      '<div class="alert alert-error">خطأ: ' + err.message + '</div>';
  }
}

function renderPager(p) {
  if (p.total_pages <= 1) return '';
  const prevDisabled = p.page <= 1 ? 'disabled' : '';
  const nextDisabled = p.page >= p.total_pages ? 'disabled' : '';
  return '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">' +
    '<span class="muted">صفحة ' + p.page + ' من ' + p.total_pages + ' — ' + p.total + ' مستلم</span>' +
    '<div>' +
      '<button class="secondary small" ' + prevDisabled + ' onclick="gotoPage(' + (p.page - 1) + ')">← السابق</button> ' +
      '<button class="secondary small" ' + nextDisabled + ' onclick="gotoPage(' + (p.page + 1) + ')">التالي →</button>' +
    '</div>' +
  '</div>';
}

function gotoPage(n) { currentPage = n; loadDetail(); }
function setFilter(f) { currentFilter = f; currentPage = 1; loadDetail(); }

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

loadDetail();
setInterval(loadDetail, 15000);
</script>
  `;
  return pageShell('تفاصيل الإرسال', 'broadcasts', body);
}

// ----------------------------------------------------------------------------
// Failures page (DLQ inspection)
// ----------------------------------------------------------------------------

export function renderFailuresPage() {
  const body = `
<h1>التنبيهات</h1>
<p class="subtitle">الرسائل التي فشل إرسالها بعد 3 محاولات (DLQ)</p>

<div class="card">
  <div id="failuresContainer">
    <div class="empty-state">جارٍ التحميل...</div>
  </div>
</div>

<script>
async function loadFailures() {
  try {
    const r = await fetch('/admin/api/failures?limit=200');
    const d = await r.json();

    const container = document.getElementById('failuresContainer');

    if (!d.failures || d.failures.length === 0) {
      container.innerHTML = '<div class="empty-state">لا توجد رسائل فاشلة 🎉</div>';
      return;
    }

    const rows = d.failures.map(function(f) {
      let payloadObj = {};
      try { payloadObj = JSON.parse(f.payload || '{}'); } catch {}
      const dateLabel = f.date_string ? escapeHtml(f.date_string) : ('#' + (f.broadcast_id || '?'));
      const broadcastLink = f.broadcast_id
        ? '<a href="/admin/broadcasts/' + f.broadcast_id + '">' + dateLabel + '</a>'
        : dateLabel;
      return '<tr>' +
        '<td>' + formatDateTime(f.failed_at) + '</td>' +
        '<td class="phone">' + escapeHtml(f.phone) + '</td>' +
        '<td>' + broadcastLink + '</td>' +
        '<td class="muted">' + (escapeHtml(payloadObj.date) || '—') + '</td>' +
      '</tr>';
    }).join('');

    container.innerHTML =
      '<p class="muted" style="margin:0 0 12px">' + d.total + ' رسالة فاشلة في المجموع — تعرض آخر ' + d.failures.length + '</p>' +
      '<div style="overflow-x:auto"><table>' +
      '<thead><tr>' +
        '<th>وقت الفشل</th><th>الهاتف</th><th>الإرسال</th><th>التاريخ</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch (err) {
    document.getElementById('failuresContainer').innerHTML =
      '<div class="alert alert-error">خطأ: ' + err.message + '</div>';
  }
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('ar', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

loadFailures();
setInterval(loadFailures, 30000);
</script>
  `;
  return pageShell('التنبيهات', 'failures', body);
}
