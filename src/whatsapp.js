/**
 * WhatsApp Cloud API wrapper.
 * All outbound messaging goes through these functions.
 */

const GRAPH_API_VERSION = 'v22.0';

/**
 * Send a plain text message (inside 24-hour CSW only).
 */
export async function sendTextMessage(env, to, text) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

/**
 * Send subscription offer with Yes/No buttons (inside CSW).
 */
export async function sendOfferWithButtons(env, to, bodyText) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'subscribe_yes', title: '✅ نعم' } },
          { type: 'reply', reply: { id: 'subscribe_no', title: '❌ لاحقاً' } },
        ],
      },
    },
  });
}

/**
 * Send payment prompt. Placeholder for Piece 2 (payment integration).
 */
export async function sendPaymentPrompt(env, to, text) {
  return sendTextMessage(env, to, text);
}

/**
 * Send the daily delivery template with PDF attachment.
 *
 * Uses the approved template: aljarida_daily_delivery_ar
 * - Header: DOCUMENT (PDF URL)
 * - Body: date + 3 headlines
 * - Footer: opt-out instruction
 */
export async function sendDailyDeliveryTemplate(env, to, pdfUrl, dateString, headlines) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'aljarida_daily_delivery_ar',
      language: { code: 'ar' },
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'document',
              document: {
                link: pdfUrl,
                filename: `aljarida-${dateString.replace(/[^0-9]/g, '')}.pdf`,
              },
            },
          ],
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: dateString },
            { type: 'text', text: headlines[0] || '' },
            { type: 'text', text: headlines[1] || '' },
            { type: 'text', text: headlines[2] || '' },
          ],
        },
      ],
    },
  });
}

/**
 * Send welcome-after-payment template (used by Piece 2 when payment webhook fires).
 */
export async function sendWelcomePaidTemplate(env, to, renewalDate) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'aljarida_welcome_paid_ar',
      language: { code: 'ar' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: renewalDate },
          ],
        },
      ],
    },
  });
}

/**
 * Low-level send function.
 */
async function sendMessage(env, body) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error('WhatsApp API error:', JSON.stringify(result));
    throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(result.error)}`);
  }

  console.log(`Message sent to ${body.to}, id: ${result.messages?.[0]?.id}`);
  return result;
}
