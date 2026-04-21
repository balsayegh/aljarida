/**
 * WhatsApp Cloud API wrapper.
 *
 * All outbound messaging goes through these functions. They hide the Meta API
 * details so the rest of the code stays readable.
 *
 * API docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference
 */

const GRAPH_API_VERSION = 'v22.0';

/**
 * Send a plain text message.
 * Only works inside an open 24-hour Customer Service Window (CSW).
 * Used for replies to incoming messages.
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
 * Send the subscription offer with two reply buttons.
 * Must be sent inside the CSW (since it's a free-form interactive message,
 * not a template). All inbound messages open a 24-hour CSW, so this is fine
 * as an immediate reply.
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
          {
            type: 'reply',
            reply: { id: 'subscribe_yes', title: '✅ نعم' },
          },
          {
            type: 'reply',
            reply: { id: 'subscribe_no', title: '❌ لاحقاً' },
          },
        ],
      },
    },
  });
}

/**
 * Send payment prompt.
 * In Piece 2, this will include a real MyFatoorah payment URL.
 * For now, it sends a placeholder text so you can test the flow end-to-end.
 */
export async function sendPaymentPrompt(env, to, text) {
  // Placeholder for Piece 1 — Piece 2 will replace with real payment URL
  return sendTextMessage(env, to, text);
}

/**
 * Send a pre-approved template (for business-initiated messages outside CSW).
 * This is what the daily broadcast will use in Piece 3.
 */
export async function sendTemplate(env, to, templateName, languageCode, components) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: components || [],
    },
  });
}

/**
 * Low-level send function. All other senders route through this.
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
    throw new Error(`WhatsApp API returned ${response.status}: ${JSON.stringify(result.error)}`);
  }

  console.log(`Message sent to ${body.to}, id: ${result.messages?.[0]?.id}`);
  return result;
}
