# AlJarida v2 — Integrated deploy package

Everything wired up. Just copy files and deploy.

## What's in this zip

- **wrangler.toml** — updated with cron trigger
- **src/index.js** — updated with scheduled handler
- **src/admin.js** — updated with v2 routes for detail page and new APIs
- **src/admin_broadcast.js** — updated to filter expired subscribers
- **src/handlers.js** — updated with v2 button routing
- **src/subscription.js** — NEW (lifecycle logic)
- **src/whatsapp_v2.js** — NEW (template senders)
- **src/cron.js** — NEW (daily scheduled task)
- **src/admin_api_v2.js** — NEW (API endpoints)
- **src/admin_subscriber_detail.js** — NEW (detail page UI)
- **src/webhook_v2.js** — NEW (button responders)

## Deployment

### Step 1: Extract over your project

Backup first!

```bash
cd ~/path/to/aljarida-whatsapp
cp -r src src.backup
cp wrangler.toml wrangler.toml.backup

# Extract this zip OVER your project
unzip -o /path/to/aljarida-v2-integrated.zip
```

### Step 2: One manual edit in admin_pages.js

The only file I couldn't replace (because I don't have your version). Add `export` to two lines:

```bash
# On Mac (GNU sed syntax may differ — use your editor if this fails):
sed -i '' 's/^const SHARED_CSS = /export const SHARED_CSS = /' src/admin_pages.js
sed -i '' 's/^function pageShell(/export function pageShell(/' src/admin_pages.js

# Verify the changes:
grep -n "^export const SHARED_CSS\|^export function pageShell" src/admin_pages.js
```

Expected output:
```
12:export const SHARED_CSS = `
203:export function pageShell(title, activePage, bodyHtml) {
```

If sed didn't work, open `src/admin_pages.js` in your editor and:
- Line 12: change `const SHARED_CSS =` to `export const SHARED_CSS =`
- Line 203: change `function pageShell(` to `export function pageShell(`

### Step 3: Also add detail page link to subscribers list (optional)

For convenience, make phone numbers clickable to open the detail page.

In `src/admin_pages.js`, find the `renderSubscribersPage()` function and look for the line inside the JavaScript section that renders each subscriber row. It has something like:

```javascript
'<td class="phone">' + escapeHtml(s.phone) + '</td>' +
```

Change it to:

```javascript
'<td class="phone"><a href="/admin/subscribers/' + encodeURIComponent(s.phone) + '">' + escapeHtml(s.phone) + '</a></td>' +
```

Optional — without this, you can still reach detail pages by typing `/admin/subscribers/PHONENUMBER` in the URL.

### Step 4: Syntax check

```bash
for f in src/*.js; do echo "=== $f ==="; node --check "$f" && echo "OK" || echo "FAIL"; done
```

All should say OK.

### Step 5: Dry-run deploy

```bash
npx wrangler deploy --dry-run
```

Should succeed without errors.

### Step 6: Deploy

```bash
git add -A
git commit -m "Add subscription management v2"
git push
npm run deploy
```

### Step 7: Verify

**Cron:**
- Cloudflare Dashboard → Workers & Pages → aljarida-whatsapp → Triggers
- Should see Cron Triggers: `0 7 * * *`

**Detail page:**
- Go to `https://aljarida-whatsapp.mnakh.workers.dev/admin/subscribers/YOUR_PHONE`
- Should load with stats, action buttons, history sections

**Try actions:**
- Extend your subscription by 7 days
- Add a pilot tag
- Check payment history (should be empty)

## Testing the renewal reminder (careful)

Before manually triggering the cron, check who would receive reminders:

```sql
SELECT phone, subscription_end_at, subscription_plan
FROM subscribers
WHERE state = 'active'
  AND subscription_plan != 'pilot'
  AND subscription_end_at BETWEEN
    (unixepoch() + 6.5*86400)*1000 AND (unixepoch() + 7.5*86400)*1000;
```

If the list has unexpected users, adjust their `subscription_end_at` first.

Then in Cloudflare Dashboard → Triggers → click Trigger next to the cron to run manually.

## Rollback

If something goes wrong:

```bash
cp -r src.backup/* src/
cp wrangler.toml.backup wrangler.toml
npm run deploy
```
