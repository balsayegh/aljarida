# Al-Jarida WhatsApp Service

Daily newspaper delivery to subscribers via WhatsApp.

## What this is

A Cloudflare Worker that:

- Receives inbound WhatsApp messages from prospective subscribers
- Automatically replies with a subscription offer and Yes/No buttons
- Handles opt-in consent (required by Meta's WhatsApp Business Policy)
- Logs every interaction to a Cloudflare D1 database for audit purposes
- (Future) Generates payment links via MyFatoorah
- (Future) Broadcasts the daily PDF to all active subscribers

This is **Piece 1** of the project. It establishes the foundation — inbound message handling, opt-in flow, and the database. Payment integration (Piece 2) and daily broadcast (Piece 3) will build on this.

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌────────────────┐
│  WhatsApp user  │─────▶│  Meta Cloud API  │─────▶│  This Worker   │
└─────────────────┘      └──────────────────┘      └────────┬───────┘
                                                            │
                                                            ▼
                                                   ┌────────────────┐
                                                   │  Cloudflare D1 │
                                                   │   (database)   │
                                                   └────────────────┘
```

## Prerequisites

Before you can deploy, you need:

1. **A Cloudflare account** (free sign-up at [cloudflare.com](https://cloudflare.com))
2. **Node.js 20+** installed on your laptop
3. **A WhatsApp Business Account** with:
   - An approved phone number
   - A permanent access token (never use temporary tokens in production)
   - Phone Number ID and WhatsApp Business Account ID
4. **Git** installed (for pushing to GitHub)

## First-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Log into Cloudflare

```bash
npx wrangler login
```

This opens your browser for a one-time login. Wrangler stores credentials locally.

### 3. Create the D1 database

```bash
npm run db:create
```

This prints output like:

```
✅ Successfully created DB 'aljarida-db'

[[d1_databases]]
binding = "DB"
database_name = "aljarida-db"
database_id = "abc123def-4567-..."
```

**Copy the `database_id` value** and paste it into `wrangler.toml`, replacing the `REPLACE_WITH_DATABASE_ID_FROM_WRANGLER_D1_CREATE_OUTPUT` placeholder.

### 4. Apply the database schema

```bash
npm run db:init
```

This creates all the tables. Expected output: `Executed X commands in Y.Yms`.

### 5. Configure your secrets

For **production** deployment, store secrets using Wrangler:

```bash
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_BUSINESS_ACCOUNT_ID
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
```

For each, Wrangler will prompt you to paste the value. These are encrypted and stored in Cloudflare — never committed to git.

For **local development**, copy `.dev.vars.example` to `.dev.vars` and fill in the values there:

```bash
cp .dev.vars.example .dev.vars
# Then edit .dev.vars with your credentials
```

The `.dev.vars` file is git-ignored, so it's safe to put real values there.

### 6. Pick your webhook verify token

The `WHATSAPP_VERIFY_TOKEN` is a random string you choose. It's used once by Meta to verify you control the webhook URL. Pick something long and unique, e.g.:

```
aljarida_whatsapp_webhook_verify_2026_kuwait_xyz789abc
```

You'll enter the exact same value in Meta Business Manager when configuring the webhook (see below). If they don't match, the webhook won't verify.

### 7. Deploy

```bash
npm run deploy
```

Wrangler will deploy your Worker and print its URL, e.g.:

```
Deployed aljarida-whatsapp.your-account.workers.dev
```

**Copy this URL — you'll need it for the next step.**

### 8. Configure the webhook in Meta Business Manager

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Select your WhatsApp app → **WhatsApp** → **Configuration**
3. Under **Webhook**, click **Edit**
4. **Callback URL**: `https://aljarida-whatsapp.your-account.workers.dev/webhook`
5. **Verify token**: (the exact value you set for `WHATSAPP_VERIFY_TOKEN`)
6. Click **Verify and save**
7. Subscribe to these webhook fields:
   - `messages`
   - `message_template_status_update` (for Piece 3)

If verification fails, double-check the token matches exactly (no whitespace).

### 9. Test with your own phone

Send a WhatsApp message — any text — to your business number. Within a second or two, you should receive the subscription offer with Yes/No buttons.

Tap **نعم** (Yes). You should receive the payment prompt (placeholder for now; real MyFatoorah integration comes in Piece 2).

## Local development

To run the Worker locally on your laptop:

```bash
npm run dev
```

This starts a local server, typically at `http://localhost:8787`. Use **ngrok** or **Cloudflare Tunnel** to expose it to the internet so Meta can reach it:

```bash
# In another terminal:
ngrok http 8787
# Then use the ngrok HTTPS URL as your webhook in Meta Business Manager
```

Local D1 is separate from production D1. Initialize it once:

```bash
npm run db:init:local
```

## Monitoring

### Live logs

See real-time logs from your deployed Worker:

```bash
npm run tail
```

This streams every request the Worker receives, including webhook calls from Meta.

### Query the database

Check subscribers:

```bash
npm run db:query "SELECT phone, state, first_contact_at FROM subscribers ORDER BY first_contact_at DESC LIMIT 20;"
```

Check recent messages:

```bash
npm run db:query "SELECT phone, direction, message_type, created_at FROM messages ORDER BY created_at DESC LIMIT 20;"
```

Check opt-ins:

```bash
npm run db:query "SELECT phone, consent_type, timestamp FROM consent_log ORDER BY timestamp DESC LIMIT 20;"
```

## What's next

This is Piece 1. Upcoming pieces:

- **Piece 2** — MyFatoorah payment integration
  - Generate payment links per subscriber
  - Handle payment webhook to activate subscription
  - Send welcome message after payment
  - Track subscription expiry/renewal

- **Piece 3** — Admin panel + daily broadcast
  - Login-protected admin page at `/admin`
  - Submit daily template to Meta
  - Broadcast the day's PDF to all active subscribers with one click
  - Live delivery progress tracking

- **Piece 4** — Pilot onboarding tools
  - Bulk add pilot subscribers (skip payment for staff/testing)
  - Pilot feedback collection
  - Simple reporting dashboard

## Troubleshooting

**Webhook verification fails:** The verify token in Meta Business Manager must exactly match your `WHATSAPP_VERIFY_TOKEN` secret. Copy-paste carefully (no trailing spaces).

**Worker returns 500:** Check live logs with `npm run tail`. Most common causes: missing secret, malformed D1 query, Meta API error.

**Messages not sending:** Check that:
- The access token is permanent (not temporary — temporary tokens expire after 24 hours)
- The phone number is approved and verified in Meta Business Manager
- The target phone has opted in (for templates) or has an open CSW (for free-form messages)

**Inbound messages not arriving:** Check that your webhook is subscribed to the `messages` field in Meta Business Manager.

## Project structure

```
aljarida-whatsapp/
├── src/
│   ├── index.js        # Worker entry point and routing
│   ├── handlers.js     # Business logic (state machine)
│   ├── whatsapp.js     # Meta Cloud API wrapper
│   └── templates.js    # Arabic message templates
├── schema.sql          # D1 database schema
├── wrangler.toml       # Cloudflare Workers config
├── package.json        # Node dependencies and scripts
├── .dev.vars.example   # Template for local secrets
├── .gitignore
└── README.md
```

## License

Proprietary — Al-Jarida newspaper. All rights reserved.
