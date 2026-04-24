# AlJarida Pricing Update — Yearly Only (12 KWD/year)

## What changed

- **Pricing:** Now 12 KWD/year (was 2.5 KWD/month)
- **Plans offered:** Yearly only (monthly removed from new signups)
- **Pilot and gift plans:** Unchanged
- **Default plan for new subscribers:** yearly (was monthly)

## Files to replace

Drop these 6 files into your `src/` directory:

1. `src/templates.js` — Updated offer and payment messages with new price
2. `src/subscription.js` — Pricing constants updated to 12 KWD yearly
3. `src/admin.js` — Default plan for new subscribers is now yearly
4. `src/admin_api_v2.js` — Default payment plan is yearly
5. `src/admin_subscriber_detail.js` — Payment form defaults to 12 KWD, plan dropdown hides monthly
6. `src/webhook_v2.js` — Renewal help message shows yearly-only pricing

## Deployment

```bash
cd ~/path/to/aljarida-whatsapp

# Backup current files (just in case)
cp -r src src.backup-pricing

# Extract and overlay
unzip -o /path/to/aljarida-pricing-update.zip

# Syntax check
for f in src/*.js; do node --check "$f" && echo "$f OK"; done

# Deploy
git add -A
git commit -m "Update pricing to 12 KWD/year (yearly only)"
git push
npm run deploy
```

## Still to do — Meta template update

The renewal reminder template (`aljarida_renewal_reminder_ar`) currently says
"2.5 د.ك / شهرياً" and needs to be updated.

### Steps:

1. Go to Meta Business Manager → WhatsApp Manager → Templates
2. Find `aljarida_renewal_reminder_ar`
3. Click Edit
4. Change the body to:

```
مرحباً {{1}}،

ينتهي اشتراكك في "جريدة الجريدة — النسخة الرقمية" خلال {{2}}.

للاستمرار في استلام العدد اليومي، يُرجى تجديد اشتراكك.

💰 12 د.ك / سنوياً
```

5. Submit for re-approval (1-3 days wait)
6. Keep the same category (MARKETING) and buttons (تجديد الاشتراك, المساعدة)

Until Meta approves the updated template, renewal reminders will still show
the old price. The current pilot won't be affected because pilot subscribers
don't receive renewal reminders.

## Note on legacy subscribers

Any existing subscribers with `subscription_plan = 'monthly'` still work fine —
they just show "شهري" in the badge on the detail page.

You mentioned you'll manually convert them via admin. To do this for each one:
1. Open their detail page: `/admin/subscribers/PHONE`
2. Click "تغيير الخطة"
3. Select "سنوي (12 د.ك)"
4. Save

Or bulk via SQL:
```sql
-- Convert all monthly subscribers to yearly with same end date
UPDATE subscribers
SET subscription_plan = 'yearly'
WHERE subscription_plan = 'monthly';
```

## Verification after deploy

1. Visit admin dashboard — still loads ✅
2. Open subscriber detail page — plan dropdown shows only yearly/pilot/gift ✅
3. Click "إضافة دفعة" — defaults to 12 KWD ✅
4. No code errors in browser console ✅
