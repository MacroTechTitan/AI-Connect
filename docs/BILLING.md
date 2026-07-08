# AI Connect Billing (Admin Reference)

This document is for AI Connect developers and admins. For user-facing billing docs, see `STRIPE_CONNECTOR.md`.

## Architecture

AI Connect uses Stripe Standard for its own paid tier billing. The billing system has four moving parts:

1. **Subscriptions table** — one row per user, tracks tier + status + Stripe IDs
2. **Stripe webhook endpoint** — `/api/stripe/webhook`, updates subscriptions row on Stripe events
3. **Subscription management routes** — `/api/subscription/*` for checkout, portal, get, cancel
4. **Feature gate middleware** — `checkCanCreateIntegration` / `checkCanCreateProject` block Free tier limit-hit attempts

## How a subscription is created

**Happy path:**

1. Free user clicks "Upgrade to Pro" on PricingPage
2. Frontend → `POST /api/subscription/checkout`
3. Backend creates Stripe Customer if not exists (idempotent by metadata.ai_connect_user_id)
4. Backend creates Stripe Checkout Session (mode: subscription, price: STRIPE_PRO_PRICE_ID)
5. Frontend redirects browser to `session.url` (Stripe hosted page)
6. User enters payment, confirms
7. Stripe redirects browser back to `/settings/billing?session_id=...&result=success`
8. Stripe sends `checkout.session.completed` webhook to `/api/stripe/webhook`
9. Webhook handler upserts subscriptions row: tier='pro', status='active', both Stripe IDs set
10. User's next tier check returns 'pro', all Pro features unlock

## How tier is checked

Every route that gates on tier calls `getTierForUser(userId)`:

```typescript
const tier = await getTierForUser(userId);  // 'free' | 'pro'
```

This reads the subscriptions row. If no row exists (edge case — bootstrap missed or brand-new user), lazily creates one with grandfathered Pro tier as a safety net.

The lazy bootstrap is important — it means new users are Pro by default until the Stripe checkout flow explicitly downgrades them. Sprint 10+ may add a "true Free by default" mode.

## Feature limits

Constants in `apps/api/src/lib/tiers.ts`:

```typescript
FEATURE_LIMITS = {
  free: {
    max_integrations: 2,
    max_projects: 1,
    allowed_integration_types: ['sendgrid', 'wordpress'],
  },
  pro: {
    max_integrations: Infinity,
    max_projects: Infinity,
    allowed_integration_types: 'all',
  },
}
```

To change limits: edit the constant, deploy. Not database-driven — deliberate simplicity for v1.

Enforcement:
- `POST /api/integrations` → `checkCanCreateIntegration(userId, type)` before validator runs
- `POST /api/projects` → `checkCanCreateProject(userId)` before genesis kicks off
- Both return 403 with `error: 'tier_upgrade_required'` on limit hit, including limit_hit code so UI can show contextual copy

Feature gates enforce on CREATE only. Downgraded Pro users retain their existing resources — they just can't create more.

## Grandfathering existing users

Sprint 9 shipped with a bootstrap script: `apps/api/src/scripts/bootstrapSubscriptions.ts`.

Run once at Sprint 9 deploy time:

```
pnpm --filter @ai-connect/api tsx src/scripts/bootstrapSubscriptions.ts
```

This gives every existing user a subscription row with tier='pro', status='active', both Stripe IDs NULL.

The script is idempotent — safe to run multiple times. Only users WITHOUT a subscription row get one.

The lazy bootstrap in `getTierForUser` catches any users missed by the script (race conditions, users created between deploy and script run).

## Manually adjusting a user's tier

If you need to give a specific user Pro access without going through Stripe:

```sql
UPDATE subscriptions
SET tier = 'pro', 
    status = 'active',
    stripe_customer_id = NULL,
    stripe_subscription_id = NULL,
    updated_at = now()
WHERE user_id = '<uuid>';
```

If they've never had a subscription row:

```sql
INSERT INTO subscriptions (user_id, tier, status)
VALUES ('<uuid>', 'pro', 'active');
```

To downgrade to Free:

```sql
UPDATE subscriptions
SET tier = 'free', 
    status = 'canceled',
    stripe_subscription_id = NULL,
    current_period_end = NULL,
    updated_at = now()
WHERE user_id = '<uuid>';
```

If the user has an active Stripe subscription, you should ALSO cancel it in Stripe Dashboard to prevent double-billing.

## Webhook handling

`/api/stripe/webhook` handles both Stripe Standard events (subscription billing) and Stripe Connect events (Connected Account updates).

Critical requirements enforced by the implementation:

1. **Raw body required for signature verification.** `express.raw({type: 'application/json'})` mounts BEFORE `express.json()` for this specific route. Adding a general body parser would break signature verification.
2. **Signature verification via** `stripeStandardClient.constructWebhookEvent(rawBody, signature)`. Uses `STRIPE_WEBHOOK_SECRET` from env.
3. **Idempotency via `stripe_webhook_events` table.** Every event's `event.id` is inserted with `processed=false`. Duplicate detection is via primary key conflict (PG error code 23505). Duplicates return 200 to stop Stripe from retrying.
4. **Handler failure returns 500.** Stripe retries with exponential backoff. The failed event's `processing_error` column is populated for observability.
5. **Handler success returns 200 + marks `processed=true`.**

Events handled:

**Stripe Standard (paid tier):**
- `checkout.session.completed` — upsert subscription row with tier='pro'
- `customer.subscription.updated` — sync status, current_period_end, cancel_at_period_end
- `customer.subscription.deleted` — tier='free', status='canceled', clear stripe_subscription_id
- `invoice.payment_failed` — status='past_due', tier stays 'pro' during retry window

**Stripe Connect:**
- `account.updated` — sync `projects.stripe_account_status` based on charges_enabled + payouts_enabled + details_submitted + requirements.disabled_reason

Events NOT explicitly handled are logged as `unhandled_event_type` and return 200 (no-op) so Stripe stops retrying.

## Configuring Stripe Dashboard

AI Connect needs THREE things configured in Stripe Dashboard:

### 1. Products & Prices (one-time)

Create a Product ("AI Connect Pro") with a recurring price ($49/mo, USD). Copy the Price ID (`price_XXXXX`) and set as `STRIPE_PRO_PRICE_ID` env var.

### 2. Webhook endpoints

Create ONE webhook endpoint pointing at `https://api.aiconnect.macrotechtitan.com/api/stripe/webhook`.

Subscribe to these events (both modes are handled by the same endpoint):

- checkout.session.completed
- customer.subscription.updated
- customer.subscription.deleted
- invoice.payment_failed
- account.updated (Connect mode)

Enable "Send events on behalf of connected accounts" (Connect mode) so Connect events reach this endpoint too.

Copy the webhook Signing secret and set as `STRIPE_WEBHOOK_SECRET`.

### 3. Connect settings

Under Connect → Settings, ensure:
- Platform name is set
- Support email is set (users see this on Connected Account onboarding)
- Country of platform matches AI Connect's registered country

## Environment variables

Required in production:

- `STRIPE_SECRET_KEY` — AI Connect's platform Stripe secret key (starts with `sk_live_` in prod)
- `STRIPE_WEBHOOK_SECRET` — for signature verification (starts with `whsec_`)
- `STRIPE_PUBLISHABLE_KEY` — public key synced to user projects (starts with `pk_live_`)
- `STRIPE_PRO_PRICE_ID` — the recurring Price ID for Pro tier (starts with `price_`)

Optional/dev:
- All above are optional in dev — Stripe operations throw `StripeError('invalid_credentials')` on first attempt

## Testing

### Local webhook testing with Stripe CLI

```
stripe listen --forward-to localhost:8080/api/stripe/webhook
```

Then trigger test events:

```
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed
stripe trigger account.updated
```

Verify:
- 200 responses in Stripe CLI output
- `stripe_webhook_events` table has rows with `processed=true`
- `subscriptions` table reflects expected state changes
- No duplicate rows on repeat triggers (idempotency verified)

### End-to-end subscription flow

1. Create a test user in a fresh dev environment
2. Ensure their subscription row is Free (or delete it and let lazy bootstrap create Pro — depends on what you're testing)
3. Visit /settings/billing, click Upgrade
4. In Stripe hosted checkout, use test card `4242 4242 4242 4242`, any future date, any CVC
5. Complete checkout
6. Verify: webhook fired, subscription row updated to Pro, GET /api/subscription returns tier='pro'

### End-to-end Connect flow

1. As a Pro user, add Stripe integration via wizard
2. Complete onboarding with Stripe's test business info
3. Toggle include_in_projects
4. Provision a new project
5. Verify: Connected Account created in Stripe Dashboard, `stripe_account_id` on project row, STRIPE_* env vars on Render service
6. Trigger `stripe trigger account.updated` to simulate onboarding completion
7. Verify: `projects.stripe_account_status` updates from pending → active

## Common issues

**"webhook signature verification failed"** — usually one of:
- `STRIPE_WEBHOOK_SECRET` doesn't match the Dashboard webhook endpoint's Signing secret
- Body parser interfering with raw body (check `express.raw` mounts BEFORE `express.json`)
- Testing against Dashboard events vs. Stripe CLI events (different secrets)

**"tier_upgrade_required" for existing users** — bootstrap script didn't run OR user was created after bootstrap. Solution: manually insert Pro subscription row for the user, or let them upgrade normally.

**Subscription row missing after checkout** — webhook didn't reach us. Check:
- Stripe Dashboard → Webhooks → Signing Attempts for failure history
- API server logs for webhook errors
- `stripe_webhook_events` table for the event.id (if present, we got it; if not, delivery failed)

**Stripe Connect account created but env vars not synced** — Render API failure during genesis. `wire_stripe` result has `reason: 'render_env_sync_failed'` and `partial.account_id`. Manually add STRIPE_ACCOUNT_ID + STRIPE_PUBLISHABLE_KEY to the Render service's env vars.

## Source code reference

- Migrations: 0010 (subscriptions), 0011 (stripe integration_type + projects columns + webhook events), 0012 (stripe_account_id index)
- Client: `apps/api/src/lib/integrations/stripeClient.ts`
- Webhook: `apps/api/src/routes/stripeWebhook.ts`
- Subscription routes: `apps/api/src/routes/subscription.ts`
- Tier module: `apps/api/src/lib/tiers.ts`
- Bootstrap script: `apps/api/src/scripts/bootstrapSubscriptions.ts`
- Genesis wiring: `apps/api/src/lib/genesis/stripeWiring.ts`
