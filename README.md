# AlJarida Digital — WhatsApp Delivery Service

Daily newspaper delivery via WhatsApp, built on Cloudflare Workers.

## Features

- **Subscription flow** — inbound WhatsApp message triggers subscription offer with Yes/No buttons
- **Opt-in consent logging** — Meta compliance audit trail
- **Admin panel** — 3 pages: dashboard, subscribers, broadcasts
- **Manual broadcast** — one-click send of today's PDF to all active subscribers
- **Per-recipient delivery tracking** — sent / delivered / read / failed
- **Subscriber management** — add / pause / reactivate / unsubscribe / delete
- **Pilot mode** — manually add subscribers bypassing payment

## Admin panel pages

### `/admin` — Dashboard
- Stats overview (active, new, unsubscribed, total)
- Send today's edition form
- Last broadcast summary

### `/admin/subscribers` — Subscribers
- Filterable list (by state)
- Search by phone, name, or note
- Actions: activate, pause, unsubscribe, delete
- Manual add form for pilot subscribers

### `/admin/broadcasts` — Broadcast History
- All past broadcasts with delivery counts
- Click any row to see per-recipient details

### `/admin/broadcasts/:id` — Broadcast Detail
- Complete stats (target / sent / delivered / read / failed)
- Per-recipient delivery status
- Auto-refreshes to catch webhook status updates

## Setup

### First-time deployment

```bash
npm install
npx wrangler login
npm run db:init          # applies schema to remote D1
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID      # 1073619532500471
npx wrangler secret put WHATSAPP_BUSINESS_ACCOUNT_ID  # 1414233037413528
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npm run deploy
```

### Upgrading from Piece 3 (previous version)

If you already have the previous version deployed:

```bash
npm run db:migrate       # adds new columns and broadcast tables
npm run deploy           # deploys the new code
```

The migration file uses `IF NOT EXISTS` patterns where possible. You may see a
few "duplicate column name" errors for the ALTER TABLE statements — those are
harmless if the columns already exist.

## After deploy

Admin panel: `https://aljarida-whatsapp.YOUR-SUBDOMAIN.workers.dev/admin`

Log in with your `ADMIN_PASSWORD`.

## Endpoints reference

### Public
| Method | Path | Description |
|--------|------|-------------|
| GET  | `/` | Health check |
| GET  | `/webhook` | Meta webhook verification |
| POST | `/webhook` | Incoming WhatsApp events |

### Admin HTML pages
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin` | Dashboard |
| GET | `/admin/subscribers` | Subscriber list |
| GET | `/admin/broadcasts` | Broadcast history |
| GET | `/admin/broadcasts/:id` | Broadcast detail |

### Admin API (JSON)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/login` | Form-based login |
| POST | `/admin/logout` | Clear session |
| GET | `/admin/api/stats` | Dashboard stats |
| GET | `/admin/api/subscribers` | List subscribers (query: state, search, limit) |
| POST | `/admin/api/subscribers/add` | Add a subscriber manually |
| PATCH | `/admin/api/subscribers/:phone` | Update subscriber state/note |
| DELETE | `/admin/api/subscribers/:phone` | Delete subscriber |
| POST | `/admin/api/broadcast` | Send daily delivery to all active subscribers |
| GET | `/admin/api/broadcasts` | List all broadcasts |
| GET | `/admin/api/broadcasts/:id` | Broadcast details with per-recipient status |

## Approved Meta templates

| Template Name | Category | Used For |
|---------------|----------|----------|
| `aljarida_daily_delivery_ar` | UTILITY | Daily PDF broadcast |
| `aljarida_welcome_paid_ar` | UTILITY | Payment confirmation (Piece 2) |

## Brand identity

- **English:** AlJarida Digital
- **Arabic:** جريدة الجريدة الرقمية
- **WhatsApp display name:** جريدة الجريدة الرقمية

## Read receipts — important note

WhatsApp's "read" status is only reported when the recipient has **read
receipts enabled** in their WhatsApp settings. Many users disable this for
privacy. The admin panel shows read data where available, but don't expect
100% read reporting — 40-60% is typical.

Actual read rate is likely higher than reported.

## Subscription states

| State | Meaning |
|-------|---------|
| `new` | First-ever contact (transient) |
| `offered` | Subscription offer was sent |
| `yes` | Tapped YES on offer |
| `awaiting_payment` | Payment link sent, awaiting completion |
| `active` | Paid / receiving daily delivery |
| `paused` | Temporarily stopped (admin action) |
| `no` | Declined the offer |
| `unsubscribed` | Opted out |

## Project structure

```
aljarida-whatsapp/
├── src/
│   ├── index.js             Entry + routing
│   ├── handlers.js          Inbound message logic
│   ├── whatsapp.js          Meta Cloud API wrapper
│   ├── templates.js         Arabic free-form messages
│   ├── admin.js             Admin router + auth + API endpoints
│   ├── admin_broadcast.js   Broadcast handler (separate for clarity)
│   └── admin_pages.js       HTML page renderers
├── schema.sql               Full database schema (fresh install)
├── migrations.sql           Incremental migration (upgrade from v0.2)
├── wrangler.toml
├── package.json
├── .gitignore
├── .dev.vars.example
└── README.md
```

## Monitoring

```bash
npm run tail                 # live logs
```

Database queries:
```bash
npm run db:query "SELECT COUNT(*) FROM subscribers WHERE state = 'active';"
npm run db:query "SELECT * FROM broadcasts ORDER BY started_at DESC LIMIT 5;"
```

## Not yet built

- Payment gateway integration (Piece 2 — Ottu/MyFatoorah)
- Automated daily cron (intentionally manual per requirement)
- Bulk CSV import/export
- Scheduled broadcasts
- Email/SMS alerts for failures

## License

Proprietary — AlJarida Digital. All rights reserved.
