/**
 * Daily cron handler — runs at 10 AM Kuwait time every day.
 *
 * Responsibilities:
 *   1. Send renewal reminders (7 days + 1 day before expiry)
 *   2. Auto-pause expired subscriptions (except pilot plans)
 *   3. Time out pending phone change verifications (>24 hours)
 */

import { sendRenewalReminder } from './whatsapp_v2.js';
import { logEvent, formatDaysRemaining, PLAN_PILOT } from './subscription.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Main cron entry point. Called by Cloudflare's scheduled trigger.
 */
export async function handleScheduledTask(event, env, ctx) {
  console.log('[cron] Daily subscription check starting');

  try {
    const [reminderResult, pauseResult, phoneChangeResult] = await Promise.all([
      sendRenewalReminders(env),
      autoPauseExpired(env),
      timeoutPendingPhoneChanges(env),
    ]);

    console.log('[cron] Done. Reminders:', reminderResult, 'Paused:', pauseResult, 'PhoneChanges:', phoneChangeResult);
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

  // Check 7-day reminders
  // A subscriber qualifies if their end_at is between 6.5 and 7.5 days from now
  // and they haven't received a 7-day reminder yet
  const sevenDaysFromNow = now + 7 * DAY_MS;
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
    sevenDaysFromNow - DAY_MS / 2,
    sevenDaysFromNow + DAY_MS / 2,
    now - 6 * DAY_MS  // avoid re-sending within 6 days
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

  // Check 1-day reminders
  const oneDayFromNow = now + DAY_MS;
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
    oneDayFromNow - DAY_MS / 2,
    oneDayFromNow + DAY_MS / 2
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

        await env.DB.prepare(
          `UPDATE subscribers
           SET phone = ?,
               phone_change_pending = NULL,
               previous_phones = ?
           WHERE phone = ?`
        ).bind(oldPhone, JSON.stringify(previousPhones), newPhone).run();

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
