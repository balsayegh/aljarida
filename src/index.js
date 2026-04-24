/**
 * AlJarida Digital WhatsApp Service — Worker entry point
 */

import { handleInboundMessage, handleStatusUpdate } from './handlers.js';
import { handleAdminRequest } from './admin.js';
import { handleScheduledTask } from './cron.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('AlJarida Digital WhatsApp Service is running', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    if (url.pathname === '/webhook' && request.method === 'GET') {
      return handleWebhookVerification(url, env);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookEvent(request, env, ctx);
    }

    if (url.pathname.startsWith('/admin')) {
      return handleAdminRequest(request, env, ctx, url);
    }

    return new Response('Not found', { status: 404 });
  },

  /**
   * Scheduled handler — called by Cloudflare Cron Triggers.
   * Runs daily at 10 AM Kuwait time (7 AM UTC) per wrangler.toml.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledTask(event, env, ctx));
  },
};

function handleWebhookVerification(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

async function handleWebhookEvent(request, env, ctx) {
  try {
    const payload = await request.json();
    if (payload.object !== 'whatsapp_business_account') {
      return new Response('OK', { status: 200 });
    }

    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        if (value.messages) {
          for (const message of value.messages) {
            ctx.waitUntil(
              handleInboundMessage(message, value.contacts, env)
                .catch(err => console.error('Message handler error:', err))
            );
          }
        }

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
    return new Response('OK', { status: 200 });
  }
}
