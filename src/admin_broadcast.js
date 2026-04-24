/**
 * Broadcast handler — sends the daily delivery template to all active subscribers.
 *
 * Date logic: Aljarida.com publishes tomorrow's edition the previous evening
 * (typically after 8 PM Kuwait time). Admin panel defaults to next publishing day
 * but admin can override both the date and the PDF URL for special cases.
 *
 * v2: Subscribers with expired subscriptions are automatically excluded
 *     (except pilot plan which never expires).
 */

import { sendDailyDeliveryTemplate } from './whatsapp.js';
import { jsonResponse } from './admin.js';

export async function handleBroadcast(request, env, ctx) {
  try {
    const { date, headlines, override, customPdfUrl, targetDateOverride } = await request.json();

    if (!date || !headlines || headlines.length !== 3 ||
        !headlines[0] || !headlines[1] || !headlines[2]) {
      return jsonResponse({ error: 'Missing date or 3 headlines' }, 400);
    }

    // Determine the PDF URL:
    //   1. If admin provided customPdfUrl → use it verbatim
    //   2. Otherwise, build from targetDateOverride or next publishing day
    let pdfUrl;
    let targetDate;

    if (customPdfUrl && customPdfUrl.trim()) {
      pdfUrl = customPdfUrl.trim();

      if (!pdfUrl.startsWith('https://') && !pdfUrl.startsWith('http://')) {
        return jsonResponse({ error: 'Custom URL must start with https:// or http://' }, 400);
      }

      if (targetDateOverride) {
        targetDate = new Date(targetDateOverride + 'T12:00:00+03:00');
      } else {
        targetDate = getNextPublishingDate();
      }
    } else {
      if (targetDateOverride) {
        targetDate = new Date(targetDateOverride + 'T12:00:00+03:00');
      } else {
        targetDate = getNextPublishingDate();
      }

      const year = targetDate.getFullYear();
      const month = String(targetDate.getMonth() + 1).padStart(2, '0');
      const day = String(targetDate.getDate()).padStart(2, '0');
      const dateSlug = `${year}${month}${day}`;
      pdfUrl = `${env.ALJARIDA_PDF_BASE_URL}/${year}/${month}/${day}/aljarida-${dateSlug}-1.pdf`;
    }

    // Saturday warning
    if (targetDate.getDay() === 6 && !override) {
      return jsonResponse({
        error: 'The target edition date is Saturday — Al-Jarida typically does not publish on Saturdays',
        warning: 'saturday',
        pdfUrl,
      }, 400);
    }

    // Verify PDF is accessible
    try {
      const headResp = await fetch(pdfUrl, { method: 'HEAD' });
      if (!headResp.ok) {
        return jsonResponse({
          error: `PDF not found at ${pdfUrl}. Status: ${headResp.status}. The edition may not be published yet, or the URL is incorrect.`,
          status: headResp.status,
          pdfUrl,
        }, 400);
      }

      const contentType = headResp.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('pdf')) {
        console.warn(`Content-Type is ${contentType}, not PDF. Proceeding anyway.`);
      }
    } catch (err) {
      return jsonResponse({ error: `Could not reach PDF URL: ${err.message}`, pdfUrl }, 400);
    }

    // v2: Only send to active subscribers whose subscription hasn't expired
    // Pilot plan is excluded from expiry check
    const now = Date.now();
    const { results: subscribers } = await env.DB.prepare(
      `SELECT phone FROM subscribers
       WHERE state = 'active'
         AND (subscription_plan = 'pilot'
              OR subscription_end_at IS NULL
              OR subscription_end_at >= ?)
       ORDER BY phone`
    ).bind(now).all();

    if (subscribers.length === 0) {
      return jsonResponse({ error: 'No active subscribers (all may be expired)', count: 0 }, 400);
    }

    const broadcastResult = await env.DB.prepare(
      `INSERT INTO broadcasts
        (date_string, pdf_url, headline_1, headline_2, headline_3, target_count, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)`
    ).bind(date, pdfUrl, headlines[0], headlines[1], headlines[2], subscribers.length, now).run();

    const broadcastId = broadcastResult.meta.last_row_id;

    let sentCount = 0;
    let failedCount = 0;

    for (const sub of subscribers) {
      try {
        const response = await sendDailyDeliveryTemplate(env, sub.phone, pdfUrl, date, headlines);
        const waMessageId = response.messages?.[0]?.id || null;

        await env.DB.prepare(
          `INSERT INTO broadcast_recipients
            (broadcast_id, phone, wa_message_id, send_status, created_at)
           VALUES (?, ?, ?, 'sent', ?)`
        ).bind(broadcastId, sub.phone, waMessageId, Date.now()).run();

        await env.DB.prepare(
          `UPDATE subscribers SET last_delivery_at = ? WHERE phone = ?`
        ).bind(Date.now(), sub.phone).run();

        sentCount++;
      } catch (err) {
        console.error(`Failed to send to ${sub.phone}:`, err.message);

        await env.DB.prepare(
          `INSERT INTO broadcast_recipients
            (broadcast_id, phone, send_status, error_message, created_at)
           VALUES (?, ?, 'failed', ?, ?)`
        ).bind(broadcastId, sub.phone, err.message, Date.now()).run();

        failedCount++;
      }
    }

    await env.DB.prepare(
      `UPDATE broadcasts
       SET sent_count = ?, failed_count = ?, status = 'completed', finished_at = ?
       WHERE id = ?`
    ).bind(sentCount, failedCount, Date.now(), broadcastId).run();

    return jsonResponse({
      success: true,
      broadcast_id: broadcastId,
      total: subscribers.length,
      sent: sentCount,
      failed: failedCount,
      pdfUrl,
    });
  } catch (err) {
    console.error('Broadcast error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

function getNextPublishingDate() {
  const kuwait = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
  const target = new Date(kuwait);
  target.setDate(target.getDate() + 1);

  if (target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}
