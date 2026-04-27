/**
 * WhatsApp Cloud API wrapper.
 */

export const GRAPH_API_VERSION = 'v22.0';

export async function sendTextMessage(env, to, text) {
  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

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
 * Send daily delivery template — the approved aljarida_daily_delivery_ar.
 */
export async function sendDailyDeliveryTemplate(env, to, pdfUrl, dateString) {
  // Extract the YYYYMMDD slug from the PDF URL (e.g. aljarida-20260426-1.pdf).
  // dateString here is the Arabic display string ("الأحد 26 إبريل 2026") which
  // has no month digits, so stripping non-digits would yield a malformed
  // "aljarida-262026.pdf". The URL is the reliable source of the numeric date.
  const slugMatch = pdfUrl.match(/aljarida-(\d{8})/);
  const filename = slugMatch ? `aljarida-${slugMatch[1]}.pdf` : 'aljarida.pdf';

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
                filename,
              },
            },
          ],
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: dateString },
          ],
        },
      ],
    },
  });
}

/**
 * Send the payment-link template message. Works inside or outside the 24h
 * customer-service window — that's the whole point of this template.
 *
 * Template name comes from env.WHATSAPP_PAYMENT_TEMPLATE_NAME (typically
 * `aljarida_payment_link_ar`). The template is configured in Meta with:
 *   - Body: 2 variables — {{1}} customer name, {{2}} amount in KWD
 *   - URL button: dynamic suffix to the static checkout URL prefix
 *     (e.g. https://pay.aljarida.com/b/checkout/redirect/start/?session_id={{1}})
 * The button parameter we pass is JUST the session_id (the suffix), not the
 * full URL.
 */
export async function sendPaymentLinkTemplate(env, to, customerName, amountKwd, sessionId) {
  const name = env.WHATSAPP_PAYMENT_TEMPLATE_NAME;
  if (!name) throw new Error('WHATSAPP_PAYMENT_TEMPLATE_NAME not set');

  return sendMessage(env, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: 'ar' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'عميلنا' },
            { type: 'text', text: Number(amountKwd).toFixed(3) },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            { type: 'text', text: sessionId },
          ],
        },
      ],
    },
  });
}

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
          parameters: [{ type: 'text', text: renewalDate }],
        },
      ],
    },
  });
}

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

  return result;
}
