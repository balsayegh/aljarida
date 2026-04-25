/**
 * Daily cron handler — runs at 10 AM Kuwait time every day.
 *
 * Responsibilities:
 *   1. Send renewal reminders (7 days + 1 day before expiry)
 *   2. Auto-pause expired subscriptions (except pilot plans)
 *   3. Time out pending phone change verifications (>24 hours)
 *   4. Reconcile or flag stuck queue-mode broadcasts (no activity for 30m)
 *   5. Prune broadcast_recipients + message_status older than 90 days
 */

import { sendRenewalReminder } from './whatsapp_v2.js';
import { logEvent, formatDaysRemaining, PLAN_PILOT } from './subscription.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BROADCAST_RETENTION_DAYS = 90;
const STUCK_BROADCAST_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Main cron entry point. Called by Cloudflare's scheduled trigger.
 */
export async function handleScheduledTask(event, env, ctx) {
  console.log('[cron] Daily subscription check starting');

  try {
    const [reminderResult, pauseResult, phoneChangeResult, stuckResult, pruneResult] = await Promise.all([
      sendRenewalReminders(env),
      autoPauseExpired(env),
      timeoutPendingPhoneChanges(env),
      checkStuckBroadcasts(env),
      pruneOldBroadcastData(env),
    ]);

    console.log('[cron] Done.',
      'Reminders:', reminderResult,
      'Paused:', pauseResult,
      'PhoneChanges:', phoneChangeResult,
      'StuckBroadcasts:', stuckResult,
      'Pruned:', pruneResult);
  } catch (err) {
    console.error('[cron] Error:', err);
  }
}

/**
 * Find subscribers expiring in 7 or 1 days, send reminders.
 * Skip pilot plans.
 * Skip if reminder already sent for this milestone.
 */
async function sendRenewalReminders(env) {
  const now = Date.now();
  let sent7 = 0, sent1 = 0, failed = 0;

  // 7-day reminder: catch anyone expiring in the next 6-8 days who hasn't
  // already received their 7-day reminder. The ±1 day window (vs the old
  // ±12 hours) lets us recover if a single cron run is missed.
  // Idempotency is guaranteed by last_reminder_days_before != 7.
  const { results: seven } = await env.DB.prepare(
    `SELECT phone, profile_name, subscription_end_at, last_reminder_days_before, last_reminder_sent_at
     FROM subscribers
     WHERE state = 'active'
       AND subscription_plan != ?
       AND subscription_end_at IS NOT NULL
       AND subscription_end_at BETWEEN ? AND ?
       AND (last_reminder_days_before IS NULL OR last_reminder_days_before != 7
            OR last_reminder_sent_at < ?)`
  ).bind(
    PLAN_PILOT,
    now + 6 * DAY_MS,
    now + 8 * DAY_MS,
    now - 6 * DAY_MS  // allow re-send only if the last 7-day reminder was >6 days ago
  ).all();

  for (const sub of seven) {
    try {
      await sendRenewalReminder(env, sub.phone, sub.profile_name, formatDaysRemaining(7));
      await env.DB.prepare(
        `UPDATE subscribers SET last_reminder_sent_at = ?, last_reminder_days_before = 7 WHERE phone = ?`
      ).bind(now, sub.phone).run();
      await logEvent(env, sub.phone, 'reminder_sent', { days_before: 7 }, 'cron');
      sent7++;
    } catch (err) {
      console.error(`[cron] 7-day reminder failed for ${sub.phone}:`, err.message);
      failed++;
    }
  }

  // 1-day reminder: catch anyone expiring in the next 0-2 days who hasn't
  // already received their 1-day reminder. Covers missed cron runs.
  const { results: one } = await env.DB.prepare(
    `SELECT phone, profile_name, subscription_end_at, last_reminder_days_before, last_reminder_sent_at
     FROM subscribers
     WHERE state = 'active'
       AND subscription_plan != ?
       AND subscription_end_at IS NOT NULL
       AND subscription_end_at BETWEEN ? AND ?
       AND (last_reminder_days_before IS NULL OR last_reminder_days_before != 1)`
  ).bind(
    PLAN_PILOT,
    now,
    now + 2 * DAY_MS
  ).all();

  for (const sub of one) {
    try {
      await sendRenewalReminder(env, sub.phone, sub.profile_name, formatDaysRemaining(1));
      await env.DB.prepare(
        `UPDATE subscribers SET last_reminder_sent_at = ?, last_reminder_days_before = 1 WHERE phone = ?`
      ).bind(now, sub.phone).run();
      await logEvent(env, sub.phone, 'reminder_sent', { days_before: 1 }, 'cron');
      sent1++;
    } catch (err) {
      console.error(`[cron] 1-day reminder failed for ${sub.phone}:`, err.message);
      failed++;
    }
  }

  return { sent7, sent1, failed };
}

/**
 * Auto-pause subscribers whose subscription has expired.
 * Exceptions:
 *   - Pilot plans (never expire)
 *   - Already paused or unsubscribed
 */
async function autoPauseExpired(env) {
  const now = Date.now();

  const { results: expired } = await env.DB.prepare(
    `SELECT phone FROM subscribers
     WHERE state = 'active'
       AND subscription_plan != ?
       AND subscription_end_at IS NOT NULL
       AND subscription_end_at < ?`
  ).bind(PLAN_PILOT, now).all();

  let paused = 0;
  for (const sub of expired) {
    try {
      await env.DB.prepare(
        `UPDATE subscribers SET state = 'paused' WHERE phone = ?`
      ).bind(sub.phone).run();
      await logEvent(env, sub.phone, 'auto_paused_expired', {}, 'cron');
      paused++;
    } catch (err) {
      console.error(`[cron] auto-pause failed for ${sub.phone}:`, err.message);
    }
  }

  return { paused };
}

/**
 * Timeout pending phone changes after 24 hours.
 * Reverts to old phone number.
 */
async function timeoutPendingPhoneChanges(env) {
  const now = Date.now();
  let reverted = 0;

  const { results: pending } = await env.DB.prepare(
    `SELECT phone, phone_change_pending, previous_phones FROM subscribers
     WHERE phone_change_pending IS NOT NULL`
  ).all();

  for (const sub of pending) {
    try {
      const pending_data = JSON.parse(sub.phone_change_pending);
      if (pending_data.expires_at && pending_data.expires_at < now) {
        // Revert to old phone
        const oldPhone = pending_data.old_phone;
        const newPhone = sub.phone;

        // Remove the "pending" record from previous_phones since we're reverting
        let previousPhones = [];
        try {
          previousPhones = JSON.parse(sub.previous_phones || '[]');
          previousPhones = previousPhones.filter(p => p.phone !== oldPhone);
        } catch {}

        // Atomically revert all 6 tables (not just subscribers — the admin
        // phone-change moves rows in messages/consent_log/broadcast_recipients/
        // subscription_events/payments too).
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE subscribers
             SET phone = ?,
                 phone_change_pending = NULL,
                 previous_phones = ?
             WHERE phone = ?`
          ).bind(oldPhone, JSON.stringify(previousPhones), newPhone),
          env.DB.prepare(`UPDATE messages SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone),
          env.DB.prepare(`UPDATE consent_log SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone),
          env.DB.prepare(`UPDATE broadcast_recipients SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone),
          env.DB.prepare(`UPDATE subscription_events SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone),
          env.DB.prepare(`UPDATE payments SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone),
        ]);

        await logEvent(env, oldPhone, 'phone_change_reverted', {
          new_phone_attempted: newPhone,
          reason: '24_hour_timeout',
        }, 'cron');

        reverted++;
      }
    } catch (err) {
      console.error(`[cron] phone change timeout check failed:`, err.message);
    }
  }

  return { reverted };
}

/**
 * Reconcile or flag broadcasts stuck at status='in_progress'.
 *
 * Three outcomes per in-progress broadcast:
 *   - completed: every target subscriber has a recipient row → flip status
 *   - stalled:   no consumer activity for STUCK_BROADCAST_THRESHOLD_MS AND
 *                target_count not reached → flip to 'stalled' so admin sees
 *                it ended without finishing (DLQ likely contains the rest)
 *   - ongoing:   recent activity OR recently started → leave alone
 *
 * Activity = MAX(broadcast_recipients.created_at). For just-started broadcasts
 * with no recipients yet, fall back to broadcasts.started_at.
 */
async function checkStuckBroadcasts(env) {
  const now = Date.now();
  const { results: inProgress } = await env.DB.prepare(
    `SELECT id, target_count, started_at FROM broadcasts WHERE status = 'in_progress'`
  ).all();

  let completed = 0, stalled = 0, ongoing = 0;

  for (const b of inProgress) {
    try {
      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           MAX(created_at) as last_activity,
           SUM(CASE WHEN send_status = 'sent' THEN 1 ELSE 0 END) as sent,
           SUM(CASE WHEN send_status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM broadcast_recipients WHERE broadcast_id = ?`
      ).bind(b.id).first();

      const total = counts?.total || 0;
      const lastActivity = counts?.last_activity || b.started_at;

      if (total >= b.target_count) {
        await env.DB.prepare(
          `UPDATE broadcasts
           SET sent_count = ?, failed_count = ?, status = 'completed', finished_at = ?
           WHERE id = ? AND status = 'in_progress'`
        ).bind(counts.sent || 0, counts.failed || 0, now, b.id).run();
        completed++;
      } else if (now - lastActivity > STUCK_BROADCAST_THRESHOLD_MS) {
        await env.DB.prepare(
          `UPDATE broadcasts
           SET sent_count = ?, failed_count = ?, status = 'stalled', finished_at = ?
           WHERE id = ? AND status = 'in_progress'`
        ).bind(counts?.sent || 0, counts?.failed || 0, now, b.id).run();
        stalled++;
      } else {
        ongoing++;
      }
    } catch (err) {
      console.error(`[cron] stuck broadcast check failed for id=${b.id}:`, err.message);
    }
  }

  return { completed, stalled, ongoing };
}

/**
 * Prune broadcast_recipients and message_status rows older than the retention
 * window. broadcasts table is left intact so historical summaries stay
 * available; only the per-recipient detail and raw status events are dropped.
 */
async function pruneOldBroadcastData(env) {
  const cutoff = Date.now() - BROADCAST_RETENTION_DAYS * DAY_MS;

  try {
    const recipients = await env.DB.prepare(
      `DELETE FROM broadcast_recipients
       WHERE broadcast_id IN (SELECT id FROM broadcasts WHERE started_at < ?)`
    ).bind(cutoff).run();

    const statuses = await env.DB.prepare(
      `DELETE FROM message_status WHERE timestamp < ?`
    ).bind(cutoff).run();

    return {
      broadcast_recipients_deleted: recipients.meta.changes || 0,
      message_status_deleted: statuses.meta.changes || 0,
    };
  } catch (err) {
    console.error('[cron] prune failed:', err.message);
    return { error: err.message };
  }
}
