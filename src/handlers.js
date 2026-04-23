/**
 * Message Handlers — business logic for incoming WhatsApp messages.
 *
 * State machine on the `subscribers` table:
 *
 *   (new number)      → state: 'new'
 *   send offer        → state: 'offered'
 *   tap 'Yes'         → state: 'yes'
 *   send payment link → state: 'awaiting_payment'
 *   payment confirmed → state: 'active' (Piece 2)
 *   reply STOP        → state: 'unsubscribed'
 *
 * For pilot (no payment), admins can manually set state to 'active' via admin panel.
 */

import { sendTextMessage, sendOfferWithButtons, sendPaymentPrompt } from './whatsapp.js';
import { messages as t } from './templates.js';

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

export async function handleStatusUpdate(status, env) {
  console.log(`Status update: ${status.id} → ${status.status}`);

  await env.DB.prepare(
    `INSERT INTO message_status (wa_message_id, status, timestamp, recipient, error_code, error_title)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    status.id,
    status.status,
    parseInt(status.timestamp, 10) * 1000,
    status.recipient_id,
    status.errors?.[0]?.code || null,
    status.errors?.[0]?.title || null,
  ).run();
}

// ----------------------------------------------------------------------------
// State handlers
// ----------------------------------------------------------------------------

async function handleFirstContact(env, phone, subscriber) {
  console.log(`Sending subscription offer to ${phone}`);
  await sendOfferWithButtons(env, phone, t.offer);
  await updateSubscriberState(env.DB, phone, 'offered');
}

async function handleOfferResponse(env, phone, subscriber, message) {
  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply) {
      const buttonId = buttonReply.id;
      if (buttonId === 'subscribe_yes') return handleYesResponse(env, phone, subscriber);
      if (buttonId === 'subscribe_no') return handleNoResponse(env, phone, subscriber);
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
  console.log(`Subscriber ${phone} said YES`);

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
  console.log(`Subscriber ${phone} said NO`);
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
  console.log(`Opt-out request from ${phone}`);

  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
     VALUES (?, ?, ?, ?)`
  ).bind(phone, 'opt_out', 'User requested opt-out via keyword', now).run();

  await env.DB.prepare(
    `UPDATE subscribers SET state = ?, unsubscribed_at = ? WHERE phone = ?`
  ).bind('unsubscribed', now, phone).run();

  await sendTextMessage(env, phone, t.optOutConfirmation);
}

// ----------------------------------------------------------------------------
// Database helpers
// ----------------------------------------------------------------------------

async function getOrCreateSubscriber(db, phone, contacts) {
  const existing = await db.prepare(
    'SELECT * FROM subscribers WHERE phone = ?'
  ).bind(phone).first();

  if (existing) return existing;

  const profileName = contacts?.[0]?.profile?.name || null;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO subscribers (phone, state, tier, profile_name, first_contact_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(phone, 'new', 'standard', profileName, now).run();

  return {
    phone, state: 'new', tier: 'standard',
    profile_name: profileName, first_contact_at: now,
  };
}

async function updateSubscriberState(db, phone, newState) {
  await db.prepare(
    'UPDATE subscribers SET state = ?, updated_at = ? WHERE phone = ?'
  ).bind(newState, Date.now(), phone).run();
}

async function logMessage(db, msg) {
  try {
    await db.prepare(
      `INSERT INTO messages (wa_message_id, phone, direction, message_type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      msg.wa_message_id, msg.phone, msg.direction,
      msg.message_type, msg.content, msg.created_at,
    ).run();
  } catch (err) {
    if (!err.message?.includes('UNIQUE constraint')) {
      console.error('Log message error:', err);
    }
  }
}

async function updateCSWWindow(db, phone, timestamp) {
  const windowOpenUntil = timestamp + 24 * 60 * 60 * 1000;
  await db.prepare(
    `UPDATE subscribers SET csw_open_until = ? WHERE phone = ?`
  ).bind(windowOpenUntil, phone).run();
}

// ----------------------------------------------------------------------------
// Keyword matching
// ----------------------------------------------------------------------------

function isOptOutKeyword(text) {
  const keywords = [
    'stop', 'unsubscribe', 'cancel',
    'إيقاف', 'ايقاف', 'الغاء', 'إلغاء', 'توقف', 'وقف',
  ];
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
