/**
 * Subscription lifecycle utilities.
 * Handles plan logic, period calculations, expiry checks, and event logging.
 *
 * Pricing model (effective launch):
 *   - yearly: 12 KWD/year (the only paid plan)
 *   - pilot: free, 1 year (for internal testing)
 *   - gift: free, custom duration (for promotions)
 *
 * Note: 'monthly' constant retained for backward compatibility with existing
 * records in the database; not offered as a new subscription option.
 */

// Plan types
export const PLAN_MONTHLY = 'monthly';  // deprecated — kept for legacy records
export const PLAN_YEARLY = 'yearly';
export const PLAN_PILOT = 'pilot';
export const PLAN_GIFT = 'gift';

// Pricing (KWD)
export const PRICING = {
  monthly: 0,      // deprecated, not offered
  yearly: 12,      // the only paid plan
  pilot: 0,
  gift: 0,
};

// Default period durations (milliseconds)
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = {
  monthly: 30 * DAY_MS,  // legacy support
  yearly: 365 * DAY_MS,
  pilot: 365 * DAY_MS,
  gift: 30 * DAY_MS,     // default; admin overrides with custom days
};

/**
 * Calculate subscription end date based on plan and start time.
 */
export function calculateEndAt(startAt, plan, customDurationDays = null) {
  if (customDurationDays !== null && customDurationDays > 0) {
    return startAt + customDurationDays * DAY_MS;
  }
  const periodMs = PERIOD_MS[plan] || PERIOD_MS.yearly;
  return startAt + periodMs;
}

/**
 * Extend an existing subscription by N days.
 * Returns the new end_at timestamp.
 */
export function extendSubscription(currentEndAt, daysToAdd) {
  const now = Date.now();
  const base = currentEndAt && currentEndAt > now ? currentEndAt : now;
  return base + daysToAdd * DAY_MS;
}

/**
 * Check if subscription is currently active (within period).
 * Pilot plan is always considered active.
 */
export function isSubscriptionActive(subscriber) {
  if (subscriber.subscription_plan === PLAN_PILOT) return true;
  if (!subscriber.subscription_end_at) return false;
  return subscriber.subscription_end_at > Date.now();
}

/**
 * Days remaining until expiry (negative if expired).
 * Returns Infinity for pilot plan.
 */
export function daysRemaining(subscriber) {
  if (subscriber.subscription_plan === PLAN_PILOT) return Infinity;
  if (!subscriber.subscription_end_at) return 0;
  const diffMs = subscriber.subscription_end_at - Date.now();
  return Math.ceil(diffMs / DAY_MS);
}

/**
 * Expiry status category for display.
 */
export function expiryStatus(subscriber) {
  if (subscriber.subscription_plan === PLAN_PILOT) return 'pilot';
  const days = daysRemaining(subscriber);
  if (days < 0) return 'expired';
  if (days <= 1) return 'critical';
  if (days <= 7) return 'warning';
  if (days <= 30) return 'ok';
  return 'good';
}

/**
 * Format days remaining for display in Arabic.
 */
export function formatDaysRemaining(days) {
  if (days === Infinity) return '∞';
  if (days < 0) return `منتهي منذ ${Math.abs(days)} يوم`;
  if (days === 0) return 'ينتهي اليوم';
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days <= 10) return `${days} أيام`;
  return `${days} يوم`;
}

/**
 * Log a subscription event to the audit trail.
 */
export async function logEvent(env, phone, eventType, details = {}, performedBy = 'admin') {
  try {
    await env.DB.prepare(
      `INSERT INTO subscription_events
        (phone, event_type, details, performed_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(phone, eventType, JSON.stringify(details), performedBy, Date.now()).run();
  } catch (err) {
    console.error('Failed to log subscription event:', err);
  }
}

/**
 * Activate a subscriber with a given plan.
 * Defaults to yearly (the only offered paid plan).
 */
export async function activateSubscriber(env, phone, plan = PLAN_YEARLY, customDays = null, performedBy = 'admin') {
  const now = Date.now();
  const endAt = calculateEndAt(now, plan, customDays);

  await env.DB.prepare(
    `UPDATE subscribers
     SET state = 'active',
         subscription_plan = ?,
         subscription_start_at = COALESCE(subscription_start_at, ?),
         subscription_end_at = ?
     WHERE phone = ?`
  ).bind(plan, now, endAt, phone).run();

  await logEvent(env, phone, 'activated', { plan, end_at: endAt, custom_days: customDays }, performedBy);
}

/**
 * Record a payment and extend subscription accordingly.
 *
 * `extras` is an optional bag of gateway-specific fields the Ottu webhook
 * passes through. Manual/admin-recorded payments leave it empty and the
 * extra columns stay NULL.
 *   - paymentDate : ms epoch — overrides the default `Date.now()` for the
 *                   payment_date column. Webhook handler passes Ottu's
 *                   `timestamp_utc` so payment_date reflects the real PG
 *                   time, not the moment our handler ran.
 *   - gateway     : e.g. 'KNET', 'Credit-Card' (Ottu's gateway_account)
 *   - pgReference : RRN / transaction_id from pg_params
 *   - cardLast4   : '1234' (NULL for KNET)
 *   - state       : 'paid' | 'refunded' | 'voided' from webhook
 */
export async function recordPayment(env, phone, amountKwd, method, reference, notes, plan = PLAN_YEARLY, performedBy = 'admin', extras = {}) {
  const now = Date.now();
  const paymentDate = extras.paymentDate || now;

  const subscriber = await env.DB.prepare(
    `SELECT * FROM subscribers WHERE phone = ?`
  ).bind(phone).first();

  if (!subscriber) throw new Error('Subscriber not found');

  const periodStart = subscriber.subscription_end_at && subscriber.subscription_end_at > now
    ? subscriber.subscription_end_at
    : now;
  const periodEnd = calculateEndAt(periodStart, plan);

  await env.DB.prepare(
    `INSERT INTO payments
      (phone, amount_kwd, payment_date, payment_method, reference, period_start, period_end,
       plan, status, notes, created_by, created_at,
       gateway, pg_reference, card_last4, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    phone, amountKwd, paymentDate, method, reference, periodStart, periodEnd,
    plan, notes, performedBy, now,
    extras.gateway || null,
    extras.pgReference || null,
    extras.cardLast4 || null,
    extras.state || null,
  ).run();

  const newPaymentCount = (subscriber.payment_count || 0) + 1;
  const newTotalPaid = (subscriber.total_paid_kwd || 0) + amountKwd;

  await env.DB.prepare(
    `UPDATE subscribers
     SET state = 'active',
         subscription_plan = ?,
         subscription_start_at = COALESCE(subscription_start_at, ?),
         subscription_end_at = ?,
         last_payment_at = ?,
         last_payment_amount_kwd = ?,
         payment_count = ?,
         total_paid_kwd = ?,
         last_reminder_sent_at = NULL,
         last_reminder_days_before = NULL
     WHERE phone = ?`
  ).bind(plan, now, periodEnd, now, amountKwd, newPaymentCount, newTotalPaid, phone).run();

  await logEvent(env, phone, 'payment_received', {
    amount_kwd: amountKwd,
    method,
    reference,
    period_end: periodEnd,
    plan,
  }, performedBy);

  return { periodStart, periodEnd };
}

/**
 * Tag helpers.
 */
export function parseTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addTag(env, phone, tag, performedBy = 'admin') {
  const sub = await env.DB.prepare(`SELECT tags FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) throw new Error('Subscriber not found');
  const tags = parseTags(sub.tags);
  if (!tags.includes(tag)) {
    tags.push(tag);
    await env.DB.prepare(`UPDATE subscribers SET tags = ? WHERE phone = ?`)
      .bind(JSON.stringify(tags), phone).run();
    await logEvent(env, phone, 'tag_added', { tag }, performedBy);
  }
  return tags;
}

export async function removeTag(env, phone, tag, performedBy = 'admin') {
  const sub = await env.DB.prepare(`SELECT tags FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub) throw new Error('Subscriber not found');
  const tags = parseTags(sub.tags).filter(t => t !== tag);
  await env.DB.prepare(`UPDATE subscribers SET tags = ? WHERE phone = ?`)
    .bind(JSON.stringify(tags), phone).run();
  await logEvent(env, phone, 'tag_removed', { tag }, performedBy);
  return tags;
}

/**
 * Previous phones list helpers.
 */
export function parsePreviousPhones(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Mask a phone number for display (e.g., +965 •••• 7054)
 */
export function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone;
  const last4 = phone.slice(-4);
  const prefix = phone.slice(0, 3);
  return `${prefix} •••• ${last4}`;
}
