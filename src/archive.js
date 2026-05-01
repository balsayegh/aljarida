/**
 * Archive requests — paid yearly subscribers can ask for a past edition by
 * sending its date in WhatsApp. The bot parses the date, validates eligibility
 * + rate limits, HEAD-checks the PDF on aljarida.com, and resends via the
 * `aljarida_daily_delivery_ar` template (works in/out of CSW).
 *
 * Routing is in handlers.js — see handleActiveSubscriber. This module owns
 * date parsing, rate-limit checks, URL building, and the actual handler.
 */

import { sendDailyDeliveryTemplate, sendTextMessage } from './whatsapp.js';

// Rate limit knobs
const DAILY_QUOTA       = 5;
const COOLDOWN_MS       = 5 * 60 * 1000;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

const ARABIC_DIGITS_MAP = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };

/**
 * Try to extract a calendar date from arbitrary user text. Handles:
 *   - DD/MM/YYYY (or - or . or whitespace as separator)
 *   - YYYY-MM-DD
 *   - Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩)
 *
 * Returns { year, month, day } or null. Validates that the date is real
 * (no Feb 30) and not in the future.
 */
export function parseArchiveDate(text) {
  if (!text || typeof text !== 'string') return null;

  // Normalize Arabic-Indic digits → ASCII
  const ascii = text.replace(/[٠-٩]/g, d => ARABIC_DIGITS_MAP[d] || d);

  // Try YYYY-MM-DD first (less ambiguous), then DD/MM/YYYY, then DD/MM/YY.
  let m = ascii.match(/(?<!\d)(\d{4})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{1,2})(?!\d)/);
  if (m) return validate(parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10));

  m = ascii.match(/(?<!\d)(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{4})(?!\d)/);
  if (m) return validate(parseInt(m[3],10), parseInt(m[2],10), parseInt(m[1],10));

  m = ascii.match(/(?<!\d)(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{2})(?!\d)/);
  if (m) {
    const yy = parseInt(m[3],10);
    // Two-digit year heuristic — anything <= current YY+1 is 20xx, else 19xx.
    // Conservative: assume 20yy for now since this is a 2026-launch app.
    return validate(2000 + yy, parseInt(m[2],10), parseInt(m[1],10));
  }

  return null;
}

function validate(year, month, day) {
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12)    return null;
  if (day   < 1 || day   > 31)    return null;
  // Real-date sanity check (rejects Feb 30 etc.)
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  // No future dates
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return { year, month, day };
}

/**
 * Build the aljarida.com archive URL for a given date.
 * Pattern: https://www.aljarida.com/uploads/pdf/YYYY/MM/DD/aljarida-YYYYMMDD-1.pdf
 */
export function buildArchiveUrl(env, year, month, day) {
  const base = (env.ALJARIDA_PDF_BASE_URL || 'https://www.aljarida.com/uploads/pdf').replace(/\/$/, '');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${base}/${year}/${mm}/${dd}/aljarida-${year}${mm}${dd}-1.pdf`;
}

function isoDate(date) {
  return `${date.year}-${String(date.month).padStart(2,'0')}-${String(date.day).padStart(2,'0')}`;
}

/** Arabic display: "الأحد ١٨ يناير ٢٠٢٥" — used in the daily delivery template body */
function formatDateAr(date) {
  const months = ['يناير','فبراير','مارس','إبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${date.day} ${months[date.month - 1]} ${date.year}`;
}

/**
 * Check rate limits. Returns null if OK to send, or one of:
 *   'daily_limit'  — 5 successful sends in last 24h
 *   'cooldown'     — last successful send within 5 minutes
 * Only `status='sent'` rows count toward the limits.
 */
async function checkRateLimit(env, phone) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN requested_at > ? THEN 1 ELSE 0 END) AS day_count,
       MAX(requested_at) AS last_at
     FROM archive_requests
     WHERE phone = ? AND status = 'sent'`
  ).bind(now - ROLLING_WINDOW_MS, phone).first();

  const dayCount = row?.day_count || 0;
  const lastAt   = row?.last_at;

  if (dayCount >= DAILY_QUOTA) return 'daily_limit';
  if (lastAt && (now - lastAt) < COOLDOWN_MS) return 'cooldown';
  return null;
}

/**
 * Main entry point — called from handlers.js when an active subscriber's
 * text message contains a parseable date. Manages eligibility checks,
 * rate limit, archive lookup, and the WhatsApp send.
 */
export async function handleArchiveRequest(env, phone, subscriber, date) {
  const now = Date.now();
  const dateIso = isoDate(date);

  // Eligibility — paid yearly subscribers in 'active' state only
  if (subscriber?.subscription_plan !== 'yearly' || subscriber?.state !== 'active') {
    await persist(env, phone, dateIso, null, 'not_eligible', null);
    await sendTextMessage(env, phone,
      `هذه الخدمة متاحة لمشتركي الباقة السنوية فقط.\n\nللاشتراك أو التجديد، تواصل معنا.`
    );
    return;
  }

  // Rate limit
  const limit = await checkRateLimit(env, phone);
  if (limit === 'daily_limit') {
    await persist(env, phone, dateIso, null, 'rate_limited', null);
    await sendTextMessage(env, phone,
      `تجاوزت الحد اليومي للأرشيف (${DAILY_QUOTA} طلبات). أعد المحاولة بعد 24 ساعة.`
    );
    return;
  }
  if (limit === 'cooldown') {
    await persist(env, phone, dateIso, null, 'rate_limited', null);
    await sendTextMessage(env, phone,
      `يُرجى الانتظار 5 دقائق بين كل طلبين قبل طلب عدد آخر.`
    );
    return;
  }

  // Build URL + verify availability
  const pdfUrl = buildArchiveUrl(env, date.year, date.month, date.day);
  let exists = false;
  try {
    const head = await fetch(pdfUrl, { method: 'HEAD' });
    exists = head.ok;
  } catch {
    exists = false;
  }
  if (!exists) {
    await persist(env, phone, dateIso, pdfUrl, 'not_found', null);
    await sendTextMessage(env, phone,
      `عذراً، لم نجد عدد ${formatDateAr(date)} في الأرشيف. تأكد من التاريخ وحاول مرة أخرى.`
    );
    return;
  }

  // Send via daily-delivery template
  try {
    const response = await sendDailyDeliveryTemplate(env, phone, pdfUrl, formatDateAr(date));
    const wamid = response?.messages?.[0]?.id || null;
    await persist(env, phone, dateIso, pdfUrl, 'sent', wamid);
  } catch (err) {
    console.error(`[archive] send failed for ${phone} ${dateIso}:`, err);
    await persist(env, phone, dateIso, pdfUrl, 'send_failed', null);
    await sendTextMessage(env, phone,
      `تعذّر إرسال العدد. يُرجى المحاولة لاحقاً أو التواصل معنا.`
    );
  }
}

async function persist(env, phone, dateIso, pdfUrl, status, wamid) {
  try {
    await env.DB.prepare(
      `INSERT INTO archive_requests
        (phone, requested_date, pdf_url, status, requested_at, wa_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(phone, dateIso, pdfUrl, status, Date.now(), wamid).run();
  } catch (err) {
    console.error('[archive] persist failed:', err);
  }
}
