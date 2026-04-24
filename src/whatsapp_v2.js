/**
 * WhatsApp template senders — v2 additions.
 * Includes renewal reminders and phone change verification.
 *
 * IMPORTANT: This file should be added alongside your existing whatsapp.js,
 * OR the functions here should be merged into whatsapp.js.
 * For clarity, this is a separate module that imports the shared send function.
 */

const WHATSAPP_API_VERSION = 'v25.0';

/**
 * Low-level template send helper.
 * (Same pattern as existing whatsapp.js; reuse that function if preferred.)
 */
async function sendTemplate(env, to, templateName, components = []) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'ar' },
      components,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    const errMsg = data.error?.message || JSON.stringify(data);
    throw new Error(`WhatsApp API ${response.status}: ${errMsg}`);
  }
  return data;
}

/**
 * Send renewal reminder template.
 *
 * Template: aljarida_renewal_reminder_ar
 * Category: MARKETING
 * Variables:
 *   {{1}} = subscriber name (or 'المشترك الكريم' if no name)
 *   {{2}} = time remaining string (e.g., '7 أيام', 'يوم واحد', 'اليوم')
 * Buttons (quick reply):
 *   - تجديد الاشتراك (payload: renew_yes)
 *   - المساعدة (payload: renew_help)
 */
export async function sendRenewalReminder(env, phone, name, timeRemainingText) {
  const displayName = name && name.trim() ? name.trim() : 'المشترك الكريم';

  return sendTemplate(env, phone, 'aljarida_renewal_reminder_ar', [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: displayName },
        { type: 'text', text: timeRemainingText },
      ],
    },
  ]);
}

/**
 * Send phone change verification template.
 *
 * Template: aljarida_phone_change_verification_ar
 * Category: UTILITY
 * Variables:
 *   {{1}} = old phone number (masked, e.g., '+965 •••• 7054')
 * Buttons (quick reply):
 *   - تأكيد (payload: phone_change_confirm)
 *   - رفض (payload: phone_change_reject)
 *
 * Sent to the NEW phone number to verify the change is legitimate.
 */
export async function sendPhoneChangeVerification(env, newPhone, oldPhoneMasked) {
  return sendTemplate(env, newPhone, 'aljarida_phone_change_verification_ar', [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: oldPhoneMasked },
      ],
    },
  ]);
}
