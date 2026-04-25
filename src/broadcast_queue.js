/**
 * Broadcast queue producer + consumer.
 *
 * Producer: admin_broadcast.js enqueues one message per subscriber via
 *           env.BROADCAST_QUEUE.sendBatch(). Each message carries everything
 *           the consumer needs — no extra DB lookups required to send.
 *
 * Consumer: runs on every queue batch (see wrangler.toml queues.consumers).
 *           For each message:
 *             1. INSERT OR IGNORE into broadcast_recipients (idempotency claim).
 *                If the row already exists, this is a duplicate delivery of
 *                an already-processed message — ack and skip.
 *             2. Send template to Meta.
 *             3. UPDATE broadcast_recipients with send result.
 *             4. Ack. On catastrophic failure (D1 unavailable, bug), retry
 *                via queue up to max_retries, then DLQ.
 *           Retriable Meta errors (rate limit #131056, transient 5xx) throw
 *           so the queue retries with backoff. Permanent errors (bad phone,
 *           400-class) are recorded and acked.
 *
 *           After processing the batch, reconcile affected broadcasts: if
 *           all target_count recipients now have rows, mark completed.
 */

import { sendDailyDeliveryTemplate } from './whatsapp.js';

const RETRIABLE_META_ERROR_CODES = new Set([
  131026, // message undeliverable — re-evaluate
  131047, // re-engagement required (timing issue)
  131056, // pair rate limit exceeded
  130429, // too many requests (generic rate limit)
  131016, // service unavailable
]);

/**
 * Enqueue one queue message per subscriber.
 * Splits into sub-batches of 100 to stay under the queue.sendBatch() limit.
 */
export async function enqueueBroadcast(env, broadcastId, subscribers, pdfUrl, date, headlines) {
  const BATCH = 100;
  for (let i = 0; i < subscribers.length; i += BATCH) {
    const chunk = subscribers.slice(i, i + BATCH);
    await env.BROADCAST_QUEUE.sendBatch(
      chunk.map(sub => ({
        body: {
          broadcast_id: broadcastId,
          phone: sub.phone,
          pdf_url: pdfUrl,
          date,
          headlines,
        },
      }))
    );
  }
}

/**
 * Consumer entry point. Called by Cloudflare for each batch delivered
 * from the broadcast queue.
 */
export async function handleBroadcastQueue(batch, env) {
  const broadcastIdsTouched = new Set();

  for (const msg of batch.messages) {
    try {
      await processBroadcastMessage(env, msg);
      broadcastIdsTouched.add(msg.body.broadcast_id);
      msg.ack();
    } catch (err) {
      console.error(`[broadcast-queue] retriable error for ${msg.body?.phone}:`, err.message);
      msg.retry();  // counts against max_retries; after exhausted → DLQ
    }
  }

  // After draining the batch, see if any broadcast has reached target_count
  // and should be flipped to status='completed'.
  for (const bid of broadcastIdsTouched) {
    try {
      await reconcileBroadcastStatus(env, bid);
    } catch (err) {
      console.error(`[broadcast-queue] reconcile failed for broadcast ${bid}:`, err.message);
    }
  }
}

async function processBroadcastMessage(env, msg) {
  const { broadcast_id, phone, pdf_url, date, headlines } = msg.body;
  const ts = Date.now();

  // Idempotency claim: INSERT OR IGNORE returns changes=0 if the row
  // already exists, meaning this message is a duplicate delivery.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO broadcast_recipients
      (broadcast_id, phone, send_status, created_at)
     VALUES (?, ?, 'pending', ?)`
  ).bind(broadcast_id, phone, ts).run();

  if (claim.meta.changes === 0) {
    // Already processed by an earlier consumer invocation — safe to skip.
    return;
  }

  try {
    const response = await sendDailyDeliveryTemplate(env, phone, pdf_url, date, headlines);
    const waMessageId = response.messages?.[0]?.id || null;

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE broadcast_recipients
         SET send_status = 'sent', wa_message_id = ?
         WHERE broadcast_id = ? AND phone = ?`
      ).bind(waMessageId, broadcast_id, phone),
      env.DB.prepare(
        `UPDATE subscribers SET last_delivery_at = ? WHERE phone = ?`
      ).bind(ts, phone),
    ]);
  } catch (err) {
    const metaCode = extractMetaErrorCode(err.message);

    if (metaCode && RETRIABLE_META_ERROR_CODES.has(metaCode)) {
      // Undo the claim so the retry can attempt again.
      await env.DB.prepare(
        `DELETE FROM broadcast_recipients
         WHERE broadcast_id = ? AND phone = ? AND send_status = 'pending'`
      ).bind(broadcast_id, phone).run();
      throw err;  // bubble up for queue retry
    }

    // Permanent failure — record and ack.
    await env.DB.prepare(
      `UPDATE broadcast_recipients
       SET send_status = 'failed', error_message = ?
       WHERE broadcast_id = ? AND phone = ?`
    ).bind(truncate(err.message, 500), broadcast_id, phone).run();
  }
}

/**
 * Try to pull a Meta error code out of a thrown error message. The whatsapp.js
 * wrapper stringifies `result.error` into the message, so codes appear as
 * "code":NNNN inside.
 */
function extractMetaErrorCode(errMsg) {
  if (!errMsg) return null;
  const m = errMsg.match(/"code":\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * DLQ consumer. Cloudflare delivers each message that exceeded max_retries
 * on the main queue. We:
 *   1. Record the payload in broadcast_failures for admin inspection.
 *   2. Insert a recipient row with send_status='dlq' so the broadcast can
 *      reach target_count and eventually complete (with the failed slots
 *      surfaced via filter=failed in the admin UI).
 *   3. Reconcile the affected broadcast(s).
 *
 * INSERT OR IGNORE on broadcast_recipients handles the rare case where a
 * 'pending' row was somehow not deleted before DLQ — we don't want a
 * UNIQUE-constraint blowup to cause the DLQ message to retry forever.
 */
export async function handleBroadcastDlq(batch, env) {
  if (!batch.messages.length) return;

  const broadcastIdsTouched = new Set();
  const ts = Date.now();
  const stmts = [];

  for (const msg of batch.messages) {
    const body = msg.body || {};
    const broadcastId = body.broadcast_id || null;
    const phone = body.phone || 'unknown';

    stmts.push(
      env.DB.prepare(
        `INSERT INTO broadcast_failures (broadcast_id, phone, payload, failed_at)
         VALUES (?, ?, ?, ?)`
      ).bind(broadcastId, phone, JSON.stringify(body), ts)
    );

    if (broadcastId) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO broadcast_recipients
            (broadcast_id, phone, send_status, error_message, created_at)
           VALUES (?, ?, 'dlq', 'DLQ: exceeded max retries', ?)`
        ).bind(broadcastId, phone, ts)
      );
      broadcastIdsTouched.add(broadcastId);
    }
  }

  await env.DB.batch(stmts);
  for (const msg of batch.messages) msg.ack();
  console.log(`[dlq] recorded ${batch.messages.length} dead-lettered messages`);

  for (const bid of broadcastIdsTouched) {
    try {
      await reconcileBroadcastStatus(env, bid);
    } catch (err) {
      console.error(`[dlq] reconcile failed for broadcast ${bid}:`, err.message);
    }
  }
}

/**
 * If every target subscriber now has a recipient row, flip the broadcast
 * to status='completed' with final counts. The UPDATE is conditional on
 * status != 'completed' so concurrent consumers can't double-complete.
 */
async function reconcileBroadcastStatus(env, broadcastId) {
  const b = await env.DB.prepare(
    `SELECT target_count, status FROM broadcasts WHERE id = ?`
  ).bind(broadcastId).first();
  if (!b || b.status === 'completed') return;

  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM broadcast_recipients WHERE broadcast_id = ?`
  ).bind(broadcastId).first();

  if ((counts?.total || 0) >= b.target_count) {
    await env.DB.prepare(
      `UPDATE broadcasts
       SET sent_count = ?, failed_count = ?, status = 'completed', finished_at = ?
       WHERE id = ? AND status != 'completed'`
    ).bind(counts.sent || 0, counts.failed || 0, Date.now(), broadcastId).run();
  }
}
