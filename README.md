# AlJarida WhatsApp Service

Daily newspaper delivery via WhatsApp for *جريدة الجريدة* النسخة الرقمية. Runs as a single Cloudflare Worker backed by a single D1 database. Solo-operator project — no CI, deploys are direct via `wrangler`.

## Stack

- **Runtime**: Cloudflare Workers (no build step — modern JS modules served as-is)
- **Storage**: Cloudflare D1 (SQLite) — `schema.sql` is the source of truth
- **Queues**: Cloudflare Queues for broadcast fan-out + DLQ
- **WhatsApp**: Meta Cloud API (templates managed in Meta Business Manager)
- **Payments**: Ottu (KNET + Credit-Card)

## Local setup (fresh clone)

```bash
npm install                # installs wrangler
npx wrangler login         # one-time, opens browser
cp .dev.vars.example .dev.vars   # then edit, fill in WhatsApp creds
```

`.dev.vars` is git-ignored and used only for `npm run dev`. Production secrets are stored via `wrangler secret put` (see "Secrets" below).

## Common commands

```bash
npm run dev                                       # local dev server (uses .dev.vars)
npm run deploy                                    # deploy to prod
npm run tail                                      # stream prod logs

# D1 (production)
npm run db:query -- "SELECT count(*) FROM subscribers"
npx wrangler d1 execute aljarida-db --remote --file=migration-foo.sql
npx wrangler d1 execute aljarida-db --remote --json --command "..."

# D1 (local)
npm run db:init:local                             # apply schema.sql to local DB
npm run db:query:local -- "SELECT 1"

# Secrets
npx wrangler secret list                          # names only, no values
npx wrangler secret put OTTU_API_KEY              # interactive, never paste in chat
```

## Project structure

```
src/
  index.js                  Worker entry — fetch, scheduled, queue dispatchers
  handlers.js               Inbound WhatsApp message routing by subscriber state
  webhook_v2.js             Template-button-reply handlers (phone change, renewal)
  whatsapp.js               Meta Cloud API wrappers (text + template senders)
  whatsapp_v2.js            Higher-level template helpers (renewal reminder, etc.)
  templates.js              Free-form Arabic message strings (reviewed copy)
  subscription.js           Plan/period math, recordPayment, addTag, etc.
  ottu.js                   Ottu API helpers — createCheckout, cancelCheckout, refundCheckout, signature
  payment.js                Ottu webhook handler + createAndSendCheckoutLink
  broadcast_queue.js        Queue producer + consumer for daily PDF broadcasts
  cron.js                   Daily 10 AM Kuwait housekeeping (reminders, auto-pause, prune, etc.)
  date_util.js              Kuwait timezone helpers
  crypto_util.js            HMAC + constant-time compare
  admin.js                  Admin auth, route registry, /admin/api/* handlers (subscriber CRUD, stats)
  admin_pages.js            HTML renderers — dashboard, login, subscribers list, broadcasts list/detail, failures, page shell + shared CSS
  admin_subscriber_detail.js  Subscriber detail page (events, payments, intents, modals)
  admin_payments.js         Global Payments page + filterable API
  admin_broadcast.js        Broadcast trigger handler
schema.sql                  Canonical DB schema (current shape)
migration-*.sql             Historical migrations applied to prod D1 in chronological order
wrangler.toml               Worker config — bindings, vars, cron, queues
```

## Secrets (production)

Set via `wrangler secret put NAME` and confirmed with `wrangler secret list`. Never committed.

| Name | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API token |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verify challenge |
| `WHATSAPP_APP_SECRET` | For inbound webhook signature verification |
| `WHATSAPP_PHONE_NUMBER_ID` | Source number ID |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA ID |
| `OTTU_API_KEY` | Ottu API key (private) |
| `OTTU_WEBHOOK_SECRET` | HMAC key for Ottu webhook signature verification |
| `ADMIN_PASSWORD` | Session-cookie HMAC signing key + bootstrap password for the very first supervisor login (used only when the `admins` table is empty). After bootstrap, login is by `admins`-table email/password; this secret stays around purely as the session-cookie signing key. |
| `XAI_API_KEY` | xAI / Grok API key for the fact-check feature (subscribers sending "تحقق: ..."). Without this set, the fact-check handler replies "الخدمة غير متاحة حالياً" and logs the request as `model_error`. |

## Database shape

`schema.sql` is the canonical reference. To inspect prod tables:

```bash
npm run db:query -- "PRAGMA table_info(payments)"
npm run db:query -- "SELECT name FROM sqlite_master WHERE type='table'"
```

## Deploys

```bash
npm run deploy
```

Wrangler bundles `src/index.js` and uploads — no build step. After deploy, version IDs are visible in the output. Rollback if needed:

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

For schema changes: write a `migration-*.sql` file, apply with `wrangler d1 execute --remote --file=...`, then update `schema.sql` to match. Never edit prod D1 by hand without committing the corresponding migration.

## Templates (Meta-approved)

WhatsApp templates live in Meta Business Manager, not in this repo. Code references them by name. Currently in use:

- `aljarida_payment_link_ar` — payment link for new subs / renewals
- `aljarida_gift_welcome_ar` — admin-added مجاني subscriber welcome
- `aljarida_renewal_reminder_ar` — 7-day and 1-day expiry reminders
- `aljarida_daily_delivery_ar` — daily PDF (header is a document, body has the date)
- `aljarida_welcome_paid_ar` — paid signup confirmation
- `aljarida_phone_change_ar` — phone change verification

Free-form (non-template) messages live in `src/templates.js` and inline in `src/payment.js` and `src/webhook_v2.js`. Free-form only delivers inside the 24h customer-service window — `createAndSendCheckoutLink` and similar helpers prefer templates first.

## Admin panel

Open `https://aljarida-whatsapp.mnakh.workers.dev/admin` and log in with email + password.

**First login (bootstrap):** when the `admins` table is empty (right after the migration), the first login uses the legacy `ADMIN_PASSWORD` as the password and seeds a supervisor row from the email you supply. After that, every login goes through the table.

**Roles:**
- **Supervisor** — full access including `Users` (admin management).
- **Billing** — subscribers, payments, refunds, send links, manual add. No broadcast trigger, no DLQ.
- **Publisher** — broadcast trigger, broadcasts history, DLQ failures. No subscriber/payment access.

**Top nav (visibility per role):**
- **Dashboard** — all roles (cards visible to everyone)
- **Subscribers** — supervisor + billing
- **Payments** — supervisor + billing
- **Broadcasts** — all roles
- **Failures** — supervisor + publisher
- **Users** — supervisor only

Admins are managed at `/admin/admins`: create with email + name + role + initial password, reset password, deactivate. Self-protection: you can't deactivate yourself or demote the last active supervisor.

## Useful endpoints

```
GET  /                          health
POST /webhook                   Meta inbound (signature verified)
GET  /webhook                   Meta verify challenge
POST /payment/webhook           Ottu payment webhook (HMAC verified)
GET  /payment/success           Customer redirect after Ottu checkout
GET  /admin                     admin dashboard
POST /admin/api/...             admin JSON APIs (auth via session cookie)
```
