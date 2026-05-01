/**
 * AlJarida Digital WhatsApp Service — Worker entry point
 */

import { handleInboundMessage, handleStatusUpdates } from './handlers.js';
import { handleAdminRequest } from './admin.js';
import { handleScheduledTask, handleScheduledBroadcastsTick } from './cron.js';
import { timingSafeEqual, verifyMetaSignature } from './crypto_util.js';
import { handleBroadcastQueue, handleBroadcastDlq } from './broadcast_queue.js';
import { handleOttuWebhook, handlePaymentSuccess } from './payment.js';

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

    if (url.pathname === '/payment/webhook' && request.method === 'POST') {
      return handleOttuWebhook(request, env, ctx);
    }

    if (url.pathname === '/payment/success' && request.method === 'GET') {
      return handlePaymentSuccess(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  /**
   * Scheduled handler — called by Cloudflare Cron Triggers. Two cron
   * expressions live in wrangler.toml; we dispatch by event.cron so each
   * gets its own task without one fighting the other.
   *
   *   "0 7 * * *"   → daily housekeeping (10 AM Kuwait)
   *   "*\/5 * * * *" → scheduled-broadcast scheduler (every 5 minutes)
   */
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(handleScheduledBroadcastsTick(env, ctx));
      return;
    }
    // Default: daily housekeeping. Includes the legacy "0 7 * * *" plus
    // any future single-shot cron we don't explicitly route.
    ctx.waitUntil(handleScheduledTask(event, env, ctx));
  },

  /**
   * Queue consumer — dispatches by queue name so we can add more queues later.
   */
  async queue(batch, env, ctx) {
    if (batch.queue === 'aljarida-broadcast-sends') {
      return handleBroadcastQueue(batch, env);
    }
    if (batch.queue === 'aljarida-broadcast-dlq') {
      return handleBroadcastDlq(batch, env);
    }
    console.warn(`[queue] unknown queue: ${batch.queue}`);
  },
};

function handleWebhookVerification(url, env) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && timingSafeEqual(token || '', env.WHATSAPP_VERIFY_TOKEN || '')) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

async function handleWebhookEvent(request, env, ctx) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');

    if (!(await verifyMetaSignature(rawBody, signature, env.WHATSAPP_APP_SECRET))) {
      console.warn('Webhook signature verification failed');
      return new Response('Forbidden', { status: 403 });
    }

    const payload = JSON.parse(rawBody);
    if (payload.object !== 'whatsapp_business_account') {
      return new Response('OK', { status: 200 });
    }

    // Collect statuses across all entries/changes so we can batch the D1
    // writes into a single transaction (see handleStatusUpdates).
    const allStatuses = [];

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
          allStatuses.push(...value.statuses);
        }
      }
    }

    if (allStatuses.length > 0) {
      ctx.waitUntil(
        handleStatusUpdates(allStatuses, env)
          .catch(err => console.error('Status batch handler error:', err))
      );
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('OK', { status: 200 });
  }
}
