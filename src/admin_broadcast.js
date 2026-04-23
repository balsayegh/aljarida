/**
 * Broadcast handler — sends the daily delivery template to all active subscribers
 * and records everything in the broadcasts + broadcast_recipients tables.
 */

import { sendDailyDeliveryTemplate } from './whatsapp.js';
import { jsonResponse } from './admin.js';

export async function handleBroadcast(request, env, ctx) {
  try {
    const { date, headlines, override } = await request.json();

    if (!date || !headlines || headlines.length !== 3 ||
        !headlines[0] || !headlines[1] || !headlines[2]) {
      return jsonResponse({ error: 'Missing date or 3 headlines' }, 400);
    }

    // Construct today's PDF URL from Kuwait date
    const kuwaitNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait' }));
    const year = kuwaitNow.getFullYear();
    const month = String(kuwaitNow.getMonth() + 1).padStart(2, '0');
    const day = String(kuwaitNow.getDate()).padStart(2, '0');
    const dateSlug = `${year}${month}${day}`;
    const pdfUrl = `${env.ALJARIDA_PDF_BASE_URL}/${year}/${month}/${day}/aljarida-${dateSlug}-1.pdf`;

    // Saturday warning
    const dayOfWeek = kuwaitNow.getDay();
    if (dayOfWeek === 6 && !override) {
      return jsonResponse({
        error: 'Today is Saturday — no edition normally published',
        warning: 'saturday',
        pdfUrl,
      }, 400);
    }

    // Verify PDF is accessible
    try {
      const headResp = await fetch(pdfUrl, { method: 'HEAD' });
      if (!headResp.ok) {
        return jsonResponse({
          error: `PDF not found at ${pdfUrl}`,
          status: headResp.status,
        }, 400);
      }
    } catch (err) {
      return jsonResponse({ error: `Could not reach PDF URL: ${err.message}` }, 400);
    }

    // Get all active subscribers
    const { results: subscribers } = await env.DB.prepare(
      `SELECT phone FROM subscribers WHERE state = 'active' ORDER BY phone`
    ).all();

    if (subscribers.length === 0) {
      return jsonResponse({ error: 'No active subscribers', count: 0 }, 400);
    }

    // Create broadcast record
    const now = Date.now();
    const broadcastResult = await env.DB.prepare(
      `INSERT INTO broadcasts
        (date_string, pdf_url, headline_1, headline_2, headline_3, target_count, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)`
    ).bind(date, pdfUrl, headlines[0], headlines[1], headlines[2], subscribers.length, now).run();

    const broadcastId = broadcastResult.meta.last_row_id;

    // Send to all subscribers (sequential for pilot scale)
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

    // Finalize broadcast record
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
