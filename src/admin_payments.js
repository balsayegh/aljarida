/**
 * Global Payments admin — list + filter + reconciliation.
 *
 * The page you go to when you need to:
 *   - Reconcile our records against an Ottu / KNET settlement report
 *     (filter by gateway + date range, compare totals)
 *   - Spot refunded / voided payments at a glance
 *   - Find a specific transaction by phone or PG reference
 *
 * Renders both the HTML shell (renderPaymentsPage) and the JSON API
 * (handlePaymentsApi) consumed by the page's client-side fetch.
 */

import { pageShell } from './admin_pages.js';
import { jsonResponse } from './admin.js';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE     = 200;
const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;  // last 30 days

/**
 * GET /admin/api/payments
 *   ?state=all|paid|refunded|voided|unknown
 *   ?gateway=all|knet|credit-card|manual
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (inclusive both ends; UTC)
 *   ?search=...                       (phone OR pg_reference OR reference)
 *   ?page=1&per_page=50
 */
export async function handlePaymentsApi(request, env) {
  const url = new URL(request.url);
  const state    = url.searchParams.get('state')    || 'all';
  const gateway  = url.searchParams.get('gateway')  || 'all';
  const search   = (url.searchParams.get('search')  || '').trim();
  const fromStr  = url.searchParams.get('from');
  const toStr    = url.searchParams.get('to');
  const page     = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage  = Math.min(MAX_PER_PAGE, Math.max(1, parseInt(url.searchParams.get('per_page') || String(DEFAULT_PER_PAGE), 10)));

  // Default to last 30 days when no range supplied — bounded query is much
  // friendlier on D1 than an open-ended ORDER BY ... LIMIT against a growing
  // payments table.
  const now = Date.now();
  const fromMs = fromStr ? Date.parse(fromStr + 'T00:00:00Z') : now - DEFAULT_RANGE_MS;
  const toMs   = toStr   ? Date.parse(toStr   + 'T23:59:59Z') : now;

  // We always build the WHERE clause against alias `p` so the same string
  // works for the aggregate query (no JOIN needed but harmless) and the
  // paginated query (which joins subscribers on phone — would otherwise be
  // ambiguous).
  const where = ['p.payment_date >= ?', 'p.payment_date <= ?'];
  const params = [fromMs, toMs];

  if (state !== 'all') {
    if (state === 'unknown') where.push('p.state IS NULL');
    else                     { where.push('p.state = ?');   params.push(state); }
  }

  if (gateway !== 'all') {
    if (gateway === 'manual') where.push('p.gateway IS NULL');
    else                      { where.push('p.gateway = ?'); params.push(gateway); }
  }

  if (search) {
    where.push('(p.phone LIKE ? OR p.pg_reference LIKE ? OR p.reference LIKE ?)');
    const pat = `%${search}%`;
    params.push(pat, pat, pat);
  }

  const whereSql = 'WHERE ' + where.join(' AND ');

  // Aggregate query — totals across the FULL filter, not just the current
  // page. This is what makes reconciliation usable.
  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*)                                                    AS count,
       COALESCE(SUM(CASE WHEN p.state = 'paid' OR p.state IS NULL THEN p.amount_kwd END), 0) AS total_paid_kwd,
       COALESCE(SUM(CASE WHEN p.state = 'refunded'                THEN p.amount_kwd END), 0) AS total_refunded_kwd,
       SUM(CASE WHEN p.state = 'paid'     THEN 1 ELSE 0 END)       AS paid_count,
       SUM(CASE WHEN p.state = 'refunded' THEN 1 ELSE 0 END)       AS refunded_count,
       SUM(CASE WHEN p.state = 'voided'   THEN 1 ELSE 0 END)       AS voided_count,
       SUM(CASE WHEN p.state IS NULL      THEN 1 ELSE 0 END)       AS unknown_count
     FROM payments p ${whereSql}`
  ).bind(...params).first();

  // Paginated rows — joined with subscribers so the table shows profile_name
  // alongside the phone without a second per-row query.
  const offset = (page - 1) * perPage;
  const { results: rows } = await env.DB.prepare(
    `SELECT p.*, s.profile_name
     FROM payments p
     LEFT JOIN subscribers s ON s.phone = p.phone
     ${whereSql}
     ORDER BY p.payment_date DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, perPage, offset).all();

  return jsonResponse({
    payments: rows,
    stats: {
      count:              stats?.count              || 0,
      total_paid_kwd:     stats?.total_paid_kwd     || 0,
      total_refunded_kwd: stats?.total_refunded_kwd || 0,
      paid_count:         stats?.paid_count         || 0,
      refunded_count:     stats?.refunded_count     || 0,
      voided_count:       stats?.voided_count       || 0,
      unknown_count:      stats?.unknown_count      || 0,
    },
    filter: { state, gateway, search, from: fromStr || isoDate(fromMs), to: toStr || isoDate(toMs) },
    pagination: {
      page,
      per_page:    perPage,
      total:       stats?.count || 0,
      total_pages: Math.ceil((stats?.count || 0) / perPage),
    },
  });
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Server-rendered shell. Real content is fetched/rendered client-side from
 * /admin/api/payments so filter changes don't require a full page reload.
 */
export function renderPaymentsPage() {
  const body = `
<h1>الدفعات</h1>

<div class="filter-bar">
  <div class="filter-row">
    <label>من <input type="date" id="fFrom"></label>
    <label>إلى <input type="date" id="fTo"></label>
    <label>الحالة
      <select id="fState">
        <option value="all">الكل</option>
        <option value="paid">مدفوع</option>
        <option value="refunded">مُستردّ</option>
        <option value="voided">مُلغى</option>
        <option value="unknown">يدوي/غير محدّد</option>
      </select>
    </label>
    <label>البوابة
      <select id="fGateway">
        <option value="all">الكل</option>
        <option value="knet">KNET</option>
        <option value="credit-card">Credit-Card</option>
        <option value="manual">يدوي</option>
      </select>
    </label>
    <label class="grow">بحث (هاتف، RRN، session_id)
      <input type="text" id="fSearch" placeholder="...">
    </label>
    <button class="primary" onclick="applyFilters()">تطبيق</button>
    <button class="secondary" onclick="resetFilters()">إعادة تعيين</button>
  </div>
</div>

<div class="stats-row" id="statsRow">
  <div class="stat-card"><div class="stat-label">عدد الدفعات</div><div class="stat-value" id="sCount">—</div></div>
  <div class="stat-card"><div class="stat-label">إجمالي المدفوع</div><div class="stat-value" id="sPaid">—</div></div>
  <div class="stat-card"><div class="stat-label">إجمالي المستردّ</div><div class="stat-value" id="sRefunded">—</div></div>
  <div class="stat-card"><div class="stat-label">مدفوعة / مستردّة / ملغاة / غير محدّدة</div><div class="stat-value" id="sBreakdown">—</div></div>
</div>

<div id="paymentsRoot"><div class="empty-state" style="padding:40px">جاري التحميل…</div></div>
<div id="pagerRoot" style="margin-top:16px"></div>

<script>
let currentPage = 1;
const PER_PAGE = 50;

function defaultFromDate() {
  const d = new Date(); d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

function readFilters() {
  return {
    from:    document.getElementById('fFrom').value    || defaultFromDate(),
    to:      document.getElementById('fTo').value      || todayIso(),
    state:   document.getElementById('fState').value,
    gateway: document.getElementById('fGateway').value,
    search:  document.getElementById('fSearch').value.trim(),
  };
}

function applyFilters() { currentPage = 1; load(); }

function resetFilters() {
  document.getElementById('fFrom').value = defaultFromDate();
  document.getElementById('fTo').value = todayIso();
  document.getElementById('fState').value = 'all';
  document.getElementById('fGateway').value = 'all';
  document.getElementById('fSearch').value = '';
  applyFilters();
}

async function load() {
  const f = readFilters();
  const qs = new URLSearchParams({
    from: f.from, to: f.to, state: f.state, gateway: f.gateway,
    search: f.search, page: String(currentPage), per_page: String(PER_PAGE),
  });
  const r = await fetch('/admin/api/payments?' + qs.toString());
  if (!r.ok) {
    document.getElementById('paymentsRoot').innerHTML =
      '<div class="empty-state" style="padding:40px">خطأ في التحميل</div>';
    return;
  }
  const d = await r.json();
  renderStats(d.stats);
  renderTable(d.payments);
  renderPager(d.pagination);
}

function renderStats(s) {
  document.getElementById('sCount').textContent = s.count;
  document.getElementById('sPaid').textContent  = s.total_paid_kwd.toFixed(3) + ' د.ك';
  document.getElementById('sRefunded').textContent = s.total_refunded_kwd.toFixed(3) + ' د.ك';
  document.getElementById('sBreakdown').textContent =
    s.paid_count + ' / ' + s.refunded_count + ' / ' + s.voided_count + ' / ' + s.unknown_count;
}

function renderTable(payments) {
  const root = document.getElementById('paymentsRoot');
  if (!payments.length) {
    root.innerHTML = '<div class="empty-state" style="padding:40px">لا توجد دفعات تطابق المرشّحات</div>';
    return;
  }
  let html = '<table><thead><tr>' +
    '<th>التاريخ</th><th>الهاتف / الاسم</th><th>المبلغ</th>' +
    '<th>البوابة</th><th>البطاقة</th><th>الحالة</th>' +
    '<th>المرجع</th><th></th>' +
    '</tr></thead><tbody>';
  payments.forEach(p => {
    const date = fmtDateTime(p.payment_date);
    const who = '<a href="/admin/subscribers/' + encodeURIComponent(p.phone) + '" class="phone-link">' +
                escHtml(p.phone) + '</a>' +
                (p.profile_name ? ' <span class="muted">' + escHtml(p.profile_name) + '</span>' : '');
    const amount = '<strong>' + Number(p.amount_kwd).toFixed(3) + ' د.ك</strong>';
    const gateway = p.gateway ? escHtml(p.gateway) : '<span class="muted">يدوي</span>';
    const card = p.card_last4 ? '<span class="mono">•••• ' + escHtml(p.card_last4) + '</span>' : '<span class="muted">—</span>';
    const stateBadge = badgeForState(p.state);
    const refDisplay = p.pg_reference || (p.reference ? p.reference.slice(0, 14) + '…' : '—');
    const ref = '<span class="mono" title="' + escHtml(p.pg_reference || p.reference || '') + '">' + escHtml(refDisplay) + '</span>';
    const view = '<a href="/admin/subscribers/' + encodeURIComponent(p.phone) + '" class="view-link">عرض ↗</a>';
    html += '<tr>' +
      '<td>' + date + '</td>' +
      '<td class="phone">' + who + '</td>' +
      '<td>' + amount + '</td>' +
      '<td>' + gateway + '</td>' +
      '<td>' + card + '</td>' +
      '<td>' + stateBadge + '</td>' +
      '<td>' + ref + '</td>' +
      '<td>' + view + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  root.innerHTML = html;
}

function renderPager(p) {
  const root = document.getElementById('pagerRoot');
  if (p.total_pages <= 1) { root.innerHTML = ''; return; }
  let html = '<div class="pager">';
  html += '<button ' + (p.page <= 1 ? 'disabled' : '') + ' onclick="gotoPage(' + (p.page - 1) + ')">السابق</button>';
  html += '<span class="pager-info">' + p.page + ' / ' + p.total_pages + ' (إجمالي ' + p.total + ')</span>';
  html += '<button ' + (p.page >= p.total_pages ? 'disabled' : '') + ' onclick="gotoPage(' + (p.page + 1) + ')">التالي</button>';
  html += '</div>';
  root.innerHTML = html;
}

function gotoPage(n) { currentPage = n; load(); window.scrollTo(0, 0); }

function badgeForState(s) {
  if (s === 'paid')     return '<span class="badge badge-delivered">مدفوع</span>';
  if (s === 'refunded') return '<span class="badge badge-failed">مُستردّ</span>';
  if (s === 'voided')   return '<span class="badge badge-failed">مُلغى</span>';
  return '<span class="muted">—</span>';
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Init
document.getElementById('fFrom').value = defaultFromDate();
document.getElementById('fTo').value = todayIso();
document.getElementById('fSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') applyFilters();
});
load();
</script>

<style>
.filter-bar { background: white; padding: 16px; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.filter-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
.filter-row label { display: flex; flex-direction: column; font-size: 12px; color: #666; gap: 4px; }
.filter-row label.grow { flex: 1 1 200px; }
.filter-row input, .filter-row select { padding: 8px 10px; border: 1px solid #e0e0e0; border-radius: 6px; font-family: inherit; }
.filter-row button { padding: 8px 16px; }

.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-card { background: white; padding: 14px 16px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.stat-label { font-size: 12px; color: #777; }
.stat-value { font-size: 22px; font-weight: 600; color: #111; margin-top: 4px; }

.pager { display: flex; gap: 12px; align-items: center; justify-content: center; }
.pager button { padding: 6px 14px; }
.pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.pager-info { color: #666; font-size: 13px; }
</style>
`;
  return pageShell('الدفعات', 'payments', body);
}
