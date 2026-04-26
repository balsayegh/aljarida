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
