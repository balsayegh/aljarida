# AlJarida Digital — WhatsApp Delivery Service

Daily newspaper delivery via WhatsApp, built on Cloudflare Workers.

## What's in this project (Piece 1 + Piece 3)

- **Webhook handler** — receives incoming WhatsApp messages, replies with subscription offer
- **Admin panel** — password-protected web page for editorial team to broadcast each day
- **Manual broadcast** — one-click send of today's PDF to all active subscribers
- **Pilot subscriber management** — add/remove subscribers for internal testing (bypass payment)
- **D1 database** — subscribers, messages, consent log, payments (placeholder)

Payment integration (Ottu/MyFatoorah) will be added later as Piece 2.

## Architecture

```
WhatsApp user ─┐
               ├─→ Meta Cloud API ──→ Cloudflare Worker ──→ D1 Database
Editorial team─┘                          │
                                          └─→ /admin panel (HTML)
```

## Quick setup

After cloning from GitHub:

```bash
npm install
npx wrangler login
```

The database is already created (`aljarida-db`, ID `58c39bb5-bc17-478d-86ba-4f2d502ff537`).

Apply schema:

```bash
npm run db:init
```

Set secrets:

```bash
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID      # 1073619532500471
npx wrangler secret put WHATSAPP_BUSINESS_ACCOUNT_ID  # 1414233037413528
npx wrangler secret put WHATSAPP_VERIFY_TOKEN         # Pick a random string
npx wrangler secret put ADMIN_PASSWORD                # Pick a strong password
```

Deploy:

```bash
npm run deploy
```

Configure webhook in Meta Business Manager:
- URL: `https://aljarida-whatsapp.YOUR-ACCOUNT.workers.dev/webhook`
- Verify token: (same as WHATSAPP_VERIFY_TOKEN above)
- Subscribe to: `messages`, `message_template_status_update`

## Using the admin panel

After deployment, visit:
```
https://aljarida-whatsapp.YOUR-ACCOUNT.workers.dev/admin
```

Log in with the ADMIN_PASSWORD. You'll see:

1. **Stats dashboard** — active subscribers, total, new today
2. **Send today's edition** — fills in today's PDF URL automatically, you add 3 headlines, click send
3. **Add pilot subscriber** — manually add a phone number as an active subscriber (for pilot testing)

### Sending a daily broadcast

1. Ensure today's PDF is uploaded to aljarida.com (existing editorial workflow)
2. Go to `/admin`
3. Verify the PDF URL shown matches today's edition
4. Fill in the date (auto-filled in Arabic) and 3 headlines
5. Click "Send to all subscribers"
6. Confirm the prompt
7. Wait for delivery report

### Saturday behavior

If you click "Send" on a Saturday (no edition normally), the panel shows a warning and asks you to confirm. You can still send if there's a special Saturday edition.

### Adding pilot subscribers

For the internal pilot, subscribers bypass the payment flow:

1. Enter phone number in E.164 without `+` (e.g., `96599123456`)
2. Optionally add a name for internal reference
3. Click "Add" — the subscriber is marked as `active` immediately
4. They'll receive the next broadcast

## Project structure

```
aljarida-whatsapp/
├── src/
│   ├── index.js        Entry point, routing
│   ├── handlers.js     Inbound message handling (subscription flow)
│   ├── whatsapp.js     WhatsApp Cloud API wrapper
│   ├── admin.js        Admin panel + broadcast endpoint
│   └── templates.js    Arabic free-form message text
├── schema.sql          D1 database schema
├── wrangler.toml       Cloudflare Workers config
├── package.json
├── .dev.vars.example   Template for local secrets
├── .gitignore
└── README.md
```

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET  | `/` | Health check | No |
| GET  | `/webhook` | Meta webhook verification | No |
| POST | `/webhook` | Incoming WhatsApp events | No |
| GET  | `/admin` | Login page or dashboard | Cookie |
| POST | `/admin/login` | Log in with password | No |
| POST | `/admin/logout` | Clear session | Cookie |
| GET  | `/admin/stats` | Subscriber counts (JSON) | Cookie |
| POST | `/admin/broadcast` | Send daily template to all active subscribers | Cookie |
| POST | `/admin/add-subscriber` | Manually add a pilot subscriber | Cookie |

## Environment variables and secrets

**Public (set in `wrangler.toml` under `[vars]`):**

| Name | Value |
|------|-------|
| `ALJARIDA_PDF_BASE_URL` | `https://www.aljarida.com/uploads/pdf` |
| `SUBSCRIPTION_PRICE_KWD` | `2.5` |
| `TIMEZONE` | `Asia/Kuwait` |

**Secrets (set via `wrangler secret put`):**

| Name | Purpose |
|------|---------|
| `WHATSAPP_ACCESS_TOKEN` | Meta permanent access token |
| `WHATSAPP_PHONE_NUMBER_ID` | `1073619532500471` |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `1414233037413528` |
| `WHATSAPP_VERIFY_TOKEN` | Random string matching webhook config in Meta |
| `ADMIN_PASSWORD` | Password for the `/admin` panel |

## Approved Meta templates

| Template Name | Used For | Notes |
|---------------|----------|-------|
| `aljarida_daily_delivery_ar` | Daily PDF broadcast | UTILITY, no buttons |
| `aljarida_welcome_paid_ar` | Payment confirmation (Piece 2) | UTILITY, no header |

## Monitoring

Live logs:
```bash
npm run tail
```

Query active subscribers:
```bash
npm run db:query "SELECT phone, state, profile_name FROM subscribers WHERE state = 'active';"
```

Recent broadcasts:
```bash
npm run db:query "SELECT phone, last_delivery_at FROM subscribers WHERE last_delivery_at IS NOT NULL ORDER BY last_delivery_at DESC LIMIT 20;"
```

## Brand identity

- **English:** AlJarida Digital
- **Arabic:** جريدة الجريدة الرقمية
- **WhatsApp display name:** جريدة الجريدة الرقمية

## What's NOT in this project yet

- Payment integration (Ottu/MyFatoorah)
- Automated subscription renewal
- Email notifications
- Bulk CSV import of pilot users

All intentionally deferred for pilot launch.
