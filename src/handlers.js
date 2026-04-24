/**
 * Message Handlers — business logic for incoming WhatsApp messages.
 *
 * v2 additions:
 *   - Phone change verification button responses (تأكيد/رفض)
 *   - Renewal reminder button responses (تجديد الاشتراك/المساعدة)
 */

import { sendTextMessage, sendOfferWithButtons, sendPaymentPrompt } from './whatsapp.js';
import { messages as t } from './templates.js';
import { handleTemplateButtonReply } from './webhook_v2.js';

export async function handleInboundMessage(message, contacts, env) {
  const from = message.from;
  const messageId = message.id;
  const timestamp = parseInt(message.timestamp, 10) * 1000;

  console.log(`Inbound message from ${from}, type: ${message.type}`);

  await logMessage(env.DB, {
    wa_message_id: messageId,
    phone: from,
    direction: 'inbound',
    message_type: message.type,
    content: JSON.stringify(message),
    created_at: timestamp,
  });

  await updateCSWWindow(env.DB, from, timestamp);

  // v2: Check for template button replies (phone change / renewal reminders)
  // These need to be checked BEFORE state-based routing because they apply
  // regardless of subscriber state.
  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply) {
      const handled = await handleTemplateButtonReply(
        env, from, buttonReply.id, buttonReply.title
      );
      if (handled) return;
    }
  }

  const subscriber = await getOrCreateSubscriber(env.DB, from, contacts);

  if (message.type === 'text') {
    const text = message.text?.body?.trim().toLowerCase() || '';
    if (isOptOutKeyword(text)) {
      return handleOptOut(env, from, subscriber);
    }
  }

  switch (subscriber.state) {
    case 'new':
      return handleFirstContact(env, from, subscriber);
    case 'offered':
      return handleOfferResponse(env, from, subscriber, message);
    case 'yes':
    case 'awaiting_payment':
      return handleReturningPayer(env, from, subscriber, message);
    case 'active':
      return handleActiveSubscriber(env, from, subscriber, message);
    case 'no':
    case 'unsubscribed':
      return handleFirstContact(env, from, subscriber);
    default:
      console.warn(`Unknown state for ${from}: ${subscriber.state}`);
      return handleFirstContact(env, from, subscriber);
  }
}

/**
 * Status updates from Meta — batched.
 *
 * A single webhook POST can carry dozens or hundreds of status events
 * (sent/delivered/read/failed). Previously each one fired its own
 * ctx.waitUntil, producing 2N parallel D1 writes. Now we collect them
 * and issue ONE env.DB.batch() — 1 subrequest per POST instead of 2N,
 * with identical write semantics.
 *
 * Idempotency is still via the UNIQUE(wa_message_id, status) index on
 * message_status — INSERT OR IGNORE dedupes on retry. The paired
 * UPDATE on broadcast_recipients is naturally idempotent (same fields
 * → same row state).
 */
export async function handleStatusUpdates(statuses, env) {
  if (!statuses.length) return;

  const stmts = [];
  for (const status of statuses) {
    const waMessageId = status.id;
    const statusType = status.status;
    const timestamp = parseInt(status.timestamp, 10) * 1000;
    const recipient = status.recipient_id;
    const errorCode = status.errors?.[0]?.code || null;
    const errorTitle = status.errors?.[0]?.title || null;

    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO message_status
          (wa_message_id, status, timestamp, recipient, error_code, error_title)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(waMessageId, statusType, timestamp, recipient, errorCode, errorTitle)
    );

    // Update broadcast_recipients if this message belongs to a broadcast.
    // Fields depend on status type, so each statement is shaped differently.
    const updateFields = { delivery_status: statusType };
    if (statusType === 'delivered') updateFields.delivered_at = timestamp;
    if (statusType === 'read') updateFields.read_at = timestamp;
    if (statusType === 'failed') updateFields.error_message = errorTitle || `Error code ${errorCode}`;

    const setClauses = Object.keys(updateFields).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updateFields);
    values.push(waMessageId);

    stmts.push(
      env.DB.prepare(
        `UPDATE broadcast_recipients SET ${setClauses} WHERE wa_message_id = ?`
      ).bind(...values)
    );
  }

  await env.DB.batch(stmts);
  console.log(`[webhook] processed ${statuses.length} status events in one batch`);
}

// ----------------------------------------------------------------------------
// State handlers
// ----------------------------------------------------------------------------

async function handleFirstContact(env, phone, subscriber) {
  await sendOfferWithButtons(env, phone, t.offer);
  await updateSubscriberState(env.DB, phone, 'offered');
}

async function handleOfferResponse(env, phone, subscriber, message) {
  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply) {
      if (buttonReply.id === 'subscribe_yes') return handleYesResponse(env, phone, subscriber);
      if (buttonReply.id === 'subscribe_no') return handleNoResponse(env, phone, subscriber);
    }
  }

  if (message.type === 'text') {
    const text = message.text?.body?.trim().toLowerCase() || '';
    if (isAffirmative(text)) return handleYesResponse(env, phone, subscriber);
    if (isNegative(text)) return handleNoResponse(env, phone, subscriber);
  }

  await sendTextMessage(env, phone, t.pleaseUseButtons);
  await sendOfferWithButtons(env, phone, t.offer);
}

async function handleYesResponse(env, phone, subscriber) {
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
     VALUES (?, ?, ?, ?)`
  ).bind(phone, 'subscription_opt_in', t.offer, now).run();

  await env.DB.prepare(
    `UPDATE subscribers SET state = ?, yes_at = ? WHERE phone = ?`
  ).bind('yes', now, phone).run();

  await sendPaymentPrompt(env, phone, t.paymentPrompt);
  await updateSubscriberState(env.DB, phone, 'awaiting_payment');
}

async function handleNoResponse(env, phone, subscriber) {
  await sendTextMessage(env, phone, t.noResponse);
  await updateSubscriberState(env.DB, phone, 'no');
}

async function handleReturningPayer(env, phone, subscriber, message) {
  await sendTextMessage(env, phone, t.paymentReminder);
  await sendPaymentPrompt(env, phone, t.paymentPrompt);
}

async function handleActiveSubscriber(env, phone, subscriber, message) {
  await sendTextMessage(env, phone, t.activeAck);
}

async function handleOptOut(env, phone, subscriber) {
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
     VALUES (?, ?, ?, ?)`
  ).bind(phone, 'opt_out', 'User requested opt-out via keyword', now).run();

  await env.DB.prepare(
    `UPDATE subscribers SET state = ?, unsubscribed_at = ? WHERE phone = ?`
  ).bind('unsubscribed', now, phone).run();

  // v2: Log event
  try {
    await env.DB.prepare(
      `INSERT INTO subscription_events (phone, event_type, details, performed_by, created_at)
       VALUES (?, 'unsubscribed', '{}', 'subscriber', ?)`
    ).bind(phone, now).run();
  } catch {}

  await sendTextMessage(env, phone, t.optOutConfirmation);
}

// ----------------------------------------------------------------------------
// DB helpers
// ----------------------------------------------------------------------------

async function getOrCreateSubscriber(db, phone, contacts) {
  const existing = await db.prepare('SELECT * FROM subscribers WHERE phone = ?').bind(phone).first();
  if (existing) return existing;

  const profileName = contacts?.[0]?.profile?.name || null;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO subscribers (phone, state, tier, profile_name, first_contact_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(phone, 'new', 'standard', profileName, now).run();

  return { phone, state: 'new', tier: 'standard', profile_name: profileName, first_contact_at: now };
}

async function updateSubscriberState(db, phone, newState) {
  await db.prepare('UPDATE subscribers SET state = ?, updated_at = ? WHERE phone = ?')
    .bind(newState, Date.now(), phone).run();
}

async function logMessage(db, msg) {
  try {
    await db.prepare(
      `INSERT INTO messages (wa_message_id, phone, direction, message_type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(msg.wa_message_id, msg.phone, msg.direction, msg.message_type, msg.content, msg.created_at).run();
  } catch (err) {
    if (!err.message?.includes('UNIQUE constraint')) {
      console.error('Log message error:', err);
    }
  }
}

async function updateCSWWindow(db, phone, timestamp) {
  const windowOpenUntil = timestamp + 24 * 60 * 60 * 1000;
  await db.prepare('UPDATE subscribers SET csw_open_until = ? WHERE phone = ?')
    .bind(windowOpenUntil, phone).run();
}

// ----------------------------------------------------------------------------
// Keyword matching
// ----------------------------------------------------------------------------

function isOptOutKeyword(text) {
  const keywords = ['stop', 'unsubscribe', 'cancel', 'إيقاف', 'ايقاف', 'الغاء', 'إلغاء', 'توقف', 'وقف'];
  return keywords.some(k => text === k || text.startsWith(k + ' '));
}

function isAffirmative(text) {
  const yesWords = ['yes', 'y', 'ok', 'نعم', 'اي', 'أي', 'ايوه', 'ايوة', 'موافق'];
  return yesWords.some(w => text === w || text.startsWith(w));
}

function isNegative(text) {
  const noWords = ['no', 'n', 'لا', 'كلا', 'مب', 'مو'];
  return noWords.some(w => text === w || text.startsWith(w));
}
