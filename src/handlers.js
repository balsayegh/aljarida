/**
 * Message Handlers — business logic for incoming WhatsApp messages.
 *
 * The core flow is a state machine on the `subscribers` table:
 *
 *   (new number)      → state: 'new'
 *   send offer        → state: 'offered'
 *   tap 'Yes'         → state: 'yes' (consent captured, opt-in logged)
 *   send payment link → state: 'awaiting_payment'
 *   payment confirmed → state: 'active' (handled by payment webhook, Piece 2)
 *   reply STOP        → state: 'unsubscribed'
 *
 * Any message from a brand-new number automatically triggers the offer.
 * Once offered, we handle button taps and text replies based on current state.
 */

import { sendTextMessage, sendOfferWithButtons, sendPaymentPrompt } from './whatsapp.js';
import { messages as t } from './templates.js';

/**
 * Main entry point for incoming messages.
 * Routes based on message type and subscriber state.
 */
export async function handleInboundMessage(message, contacts, env) {
  const from = message.from; // phone number in E.164 format without '+'
  const messageId = message.id;
  const timestamp = parseInt(message.timestamp, 10) * 1000; // Meta sends epoch seconds

  console.log(`Inbound message from ${from}, type: ${message.type}`);

  // Log every inbound message for audit trail
  await logMessage(env.DB, {
    wa_message_id: messageId,
    phone: from,
    direction: 'inbound',
    message_type: message.type,
    content: JSON.stringify(message),
    created_at: timestamp,
  });

  // Update CSW window — any inbound message opens a 24-hour free-messaging window
  await updateCSWWindow(env.DB, from, timestamp);

  // Get or create subscriber record
  const subscriber = await getOrCreateSubscriber(env.DB, from, contacts);

  // Check for opt-out keywords in text messages first (highest priority)
  if (message.type === 'text') {
    const text = message.text?.body?.trim().toLowerCase() || '';
    if (isOptOutKeyword(text)) {
      return handleOptOut(env, from, subscriber);
    }
  }

  // Route based on current subscriber state
  switch (subscriber.state) {
    case 'new':
      // First-ever message from this number — send the subscription offer
      return handleFirstContact(env, from, subscriber);

    case 'offered':
      // We've sent the offer; expecting Yes/No button tap
      return handleOfferResponse(env, from, subscriber, message);

    case 'yes':
    case 'awaiting_payment':
      // Already agreed, possibly re-engaging before completing payment
      return handleReturningPayer(env, from, subscriber, message);

    case 'active':
      // Existing paid subscriber — log their message, offer support context
      return handleActiveSubscriber(env, from, subscriber, message);

    case 'no':
    case 'unsubscribed':
      // Previously declined or opted out — if they message again, re-offer
      return handleFirstContact(env, from, subscriber);

    default:
      console.warn(`Unknown state for ${from}: ${subscriber.state}`);
      return handleFirstContact(env, from, subscriber);
  }
}

/**
 * Handle status updates for messages we sent.
 * Meta reports: sent, delivered, read, failed.
 * We log these for analytics and to detect delivery problems.
 */
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

  // Send the offer with Yes/No buttons
  await sendOfferWithButtons(env, phone, t.offer);

  // Update state to 'offered'
  await updateSubscriberState(env.DB, phone, 'offered');
}

async function handleOfferResponse(env, phone, subscriber, message) {
  // Look for interactive button reply
  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    if (buttonReply) {
      const buttonId = buttonReply.id;

      if (buttonId === 'subscribe_yes') {
        return handleYesResponse(env, phone, subscriber);
      }
      if (buttonId === 'subscribe_no') {
        return handleNoResponse(env, phone, subscriber);
      }
    }
  }

  // If they typed text instead of tapping, try to interpret it
  if (message.type === 'text') {
    const text = message.text?.body?.trim().toLowerCase() || '';
    if (isAffirmative(text)) {
      return handleYesResponse(env, phone, subscriber);
    }
    if (isNegative(text)) {
      return handleNoResponse(env, phone, subscriber);
    }
  }

  // Couldn't understand — re-send the offer
  await sendTextMessage(env, phone, t.pleaseUseButtons);
  await sendOfferWithButtons(env, phone, t.offer);
}

async function handleYesResponse(env, phone, subscriber) {
  console.log(`Subscriber ${phone} said YES`);

  const now = Date.now();

  // Log the explicit consent — this is our Meta-compliance audit record
  await env.DB.prepare(
    `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
     VALUES (?, ?, ?, ?)`
  ).bind(
    phone,
    'subscription_opt_in',
    t.offer, // record exactly what they saw when they consented
    now,
  ).run();

  // Update subscriber state
  await env.DB.prepare(
    `UPDATE subscribers SET state = ?, yes_at = ? WHERE phone = ?`
  ).bind('yes', now, phone).run();

  // Send payment prompt
  // NOTE: In Piece 2, this will generate a real MyFatoorah payment URL.
  // For now, we send a placeholder message so you can test the flow.
  await sendPaymentPrompt(env, phone, t.paymentPrompt);

  // Move to awaiting_payment state
  await updateSubscriberState(env.DB, phone, 'awaiting_payment');
}

async function handleNoResponse(env, phone, subscriber) {
  console.log(`Subscriber ${phone} said NO`);
  await sendTextMessage(env, phone, t.noResponse);
  await updateSubscriberState(env.DB, phone, 'no');
}

async function handleReturningPayer(env, phone, subscriber, message) {
  // They agreed but haven't paid yet. Send the payment prompt again.
  await sendTextMessage(env, phone, t.paymentReminder);
  await sendPaymentPrompt(env, phone, t.paymentPrompt);
}

async function handleActiveSubscriber(env, phone, subscriber, message) {
  // Active subscriber messaged us — just acknowledge.
  // Later we'll route button taps from daily delivery to feedback handlers.
  await sendTextMessage(env, phone, t.activeAck);
}

async function handleOptOut(env, phone, subscriber) {
  console.log(`Opt-out request from ${phone}`);

  const now = Date.now();

  // Log the opt-out
  await env.DB.prepare(
    `INSERT INTO consent_log (phone, consent_type, consent_text, timestamp)
     VALUES (?, ?, ?, ?)`
  ).bind(phone, 'opt_out', 'User requested opt-out via keyword', now).run();

  // Update state
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

  if (existing) {
    return existing;
  }

  // Extract WhatsApp profile name if available (for internal reference only)
  const profileName = contacts?.[0]?.profile?.name || null;

  const now = Date.now();

  await db.prepare(
    `INSERT INTO subscribers (phone, state, tier, profile_name, first_contact_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(phone, 'new', 'standard', profileName, now).run();

  return {
    phone,
    state: 'new',
    tier: 'standard',
    profile_name: profileName,
    first_contact_at: now,
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
      msg.wa_message_id,
      msg.phone,
      msg.direction,
      msg.message_type,
      msg.content,
      msg.created_at,
    ).run();
  } catch (err) {
    // Likely a duplicate message_id — safe to ignore (Meta sometimes retries)
    if (!err.message?.includes('UNIQUE constraint')) {
      console.error('Log message error:', err);
    }
  }
}

async function updateCSWWindow(db, phone, timestamp) {
  // CSW stays open for 24 hours after any inbound message
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
