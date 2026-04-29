/**
 * Subscriber detail page renderer.
 *
 * URL: /admin/subscribers/:phone
 *
 * Shows:
 *   - Header with phone, name, state, plan badges
 *   - Stats cards: days remaining, total paid, payment count, read rate
 *   - Action buttons: extend, change phone, add payment, add tag, pause, unsubscribe
 *   - Payment history
 *   - Event timeline
 *   - Recent deliveries
 *   - Notes editor
 */

import { SHARED_CSS, pageShell } from './admin_pages.js';

export function renderSubscriberDetailPage(phone) {
  const body = `
<div style="margin-bottom:16px"><a href="/admin/subscribers">← قائمة المشتركين</a></div>

<div id="detailRoot">
  <div class="empty-state">جارٍ التحميل...</div>
</div>

<!-- Modals -->
<div class="modal" id="extendModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('extendModal')"></div>
  <div class="modal-content">
    <h2>تمديد الاشتراك</h2>
    <label>المدة</label>
    <select id="extendDays" onchange="updateExtendCustom()">
      <option value="7">7 أيام (أسبوع)</option>
      <option value="14">14 يوم (أسبوعان)</option>
      <option value="30" selected>30 يوم (شهر)</option>
      <option value="60">60 يوم (شهران)</option>
      <option value="90">90 يوم (3 أشهر)</option>
      <option value="180">180 يوم (6 أشهر)</option>
      <option value="365">365 يوم (سنة)</option>
      <option value="custom">مدة مخصصة...</option>
    </select>
    <div id="extendCustomWrap" style="display:none">
      <label>عدد الأيام</label>
      <input type="number" id="extendCustomDays" min="1" max="3650" placeholder="أدخل عدد الأيام">
    </div>
    <label>السبب (اختياري)</label>
    <input type="text" id="extendReason" placeholder="هدية / تعويض / ولاء">
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('extendModal')">إلغاء</button>
      <button class="primary" onclick="doExtend()">تمديد</button>
    </div>
  </div>
</div>

<div class="modal" id="phoneChangeModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('phoneChangeModal')"></div>
  <div class="modal-content">
    <h2>تغيير رقم المشترك</h2>
    <div class="alert alert-warning" style="font-size:13px">
      ⚠️ تأكد من الاتفاق مع المشترك قبل التغيير. سيتم إرسال رسالة تأكيد إلى الرقم الجديد خلال 24 ساعة.
      إذا لم يؤكد، سيعود الاشتراك إلى الرقم القديم تلقائياً.
    </div>
    <label>الرقم القديم</label>
    <input type="text" id="oldPhoneDisplay" disabled dir="ltr">
    <label>الرقم الجديد (بدون +)</label>
    <input type="tel" id="newPhoneInput" placeholder="965XXXXXXXX" dir="ltr">
    <label>السبب (اختياري)</label>
    <input type="text" id="phoneChangeReason" placeholder="تغيير الجهاز / رقم جديد">
    <label><input type="checkbox" id="skipVerification"> تخطي رسالة التأكيد (لن يُرسل طلب تأكيد)</label>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('phoneChangeModal')">إلغاء</button>
      <button class="primary" onclick="doChangePhone()">تغيير الرقم</button>
    </div>
  </div>
</div>

<div class="modal" id="paymentModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('paymentModal')"></div>
  <div class="modal-content">
    <h2>إضافة دفعة</h2>
    <div class="grid-2">
      <div>
        <label>المبلغ (د.ك)</label>
        <input type="number" id="paymentAmount" step="0.001" value="12" min="0">
      </div>
      <div>
        <label>طريقة الدفع</label>
        <select id="paymentMethod">
          <option value="knet">K-Net</option>
          <option value="visa">Visa / Mastercard</option>
          <option value="cash">نقداً</option>
          <option value="bank_transfer">تحويل بنكي</option>
          <option value="gift">هدية</option>
          <option value="manual">يدوي</option>
        </select>
      </div>
    </div>
    <label>الخطة</label>
    <select id="paymentPlan">
      <option value="yearly">سنوي (12 د.ك)</option>
    </select>
    <label>المرجع (اختياري)</label>
    <input type="text" id="paymentReference" placeholder="رقم العملية / ملاحظة">
    <label>ملاحظات (اختياري)</label>
    <input type="text" id="paymentNotes" placeholder="أي ملاحظات إضافية">
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('paymentModal')">إلغاء</button>
      <button class="primary" onclick="doAddPayment()">إضافة الدفعة</button>
    </div>
  </div>
</div>

<div class="modal" id="tagModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('tagModal')"></div>
  <div class="modal-content">
    <h2>إضافة وسم</h2>
    <label>الوسم</label>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px">
      <button class="secondary small" onclick="pickTag('vip')">VIP</button>
      <button class="secondary small" onclick="pickTag('editor')">محرر</button>
      <button class="secondary small" onclick="pickTag('press')">صحافة</button>
      <button class="secondary small" onclick="pickTag('loyal')">مخلص</button>
      <button class="secondary small" onclick="pickTag('trial')">تجريبي</button>
      <button class="secondary small" onclick="pickTag('pilot')">pilot</button>
    </div>
    <input type="text" id="tagInput" placeholder="أو اكتب وسم مخصص">
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('tagModal')">إلغاء</button>
      <button class="primary" onclick="doAddTag()">إضافة</button>
    </div>
  </div>
</div>

<div class="modal" id="planModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('planModal')"></div>
  <div class="modal-content">
    <h2>تغيير خطة الاشتراك</h2>
    <label>الخطة</label>
    <select id="planSelect">
      <option value="yearly">سنوي (12 د.ك)</option>
      <option value="pilot">تجريبي (بدون انتهاء)</option>
      <option value="gift">هدية (مدة مخصصة)</option>
    </select>
    <div id="giftDaysWrap" style="display:none">
      <label>مدة الهدية (أيام)</label>
      <input type="number" id="giftDays" value="30" min="1">
    </div>
    <div class="alert alert-info" style="font-size:13px">
      ℹ️ تغيير الخطة قد يعيد حساب تاريخ انتهاء الاشتراك. استخدم "إضافة دفعة" لتمديد الفترة.
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('planModal')">إلغاء</button>
      <button class="primary" onclick="doChangePlan()">تغيير الخطة</button>
    </div>
  </div>
</div>

<div class="modal" id="nameModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('nameModal')"></div>
  <div class="modal-content">
    <h2>تعديل اسم المشترك</h2>
    <label>الاسم (اتركه فارغاً للحذف)</label>
    <input type="text" id="nameInput" placeholder="أحمد السالم">
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('nameModal')">إلغاء</button>
      <button class="primary" onclick="doSaveName()">حفظ</button>
    </div>
  </div>
</div>

<div class="modal" id="noteModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('noteModal')"></div>
  <div class="modal-content">
    <h2>تعديل الملاحظة الداخلية</h2>
    <label>الملاحظة (اتركها فارغة لحذفها)</label>
    <textarea id="noteInput" rows="4" placeholder="ملاحظة لا يراها العميل، للإدارة فقط" style="width:100%; padding:10px 14px; border:1px solid #d1d1d6; border-radius:8px; font-family:inherit; font-size:14px; resize:vertical"></textarea>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('noteModal')">إلغاء</button>
      <button class="primary" onclick="doSaveNote()">حفظ</button>
    </div>
  </div>
</div>

<div class="modal" id="refundModal" style="display:none">
  <div class="modal-backdrop" onclick="closeModal('refundModal')"></div>
  <div class="modal-content">
    <h2>استرداد دفعة</h2>
    <div class="alert alert-info" style="font-size:13px; margin-bottom:12px">
      <div>المبلغ الأصلي: <strong id="refundOrigAmount">—</strong> د.ك</div>
      <div>المسترد سابقاً: <strong id="refundAlready">—</strong> د.ك</div>
      <div>المتاح للاسترداد: <strong id="refundAvailable">—</strong> د.ك</div>
    </div>
    <label>المبلغ المراد استرداده (د.ك)</label>
    <input type="number" id="refundAmount" step="0.001" min="0">
    <label>السبب (اختياري)</label>
    <input type="text" id="refundReason" placeholder="مثال: تم بالخطأ / طلب العميل">
    <label style="display:flex; align-items:center; gap:8px; font-weight:normal; margin-top:8px">
      <input type="checkbox" id="refundNotify" checked>
      <span>إشعار العميل عبر واتساب (إذا كانت نافذة 24 ساعة مفتوحة)</span>
    </label>
    <div class="alert alert-warning" id="refundFullWarning" style="font-size:13px; margin-top:12px; display:none">
      ⚠ استرداد كامل يلغي الاشتراك فوراً (يُحوَّل المشترك إلى "معلّق").
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeModal('refundModal')">إلغاء</button>
      <button class="danger" onclick="doRefund()">تنفيذ الاسترداد</button>
    </div>
  </div>
</div>

<style>
.modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.4); }
.modal-content { position: relative; background: white; border-radius: 12px; padding: 28px; max-width: 500px; width: 100%; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
.modal-content h2 { margin: 0 0 20px; font-size: 20px; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

.detail-header { background: white; border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.detail-title { font-family: 'SF Mono', Monaco, monospace; direction: ltr; font-size: 24px; font-weight: 600; }
.detail-name { font-size: 16px; color: #666; margin-top: 4px; }
.detail-badges { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }

.stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-box { background: white; padding: 16px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.stat-box .lbl { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.stat-box .val { font-size: 22px; font-weight: 700; }
.stat-box .sub { font-size: 12px; color: #999; margin-top: 4px; }
.stat-box.warning { border-right: 4px solid #ff9800; }
.stat-box.critical { border-right: 4px solid #f44336; }
.stat-box.expired { border-right: 4px solid #c62828; background: #ffebee; }
.stat-box.pilot { border-right: 4px solid #0066cc; background: #f0f7ff; }

.actions-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; background: white; padding: 16px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }

.section { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
.section h3 { margin: 0 0 14px; font-size: 16px; }

.timeline-item { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.timeline-item:last-child { border-bottom: none; }
.timeline-date { font-size: 12px; color: #999; }
.timeline-event { font-size: 14px; margin-top: 4px; }
.timeline-by { font-size: 11px; color: #999; margin-top: 2px; }

.tag-chip { display: inline-block; padding: 4px 10px; background: #e3f2fd; color: #0d47a1; border-radius: 12px; margin: 2px; font-size: 12px; }
.tag-chip .x { cursor: pointer; margin-right: 6px; color: #c5221f; font-weight: bold; }
.tag-chip .x:hover { color: #8b1210; }

.notes-box { background: #fffbf0; padding: 14px; border-radius: 8px; border-right: 3px solid #fbbc04; font-size: 14px; }

.pending-banner { background: #fff3cd; border: 1px solid #ffc107; color: #856404; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
</style>

<script>
const phone = ${JSON.stringify(phone)};
let currentSubscriber = null;

async function loadDetail() {
  try {
    const r = await fetch('/admin/api/subscribers/' + phone);
    const d = await r.json();
    if (d.error) {
      document.getElementById('detailRoot').innerHTML =
        '<div class="alert alert-error">' + d.error + '</div>';
      return;
    }
    currentSubscriber = d.subscriber;
    render(d);
  } catch (err) {
    document.getElementById('detailRoot').innerHTML =
      '<div class="alert alert-error">خطأ: ' + err.message + '</div>';
  }
}

function render(d) {
  const sub = d.subscriber;
  const planLabels = { monthly: 'شهري', yearly: 'سنوي', pilot: 'تجريبي', gift: 'هدية' };
  const stateLabels = { active: 'نشط', offered: 'عرض', yes: 'وافق', awaiting_payment: 'ينتظر الدفع',
                        paused: 'معلّق', no: 'رفض', unsubscribed: 'ألغى', new: 'جديد' };

  // Header
  let html = '<div class="detail-header">';
  html += '<div class="detail-title">' + escHtml(sub.phone) + '</div>';
  // Name with inline edit affordance — both shown vs missing states get a button.
  if (sub.profile_name) {
    html += '<div class="detail-name">' + escHtml(sub.profile_name) +
            ' <button class="link-btn" onclick="openEditName()" style="font-size:13px">تعديل</button>' +
            '</div>';
  } else {
    html += '<div class="detail-name muted">' +
            '<em>لا يوجد اسم</em> ' +
            '<button class="link-btn" onclick="openEditName()" style="font-size:13px">إضافة</button>' +
            '</div>';
  }
  html += '<div class="detail-badges">';
  html += '<span class="badge badge-' + sub.state + '">' + (stateLabels[sub.state] || sub.state) + '</span>';
  html += '<span class="badge badge-' + (sub.subscription_plan || 'yearly') + '">' + (planLabels[sub.subscription_plan] || sub.subscription_plan || '—') + '</span>';
  (sub.tags || []).forEach(function(t) {
    html += '<span class="tag-chip">' + escHtml(t) + ' <span class="x" onclick="removeTag(\\''+ encodeURIComponent(t) +'\\')">×</span></span>';
  });
  html += '</div></div>';

  // Pending phone change banner
  if (sub.has_pending_phone_change) {
    const p = sub.phone_change_pending;
    html += '<div class="pending-banner">⏳ طلب تغيير رقم معلّق من ' + escHtml(p.old_phone) + ' إلى ' + escHtml(p.new_phone) +
            ' — ينتهي خلال ' + timeUntil(p.expires_at) + '</div>';
  }

  // Stats
  html += '<div class="stats-row">';
  // Days remaining
  const days = sub.days_remaining;
  const statusCls = sub.expiry_status;
  let daysDisplay;
  if (sub.subscription_plan === 'pilot') daysDisplay = '∞';
  else if (days === null) daysDisplay = '—';
  else if (days < 0) daysDisplay = 'منتهي';
  else if (days === 0) daysDisplay = 'اليوم';
  else if (days === 1) daysDisplay = 'يوم';
  else daysDisplay = days + ' يوم';
  html += '<div class="stat-box ' + statusCls + '"><div class="lbl">الأيام المتبقية</div>' +
          '<div class="val">' + daysDisplay + '</div>' +
          '<div class="sub">' + (sub.subscription_end_at ? fmtDate(sub.subscription_end_at) : '—') + '</div></div>';

  // Last payment
  html += '<div class="stat-box"><div class="lbl">آخر دفعة</div>' +
          '<div class="val">' + (sub.last_payment_amount_kwd ? sub.last_payment_amount_kwd.toFixed(2) + ' د.ك' : '—') + '</div>' +
          '<div class="sub">' + (sub.last_payment_at ? fmtDateRel(sub.last_payment_at) : 'لا توجد دفعات') + '</div></div>';

  // Total paid
  html += '<div class="stat-box"><div class="lbl">المجموع المدفوع</div>' +
          '<div class="val">' + (sub.total_paid_kwd || 0).toFixed(2) + ' د.ك</div>' +
          '<div class="sub">' + (sub.payment_count || 0) + ' دفعة</div></div>';

  // Read rate
  html += '<div class="stat-box"><div class="lbl">معدل القراءة</div>' +
          '<div class="val">' + (sub.read_rate !== null ? sub.read_rate + '%' : '—') + '</div>' +
          '<div class="sub">' + (sub.read_rate !== null ? readLabel(sub.read_rate) : 'غير متاح') + '</div></div>';

  html += '</div>';

  // Actions
  html += '<div class="actions-bar">';
  html += '<button class="primary small" onclick="openModal(\\'extendModal\\')">تمديد الاشتراك</button>';
  html += '<button class="primary small" onclick="openModal(\\'paymentModal\\')">إضافة دفعة</button>';
  if (sub.state !== 'unsubscribed') {
    html += '<button class="secondary small" onclick="doSendPaymentLink()">إرسال رابط دفع</button>';
    html += '<button class="secondary small" onclick="doResendLastEdition()">إعادة إرسال آخر عدد</button>';
  }
  html += '<button class="secondary small" onclick="openPhoneChange()">تغيير الرقم</button>';
  html += '<button class="secondary small" onclick="openModal(\\'planModal\\'); document.getElementById(\\'planSelect\\').value = \\''+ (sub.subscription_plan || 'yearly') +'\\';">تغيير الخطة</button>';
  html += '<button class="secondary small" onclick="openModal(\\'tagModal\\')">إضافة وسم</button>';
  if (sub.state === 'active') html += '<button class="secondary small" onclick="setState(\\'paused\\')">تعليق</button>';
  if (sub.state === 'paused') html += '<button class="primary small" onclick="setState(\\'active\\')">تفعيل</button>';
  if (sub.state !== 'unsubscribed') html += '<button class="danger" onclick="setState(\\'unsubscribed\\')">إلغاء الاشتراك</button>';
  html += '</div>';

  // Payment intents (Ottu checkout sessions — pending + recent history)
  if (d.payment_intents && d.payment_intents.length > 0) {
    // Surface pending intents older than 1 hour as a small heads-up
    const STALE_PENDING_MS = 60 * 60 * 1000;
    const now = Date.now();
    const stalePending = d.payment_intents.filter(function(pi) {
      return pi.state === 'pending' && (now - pi.created_at) > STALE_PENDING_MS;
    });

    html += '<div class="section"><h3>🔗 محاولات الدفع (Ottu)</h3>';

    if (stalePending.length > 0) {
      html += '<div class="alert-info" style="margin-bottom:12px;padding:10px 14px;border-radius:8px">' +
              '⚠ يوجد ' + stalePending.length + ' محاولة دفع معلّقة منذ أكثر من ساعة. ' +
              'قد يكون العميل أنشأ الرابط ولم يكمل الدفع.' +
              '</div>';
    }

    html += '<table><thead><tr>' +
            '<th>التاريخ</th><th>المبلغ</th><th>الحالة</th><th>العمر</th>' +
            '<th>المرجع (session_id)</th><th>الرابط</th><th>إجراءات</th>' +
            '</tr></thead><tbody>';

    d.payment_intents.forEach(function(pi) {
      let stateBadge;
      if (pi.state === 'paid') stateBadge = '<span class="badge badge-delivered">مدفوع</span>';
      else if (pi.state === 'pending') stateBadge = '<span class="badge badge-awaiting_payment">معلّق</span>';
      else if (pi.state === 'failed' || pi.state === 'error') stateBadge = '<span class="badge badge-failed">فشل</span>';
      else if (pi.state === 'canceled' || pi.state === 'cancelled') stateBadge = '<span class="badge badge-failed">ملغى</span>';
      else if (pi.state === 'expired') stateBadge = '<span class="badge badge-failed">منتهي</span>';
      else stateBadge = '<span class="badge">' + escHtml(pi.state || '?') + '</span>';

      const ageMs = now - pi.created_at;
      let age;
      if (ageMs < 60000) age = 'الآن';
      else if (ageMs < 3600000) age = Math.floor(ageMs / 60000) + ' د';
      else if (ageMs < 86400000) age = Math.floor(ageMs / 3600000) + ' س';
      else age = Math.floor(ageMs / 86400000) + ' ي';

      // Truncated session_id for readability; full id in tooltip
      const shortId = pi.session_id ? pi.session_id.slice(0, 12) + '…' : '—';
      const linkCell = pi.checkout_url
        ? '<a href="' + escHtml(pi.checkout_url) + '" target="_blank" rel="noopener" class="view-link">فتح ↗</a>'
        : '<span class="muted">—</span>';

      // Cancel only meaningful for unpaid + non-canceled rows. Ottu's cancel
      // op accepts pending/created/attempted; we surface it on 'pending' which
      // is by far the most common — others rarely happen for our flow.
      const cancellable = pi.state === 'pending';
      const actionCell = cancellable
        ? '<button class="danger small" onclick="doCancelIntent(\\''+ escHtml(pi.session_id) +'\\')">إلغاء</button>'
        : '<span class="muted">—</span>';

      html += '<tr>' +
              '<td>' + fmtDate(pi.created_at) + ' ' + fmtTime(pi.created_at) + '</td>' +
              '<td><strong>' + (pi.amount_kwd ? pi.amount_kwd.toFixed(3) : '—') + ' د.ك</strong></td>' +
              '<td>' + stateBadge + '</td>' +
              '<td class="muted">' + age + '</td>' +
              '<td class="mono" title="' + escHtml(pi.session_id || '') + '">' + escHtml(shortId) + '</td>' +
              '<td>' + linkCell + '</td>' +
              '<td>' + actionCell + '</td>' +
              '</tr>';
    });

    html += '</tbody></table></div>';
  }

  // Payment history
  html += '<div class="section"><h3>💰 سجل الدفعات</h3>';
  if (!d.payments || d.payments.length === 0) {
    html += '<div class="empty-state" style="padding:20px">لا توجد دفعات مسجلة</div>';
  } else {
    html += '<table><thead><tr>' +
            '<th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>البطاقة</th>' +
            '<th>الحالة</th><th>الفترة</th><th>المرجع</th><th>إجراءات</th>' +
            '</tr></thead><tbody>';
    d.payments.forEach(function(p) {
      // Method cell: show gateway when present (Ottu rows), fall back to method
      const methodCell = p.gateway
        ? escHtml(p.gateway) + ' <span class="muted">(' + methodLabel(p.payment_method) + ')</span>'
        : methodLabel(p.payment_method);

      // Card cell: '•••• 1234' if known, '—' otherwise (KNET/manual)
      const cardCell = p.card_last4
        ? '<span class="mono">•••• ' + escHtml(p.card_last4) + '</span>'
        : '<span class="muted">—</span>';

      // State badge — partially_refunded shows the refunded amount inline
      const refundedSoFar = Number(p.refunded_amount_kwd) || 0;
      let stateBadge;
      if (p.state === 'paid' || (p.state == null && refundedSoFar === 0)) {
        stateBadge = '<span class="badge badge-delivered">مدفوع</span>';
      } else if (p.state === 'refunded') {
        stateBadge = '<span class="badge badge-failed">مُستردّ</span>';
      } else if (p.state === 'partially_refunded') {
        stateBadge = '<span class="badge badge-failed">مُستردّ جزئياً (' + refundedSoFar.toFixed(3) + ')</span>';
      } else if (p.state === 'voided') {
        stateBadge = '<span class="badge badge-failed">مُلغى</span>';
      } else {
        stateBadge = '<span class="muted">—</span>';
      }

      // Reference: prefer pg_reference (RRN/transaction_id) — the value you'd
      // give the bank or Ottu support — fall back to our internal session_id
      const refCell = p.pg_reference
        ? '<span class="mono">' + escHtml(p.pg_reference) + '</span>'
        : '<span class="muted">' + (escHtml(p.reference) || '—') + '</span>';

      // Refund button only for Ottu-sourced payments with refundable balance left
      const remaining = Number(p.amount_kwd) - refundedSoFar;
      const canRefund = p.payment_method === 'ottu' && p.reference && remaining > 0.001 && p.state !== 'refunded' && p.state !== 'voided';
      const actionCell = canRefund
        ? '<button class="danger small" onclick="openRefund(' + p.id + ',' + p.amount_kwd + ',' + refundedSoFar + ')">استرداد</button>'
        : '<span class="muted">—</span>';

      html += '<tr>' +
              '<td>' + fmtDate(p.payment_date) + '</td>' +
              '<td><strong>' + p.amount_kwd.toFixed(3) + ' د.ك</strong></td>' +
              '<td>' + methodCell + '</td>' +
              '<td>' + cardCell + '</td>' +
              '<td>' + stateBadge + '</td>' +
              '<td class="muted">' + fmtDate(p.period_start) + ' → ' + fmtDate(p.period_end) + '</td>' +
              '<td>' + refCell + '</td>' +
              '<td>' + actionCell + '</td>' +
              '</tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div>';

  // Event timeline
  html += '<div class="section"><h3>📅 سجل الأحداث</h3>';
  if (!d.events || d.events.length === 0) {
    html += '<div class="empty-state" style="padding:20px">لا توجد أحداث</div>';
  } else {
    d.events.slice(0, 30).forEach(function(e) {
      const parsed = (function() { try { return JSON.parse(e.details || '{}'); } catch { return {}; } })();
      html += '<div class="timeline-item">' +
              '<div class="timeline-date">' + fmtDate(e.created_at) + ' ' + fmtTime(e.created_at) + '</div>' +
              '<div class="timeline-event">' + eventText(e.event_type, parsed) + '</div>' +
              '<div class="timeline-by">بواسطة: ' + (e.performed_by || 'system') + '</div>' +
              '</div>';
    });
  }
  html += '</div>';

  // Recent deliveries
  if (d.recent_deliveries && d.recent_deliveries.length > 0) {
    html += '<div class="section"><h3>📬 آخر 10 عمليات إرسال</h3>';
    html += '<table><thead><tr><th>التاريخ</th><th>الحالة</th><th>وصل</th><th>قُرئ</th></tr></thead><tbody>';
    d.recent_deliveries.forEach(function(dv) {
      let badge;
      if (dv.delivery_status === 'read') badge = '<span class="badge badge-read">مقروء</span>';
      else if (dv.delivery_status === 'delivered') badge = '<span class="badge badge-delivered">وصل</span>';
      else if (dv.delivery_status === 'failed' || dv.send_status === 'failed') badge = '<span class="badge badge-failed">فشل</span>';
      else badge = '<span class="badge badge-sent">أُرسل</span>';
      html += '<tr><td>' + escHtml(dv.date_string || fmtDate(dv.created_at)) + '</td>' +
              '<td>' + badge + '</td>' +
              '<td>' + (dv.delivered_at ? fmtTime(dv.delivered_at) : '—') + '</td>' +
              '<td>' + (dv.read_at ? fmtTime(dv.read_at) : '—') + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // Notes
  html += '<div class="section"><h3 style="display:flex; justify-content:space-between; align-items:center">' +
          '<span>📝 ملاحظات داخلية</span>' +
          '<button class="link-btn" onclick="openEditNote()">' + (sub.internal_note ? 'تعديل' : 'إضافة') + '</button>' +
          '</h3>';
  html += '<div class="notes-box">' + (escHtml(sub.internal_note) || '<em class="muted">لا توجد ملاحظات</em>') + '</div>';
  html += '</div>';

  document.getElementById('detailRoot').innerHTML = html;
}

// --- Action handlers ---
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function openPhoneChange() {
  document.getElementById('oldPhoneDisplay').value = phone;
  document.getElementById('newPhoneInput').value = '';
  document.getElementById('phoneChangeReason').value = '';
  document.getElementById('skipVerification').checked = false;
  openModal('phoneChangeModal');
}

function updateExtendCustom() {
  const v = document.getElementById('extendDays').value;
  document.getElementById('extendCustomWrap').style.display = v === 'custom' ? 'block' : 'none';
}

async function doExtend() {
  const sel = document.getElementById('extendDays').value;
  const days = sel === 'custom' ? parseInt(document.getElementById('extendCustomDays').value) : parseInt(sel);
  const reason = document.getElementById('extendReason').value.trim();
  if (!days || days <= 0) { alert('أدخل عدد أيام صحيح'); return; }

  const r = await fetch('/admin/api/subscribers/' + phone + '/extend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, reason }),
  });
  const d = await r.json();
  if (d.success) { closeModal('extendModal'); loadDetail(); }
  else alert(d.error || 'فشل التمديد');
}

async function doChangePhone() {
  const newPhone = document.getElementById('newPhoneInput').value.trim();
  const reason = document.getElementById('phoneChangeReason').value.trim();
  const skip = document.getElementById('skipVerification').checked;
  if (!newPhone || !/^\\d{10,15}$/.test(newPhone)) { alert('الرقم غير صالح'); return; }
  if (!confirm('هل تؤكد تغيير الرقم من ' + phone + ' إلى ' + newPhone + '؟')) return;

  const r = await fetch('/admin/api/subscribers/' + phone + '/change-phone', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_phone: newPhone, reason, skip_verification: skip }),
  });
  const d = await r.json();
  if (d.success) {
    closeModal('phoneChangeModal');
    // Redirect to new phone's detail page
    location.href = '/admin/subscribers/' + newPhone;
  } else {
    alert(d.error || 'فشل تغيير الرقم');
  }
}

async function doAddPayment() {
  const amount = parseFloat(document.getElementById('paymentAmount').value);
  const method = document.getElementById('paymentMethod').value;
  const plan = document.getElementById('paymentPlan').value;
  const reference = document.getElementById('paymentReference').value.trim();
  const notes = document.getElementById('paymentNotes').value.trim();
  if (!amount || amount <= 0) { alert('المبلغ مطلوب'); return; }

  const r = await fetch('/admin/api/subscribers/' + phone + '/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_kwd: amount, method, plan, reference, notes }),
  });
  const d = await r.json();
  if (d.success) { closeModal('paymentModal'); loadDetail(); }
  else alert(d.error || 'فشل إضافة الدفعة');
}

function pickTag(t) { document.getElementById('tagInput').value = t; }

async function doAddTag() {
  const tag = document.getElementById('tagInput').value.trim();
  if (!tag) { alert('اكتب الوسم أولاً'); return; }
  const r = await fetch('/admin/api/subscribers/' + phone + '/tags', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  });
  const d = await r.json();
  if (d.success) { closeModal('tagModal'); document.getElementById('tagInput').value = ''; loadDetail(); }
  else alert(d.error || 'فشل إضافة الوسم');
}

async function removeTag(tag) {
  const t = decodeURIComponent(tag);
  if (!confirm('إزالة الوسم "' + t + '"؟')) return;
  const r = await fetch('/admin/api/subscribers/' + phone + '/tags/' + encodeURIComponent(t), { method: 'DELETE' });
  const d = await r.json();
  if (d.success) loadDetail();
}

async function doChangePlan() {
  const plan = document.getElementById('planSelect').value;
  const customDays = plan === 'gift' ? parseInt(document.getElementById('giftDays').value) : null;
  const r = await fetch('/admin/api/subscribers/' + phone + '/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, custom_days: customDays }),
  });
  const d = await r.json();
  if (d.success) { closeModal('planModal'); loadDetail(); }
  else alert(d.error || 'فشل تغيير الخطة');
}

document.getElementById('planSelect').addEventListener('change', function(e) {
  document.getElementById('giftDaysWrap').style.display = e.target.value === 'gift' ? 'block' : 'none';
});

async function setState(state) {
  const labels = { active: 'تفعيل', paused: 'تعليق', unsubscribed: 'إلغاء الاشتراك' };
  if (!confirm(labels[state] + '؟')) return;
  const r = await fetch('/admin/api/subscribers/' + phone, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const d = await r.json();
  if (d.success) loadDetail();
  else alert(d.error);
}

function openRefund(paymentId, originalAmount, alreadyRefunded) {
  const remaining = Math.max(0, originalAmount - alreadyRefunded);
  document.getElementById('refundOrigAmount').textContent = originalAmount.toFixed(3);
  document.getElementById('refundAlready').textContent = alreadyRefunded.toFixed(3);
  document.getElementById('refundAvailable').textContent = remaining.toFixed(3);
  const amountInput = document.getElementById('refundAmount');
  amountInput.value = remaining.toFixed(3);
  amountInput.max = remaining;
  document.getElementById('refundReason').value = '';
  document.getElementById('refundNotify').checked = true;

  // Show full-refund warning when amount equals or exceeds remaining
  function syncWarning() {
    const v = parseFloat(amountInput.value) || 0;
    document.getElementById('refundFullWarning').style.display =
      (v + 0.001 >= remaining) ? 'block' : 'none';
  }
  amountInput.oninput = syncWarning;
  syncWarning();

  // Stash the payment id on the modal so doRefund() knows which row to hit
  document.getElementById('refundModal').dataset.paymentId = paymentId;
  openModal('refundModal');
}

async function doRefund() {
  const modal = document.getElementById('refundModal');
  const paymentId = modal.dataset.paymentId;
  const amount = parseFloat(document.getElementById('refundAmount').value);
  const reason = document.getElementById('refundReason').value.trim();
  const notify = document.getElementById('refundNotify').checked;

  if (!Number.isFinite(amount) || amount <= 0) { alert('أدخل مبلغاً صحيحاً'); return; }
  if (!confirm('تأكيد استرداد ' + amount.toFixed(3) + ' د.ك؟ هذه العملية تنفّذ فعلياً في Ottu ولا يمكن التراجع عنها.')) return;

  const r = await fetch('/admin/api/payments/' + paymentId + '/refund', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount_kwd: amount, reason, notify }),
  });
  const d = await r.json();

  if (d.success) {
    let msg = 'تم الاسترداد بنجاح';
    if (d.subscription_terminated) msg += ' — تم تعليق الاشتراك';
    if (notify && !d.notified) msg += ' (لم يُرسل إشعار للعميل — خارج نافذة 24 ساعة)';
    alert(msg);
    closeModal('refundModal');
    loadDetail();
  } else {
    alert(d.error || 'فشل الاسترداد');
  }
}

function openEditName() {
  document.getElementById('nameInput').value = (currentSubscriber && currentSubscriber.profile_name) || '';
  openModal('nameModal');
  setTimeout(() => document.getElementById('nameInput').focus(), 50);
}

async function doSaveName() {
  // Empty string = clear the name. We send it as null so the column nulls
  // out cleanly rather than storing ''.
  const raw = document.getElementById('nameInput').value.trim();
  const r = await fetch('/admin/api/subscribers/' + phone, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: raw || null }),
  });
  const d = await r.json();
  if (d.success) { closeModal('nameModal'); loadDetail(); }
  else alert(d.error || 'فشل حفظ الاسم');
}

function openEditNote() {
  document.getElementById('noteInput').value = (currentSubscriber && currentSubscriber.internal_note) || '';
  openModal('noteModal');
  // Focus the textarea so admin can start typing immediately
  setTimeout(() => document.getElementById('noteInput').focus(), 50);
}

async function doSaveNote() {
  // Empty string = clear the note. We still send it (vs leaving as-is).
  const note = document.getElementById('noteInput').value.trim();
  const r = await fetch('/admin/api/subscribers/' + phone, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const d = await r.json();
  if (d.success) { closeModal('noteModal'); loadDetail(); }
  else alert(d.error || 'فشل حفظ الملاحظة');
}

async function doCancelIntent(sessionId) {
  if (!confirm('إلغاء رابط الدفع؟ لن يستطيع العميل استخدامه بعد ذلك.')) return;
  const r = await fetch('/admin/api/payment-intents/' + encodeURIComponent(sessionId) + '/cancel', {
    method: 'POST',
  });
  const d = await r.json();
  if (d.success) {
    loadDetail();
    return;
  }
  alert(d.error || 'فشل الإلغاء');
}

async function doResendLastEdition() {
  if (!confirm('إعادة إرسال آخر عدد إلى هذا المشترك؟ سيستخدم قالب التسليم اليومي.')) return;
  const r = await fetch('/admin/api/subscribers/' + phone + '/resend-last-edition', { method: 'POST' });
  const d = await r.json();
  if (d.success) {
    alert('تم الإرسال — العدد: ' + (d.date_string || '—'));
    loadDetail();
    return;
  }
  alert(d.error || 'فشل إعادة الإرسال');
}

async function doSendPaymentLink() {
  if (!confirm('سيتم إنشاء رابط دفع جديد عبر Ottu وإرساله للمشترك على واتساب. هل تريد المتابعة؟')) return;
  const r = await fetch('/admin/api/subscribers/' + phone + '/send-payment-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  const d = await r.json();
  if (d.success) {
    alert('تم إرسال رابط الدفع ✓');
    loadDetail();
    return;
  }
  // Partial success: link created in Ottu but WhatsApp send failed (e.g. outside 24h CSW).
  // Show the URL so admin can copy/paste manually.
  if (d.checkout_url) {
    prompt(d.error + '\\n\\nيمكنك نسخ الرابط يدوياً:', d.checkout_url);
    loadDetail();
    return;
  }
  alert(d.error || 'فشل إرسال رابط الدفع');
}

// --- Helpers ---
function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('ar', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDateRel(ts) {
  const diffH = (Date.now() - ts) / 3600000;
  if (diffH < 1) return 'منذ دقائق';
  if (diffH < 24) return 'منذ ' + Math.floor(diffH) + ' ساعة';
  const days = Math.floor(diffH / 24);
  if (days < 30) return 'منذ ' + days + ' يوم';
  return fmtDate(ts);
}
function timeUntil(ts) {
  const diffH = (ts - Date.now()) / 3600000;
  if (diffH < 1) return Math.floor(diffH * 60) + ' دقيقة';
  if (diffH < 24) return Math.floor(diffH) + ' ساعة';
  return Math.floor(diffH / 24) + ' يوم';
}
function readLabel(r) {
  if (r >= 80) return 'ممتاز';
  if (r >= 60) return 'جيد';
  if (r >= 40) return 'متوسط';
  return 'منخفض';
}
function methodLabel(m) {
  return ({ knet: 'K-Net', visa: 'بطاقة', cash: 'نقداً', bank_transfer: 'تحويل', gift: 'هدية', manual: 'يدوي', pilot: 'تجريبي' })[m] || m;
}
function eventText(type, details) {
  const m = {
    subscribed: 'اشترك للمرة الأولى',
    activated: 'تم التفعيل (' + (details.plan || '') + ')',
    paused: 'تم التعليق',
    resumed: 'تم الاستئناف',
    extended: 'تم التمديد ' + (details.days || 0) + ' يوم' + (details.reason ? ' — ' + escHtml(details.reason) : ''),
    phone_change_requested: 'طلب تغيير رقم من ' + (details.old_phone || '—'),
    phone_change_confirmed: 'تم تأكيد تغيير الرقم',
    phone_change_rejected: 'تم رفض تغيير الرقم',
    phone_change_reverted: 'تم إلغاء تغيير الرقم (' + (details.reason || '') + ')',
    payment_received: 'تم استلام دفعة ' + (details.amount_kwd || 0) + ' د.ك (' + methodLabel(details.method) + ')',
    payment_link_sent: 'تم إرسال رابط دفع جديد (Ottu)',
    payment_link_send_failed: 'فشل إرسال رابط الدفع — ' + (details.reason === 'whatsapp_send_failed' ? 'تعذّر التوصيل عبر واتساب' : details.reason === 'csw_closed_no_template' ? 'العميل خارج نافذة 24 ساعة' : 'خطأ'),
    payment_link_canceled: 'تم إلغاء رابط الدفع',
    edition_resent: 'إعادة إرسال آخر عدد' + (details.date_string ? ' (' + escHtml(details.date_string) + ')' : ''),
    payment_refunded: 'تم استرداد ' + (details.amount_kwd || 0) + ' د.ك' + (details.is_full ? ' (كامل)' : ' (جزئي)') + (details.reason ? ' — ' + escHtml(details.reason) : ''),
    renewal_interest: 'طلب تجديد الاشتراك' + (details.success ? '' : ' (فشل إرسال الرابط)'),
    plan_changed: 'تم تغيير الخطة من ' + (details.old_plan || '—') + ' إلى ' + (details.new_plan || '—'),
    reminder_sent: 'تم إرسال تذكير تجديد (' + (details.days_before || '?') + ' يوم قبل)',
    auto_paused_expired: 'تم التعليق تلقائياً (انتهاء الاشتراك)',
    cancelled: 'تم الإلغاء',
    unsubscribed: 'ألغى المشترك اشتراكه',
    tag_added: 'أُضيف وسم: ' + escHtml(details.tag || ''),
    tag_removed: 'أُزيل وسم: ' + escHtml(details.tag || ''),
  };
  return m[type] || type;
}

loadDetail();
</script>
  `;
  return pageShell('تفاصيل المشترك', 'subscribers', body);
}
