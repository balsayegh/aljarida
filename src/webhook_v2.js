/**
 * Webhook handler additions for v2.
 *
 * Handles responses to:
 *   - Phone change verification template (تأكيد / رفض buttons)
 *   - Renewal reminder template (تجديد الاشتراك / المساعدة buttons)
 *
 * These additions go INSIDE your existing handlers.js handleButtonReply()
 * function, or wherever you dispatch on button payload.
 *
 * The button payloads from the approved templates should be:
 *   - phone_change_confirm  (تأكيد button on phone change template)
 *   - phone_change_reject   (رفض button on phone change template)
 *   - renew_yes             (تجديد الاشتراك button on renewal template)
 *   - renew_help            (المساعدة button on renewal template)
 *
 * NOTE: If Meta assigned different payloads, check the approved template
 * in WhatsApp Manager and adjust the constants below.
 */

import { logEvent, parsePreviousPhones } from './subscription.js';

/**
 * Handle a quick-reply button tap from a template.
 * Called from your existing webhook handler.
 *
 * @param {Object} env - Cloudflare env
 * @param {string} phone - sender's phone
 * @param {string} buttonPayload - the button's payload string (or button title if payload empty)
 * @returns {Promise<boolean>} true if handled, false otherwise
 */
export async function handleTemplateButtonReply(env, phone, buttonPayload, buttonTitle) {
  const payload = (buttonPayload || buttonTitle || '').trim();

  // Phone change verification buttons
  if (payload === 'phone_change_confirm' || payload === 'تأكيد') {
    return handlePhoneChangeConfirm(env, phone);
  }
  if (payload === 'phone_change_reject' || payload === 'رفض') {
    return handlePhoneChangeReject(env, phone);
  }

  // Renewal reminder buttons
  if (payload === 'renew_yes' || payload === 'تجديد الاشتراك') {
    return handleRenewalYes(env, phone);
  }
  if (payload === 'renew_help' || payload === 'المساعدة') {
    return handleRenewalHelp(env, phone);
  }

  return false;  // not handled, let other button handlers try
}

/**
 * Confirm the phone change — clear pending state, subscription stays on new number.
 */
async function handlePhoneChangeConfirm(env, phone) {
  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub || !sub.phone_change_pending) return false;

  await env.DB.prepare(
    `UPDATE subscribers SET phone_change_pending = NULL WHERE phone = ?`
  ).bind(phone).run();

  await logEvent(env, phone, 'phone_change_confirmed', {}, 'subscriber');

  // Send a free-form confirmation message (CSW is open because they just replied)
  try {
    const { sendFreeformMessage } = await import('./whatsapp.js');
    await sendFreeformMessage(env, phone,
      'تم تأكيد تحديث رقم اشتراكك بنجاح ✓\n\nستصلك النسخة الرقمية من جريدة الجريدة على هذا الرقم.'
    );
  } catch (err) {
    console.error('Failed to send confirmation message:', err);
  }

  return true;
}

/**
 * Reject the phone change — revert to old phone number.
 */
async function handlePhoneChangeReject(env, phone) {
  const sub = await env.DB.prepare(`SELECT * FROM subscribers WHERE phone = ?`).bind(phone).first();
  if (!sub || !sub.phone_change_pending) return false;

  try {
    const pending = JSON.parse(sub.phone_change_pending);
    const oldPhone = pending.old_phone;
    const newPhone = phone;

    // Remove this change from previous_phones history (since we're reverting)
    let previousPhones = parsePreviousPhones(sub.previous_phones);
    previousPhones = previousPhones.filter(p => p.phone !== oldPhone || p.changed_to !== newPhone);

    // Revert: swap back to old phone and update related tables
    await env.DB.prepare(
      `UPDATE subscribers
       SET phone = ?,
           phone_change_pending = NULL,
           previous_phones = ?
       WHERE phone = ?`
    ).bind(oldPhone, JSON.stringify(previousPhones), newPhone).run();

    await env.DB.prepare(`UPDATE messages SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone).run();
    await env.DB.prepare(`UPDATE consent_log SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone).run();
    await env.DB.prepare(`UPDATE broadcast_recipients SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone).run();
    await env.DB.prepare(`UPDATE subscription_events SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone).run();
    await env.DB.prepare(`UPDATE payments SET phone = ? WHERE phone = ?`).bind(oldPhone, newPhone).run();

    await logEvent(env, oldPhone, 'phone_change_rejected', {
      new_phone_attempted: newPhone,
    }, 'subscriber');

    // Send a message to the rejecting number (new phone — CSW just opened)
    try {
      const { sendFreeformMessage } = await import('./whatsapp.js');
      await sendFreeformMessage(env, newPhone,
        'تم إلغاء طلب تحديث الرقم. إذا كنت قد طلبت هذا التحديث بالخطأ فلا مشكلة — لن يتم تغيير أي شيء.'
      );
    } catch (err) {
      console.error('Failed to send rejection confirmation:', err);
    }
  } catch (err) {
    console.error('Phone change rejection failed:', err);
    return false;
  }

  return true;
}

/**
 * Subscriber wants to renew — for pilot this is a placeholder.
 * In production with payment gateway, this would generate a payment link.
 */
async function handleRenewalYes(env, phone) {
  try {
    const { sendFreeformMessage } = await import('./whatsapp.js');
    await sendFreeformMessage(env, phone,
      'ممتاز! للتجديد:\n\n' +
      '💰 الاشتراك الشهري: 2.5 د.ك\n' +
      '📅 الاشتراك السنوي: 25 د.ك (وفّر 5 د.ك)\n\n' +
      '[رابط الدفع سيظهر هنا قريباً]\n\n' +
      'هل تحتاج مساعدة؟ فقط اكتب استفسارك.'
    );
    await logEvent(env, phone, 'renewal_interest', {}, 'subscriber');
  } catch (err) {
    console.error('Failed to send renewal info:', err);
  }
  return true;
}

/**
 * Subscriber wants help with renewal.
 */
async function handleRenewalHelp(env, phone) {
  try {
    const { sendFreeformMessage } = await import('./whatsapp.js');
    await sendFreeformMessage(env, phone,
      'نحن هنا لمساعدتك!\n\nاكتب استفسارك وسنرد عليك في أقرب وقت.'
    );
    await logEvent(env, phone, 'help_requested', { context: 'renewal' }, 'subscriber');
  } catch (err) {
    console.error('Failed to send help message:', err);
  }
  return true;
}
