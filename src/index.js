/**
 * Al-Jarida WhatsApp Service — Main Worker Entry Point
 *
 * This Worker handles all HTTP requests from Meta's WhatsApp Cloud API webhook.
 * It routes requests based on method and path:
 *
 *   GET  /webhook   → webhook verification (called once by Meta during setup)
 *   POST /webhook   → incoming WhatsApp messages and status updates
 *   GET  /          → simple health check
 *
 * Future pieces will add:
 *   POST /admin/broadcast     → manual daily delivery trigger (Piece 3)
 *   POST /payment/callback    → MyFatoorah payment confirmation (Piece 2)
 */

import { handleInboundMessage, handleStatusUpdate } from './handlers.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check — useful for confirming the Worker is deployed
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('Al-Jarida WhatsApp Service is running', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Webhook verification — Meta calls this GET endpoint once during setup
    // to confirm we own the webhook URL.
    if (url.pathname === '/webhook' && request.method === 'GET') {
      return handleWebhookVerification(url, env);
    }

    // Incoming webhook events from Meta (messages, status updates)
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookEvent(request, env, ctx);
    }

    // Unknown route
    return new Response('Not found', { status: 404 });
  },
};

/**
 * Handle Meta's webhook verification challenge.
 * Meta sends a GET request with specific query parameters; we must echo back
 * the challenge value to prove we control this URL.
 */
function handleWebhookVerification(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    return new Response(challenge, { status: 200 });
  }

  console.error('Webhook verification failed');
  return new Response('Forbidden', { status: 403 });
}

/**
 * Handle incoming webhook events from Meta.
 * Meta sends a JSON payload describing the event (new message, status update, etc.).
 * We respond with 200 immediately to acknowledge receipt, then process asynchronously.
 *
 * Meta retries webhooks that don't get 200 within ~20 seconds, so we should
 * always return 200 quickly even if processing fails — otherwise we'll get
 * duplicate events.
 */
async function handleWebhookEvent(request, env, ctx) {
  try {
    const payload = await request.json();

    // Meta wraps events in entry → changes → value structure
    if (payload.object !== 'whatsapp_business_account') {
      return new Response('OK', { status: 200 });
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        // Incoming messages from subscribers
        if (value.messages) {
          for (const message of value.messages) {
            // Process asynchronously — don't block the 200 response
            ctx.waitUntil(
              handleInboundMessage(message, value.contacts, env)
                .catch(err => console.error('Message handler error:', err))
            );
          }
        }

        // Status updates for messages we sent (sent, delivered, read, failed)
        if (value.statuses) {
          for (const status of value.statuses) {
            ctx.waitUntil(
              handleStatusUpdate(status, env)
                .catch(err => console.error('Status handler error:', err))
            );
          }
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook error:', err);
    // Still return 200 to prevent Meta from retrying — we'll log and investigate
    return new Response('OK', { status: 200 });
  }
}
