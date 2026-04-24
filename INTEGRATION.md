/**
 * ==========================================================================
 * AlJarida Subscription Management v2 — Integration Guide
 * ==========================================================================
 *
 * This v2 update is substantial. Rather than shipping a single replacement file,
 * I'm providing modular files that integrate into your existing v3 codebase.
 *
 * HOW TO INTEGRATE:
 *
 * 1. Run migrations-v2.sql against your D1 database first
 * 2. Copy the new .js files into your src/ directory
 * 3. Apply the snippets below to your existing admin.js and index.js
 * 4. Update wrangler.toml to add the cron trigger
 * 5. Deploy
 *
 * ==========================================================================
 * STEP 1: Update wrangler.toml — ADD this block
 * ==========================================================================
 *
 * [triggers]
 * crons = ["0 7 * * *"]  # 7 AM UTC = 10 AM Kuwait time
 *
 *
 * ==========================================================================
 * STEP 2: Update src/index.js — add cron handler
 * ==========================================================================
 *
 * Add this import at the top:
 *   import { handleScheduledTask } from './cron.js';
 *
 * Add this export alongside your existing default export:
 *   export default {
 *     fetch(request, env, ctx) { ... your existing code ... },
 *     scheduled(event, env, ctx) {
 *       ctx.waitUntil(handleScheduledTask(event, env, ctx));
 *     },
 *   };
 *
 * If your index.js currently has `export default { fetch: ... }`, just add the `scheduled` key.
 *
 *
 * ==========================================================================
 * STEP 3: Update src/admin.js — add new routes
 * ==========================================================================
 *
 * Add imports:
 *   import {
 *     getSubscriberDetail, extendSubscriptionAction, changePhoneAction,
 *     addTagAction, removeTagAction, changePlanAction, addPaymentAction,
 *     getEvents, getPayments,
 *   } from './admin_api_v2.js';
 *   import { renderSubscriberDetailPage } from './admin_subscriber_detail.js';
 *
 * In your main route handler, add these routes before the 404 fallback:
 *
 *   // Subscriber detail page
 *   const detailMatch = url.pathname.match(/^\/admin\/subscribers\/([^\/]+)$/);
 *   if (detailMatch && !url.pathname.includes('/api/')) {
 *     const phone = decodeURIComponent(detailMatch[1]);
 *     return htmlResponse(renderSubscriberDetailPage(phone));
 *   }
 *
 *   // New API routes
 *   const apiDetailMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)$/);
 *   if (apiDetailMatch && request.method === 'GET') {
 *     return getSubscriberDetail(request, env, decodeURIComponent(apiDetailMatch[1]));
 *   }
 *
 *   const apiExtendMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/extend$/);
 *   if (apiExtendMatch && request.method === 'POST') {
 *     return extendSubscriptionAction(request, env, decodeURIComponent(apiExtendMatch[1]));
 *   }
 *
 *   const apiChangePhoneMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/change-phone$/);
 *   if (apiChangePhoneMatch && request.method === 'POST') {
 *     return changePhoneAction(request, env, decodeURIComponent(apiChangePhoneMatch[1]));
 *   }
 *
 *   const apiTagsMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/tags$/);
 *   if (apiTagsMatch && request.method === 'POST') {
 *     return addTagAction(request, env, decodeURIComponent(apiTagsMatch[1]));
 *   }
 *
 *   const apiTagRemoveMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/tags\/([^\/]+)$/);
 *   if (apiTagRemoveMatch && request.method === 'DELETE') {
 *     return removeTagAction(request, env,
 *       decodeURIComponent(apiTagRemoveMatch[1]),
 *       decodeURIComponent(apiTagRemoveMatch[2]));
 *   }
 *
 *   const apiPlanMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/plan$/);
 *   if (apiPlanMatch && request.method === 'POST') {
 *     return changePlanAction(request, env, decodeURIComponent(apiPlanMatch[1]));
 *   }
 *
 *   const apiPaymentsMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/payments$/);
 *   if (apiPaymentsMatch) {
 *     if (request.method === 'POST') {
 *       return addPaymentAction(request, env, decodeURIComponent(apiPaymentsMatch[1]));
 *     }
 *     if (request.method === 'GET') {
 *       return getPayments(request, env, decodeURIComponent(apiPaymentsMatch[1]));
 *     }
 *   }
 *
 *   const apiEventsMatch = url.pathname.match(/^\/admin\/api\/subscribers\/([^\/]+)\/events$/);
 *   if (apiEventsMatch && request.method === 'GET') {
 *     return getEvents(request, env, decodeURIComponent(apiEventsMatch[1]));
 *   }
 *
 *
 * ==========================================================================
 * STEP 4: Update src/admin_pages.js — export SHARED_CSS and pageShell
 * ==========================================================================
 *
 * In your existing admin_pages.js, make sure SHARED_CSS constant and
 * pageShell() function are exported (add `export` keyword if not present).
 * The detail page imports them.
 *
 * If your current code has them as local (non-exported) constants, add:
 *   export const SHARED_CSS = `...`;
 *   export function pageShell(...) { ... }
 *
 *
 * ==========================================================================
 * STEP 5: Update your broadcast query in admin_broadcast.js
 * ==========================================================================
 *
 * Change the subscriber query from:
 *   SELECT phone FROM subscribers WHERE state = 'active' ORDER BY phone
 *
 * To:
 *   SELECT phone FROM subscribers
 *   WHERE state = 'active'
 *     AND (subscription_plan = 'pilot'
 *          OR subscription_end_at IS NULL
 *          OR subscription_end_at >= unixepoch() * 1000)
 *   ORDER BY phone
 *
 * This ensures expired paying subscribers don't receive broadcasts.
 *
 *
 * ==========================================================================
 * STEP 6: Update subscribers list page to link to detail page
 * ==========================================================================
 *
 * In admin_pages.js renderSubscribersPage(), add a "View" button or make
 * the phone number a link to /admin/subscribers/{phone}.
 *
 * Suggested replacement in the renderActions function or the phone cell:
 *   '<td class="phone"><a href="/admin/subscribers/' + encodeURIComponent(s.phone) + '">' + s.phone + '</a></td>'
 *
 * ==========================================================================
 */

// This file is documentation only — no code to execute.
export {};
