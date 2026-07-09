# AI Connect Stripe Connector

Sprint 9 shipped two Stripe-related features. This document covers both:

1. **Upgrading AI Connect to Pro** — AI Connect's own paid tier ($49/mo)
2. **Adding Stripe to your projects** — Auto-provision Stripe Express Connected Accounts when Project Genesis creates a new project so your apps can accept payments day one

## 1. Upgrading AI Connect to Pro

AI Connect has two tiers:

**Free** ($0/month):
- 2 integrations maximum
- 1 project maximum
- WordPress + SendGrid connectors only
- Community support

**Pro** ($49/month):
- Unlimited integrations
- Unlimited projects
- All connectors including OpenClaw, Auth0, Stripe
- Project Genesis auto-wiring
- Priority support

### Upgrading

Settings → Billing → "Upgrade to Pro"

You'll be redirected to Stripe's hosted checkout page. Enter your payment method, confirm, and you'll be back on AI Connect with Pro immediately active.

### Managing your subscription

Settings → Billing → "Manage subscription" opens the Stripe Customer Portal in a new tab. Update payment method, view invoices, change billing address, and cancel from there.

### Cancellation

Settings → Billing → "Cancel subscription" schedules cancellation at the end of your current billing period. You retain Pro access until then. Reactivate before period end from the Customer Portal.

Existing integrations and projects are NOT deleted when you downgrade. You can view, edit, and delete them — you just can't create new ones beyond the Free tier limits.

### Grandfathered access

Early users have Pro access with no subscription required — you'll see "You have grandfathered Pro access" on the Billing page. If you'd like to support AI Connect development by converting to a paid subscription, you can start one from the same page.

### If a payment fails

Stripe retries failed payments automatically per their standard dunning policy. Your account status will show "past_due" temporarily but Pro access continues during the retry window. You'll get email notifications from Stripe. If all retries fail, the subscription cancels and you downgrade to Free at that point.

## 2. Stripe Connect for your projects

When Project Genesis provisions a project, AI Connect can automatically create a Stripe Express Connected Account for it and sync the credentials into your project's environment. Your new SaaS accepts payments from day one.

### Prerequisites

Before Project Genesis will auto-wire Stripe for a project:

1. AI Connect must be on Pro tier (Free tier doesn't include Stripe connector)
2. You must have added a Stripe integration in Settings → Integrations
3. That Stripe integration must have "Include in projects" toggled on

### Setting up the Stripe integration

Settings → Integrations → Add Integration → Stripe.

The 5-step wizard walks you through:

1. **Welcome** — explains what Stripe Connect is
2. **Business info** — your email, country (2-letter ISO code like `US`), business type (individual or company)
3. **Create account** — AI Connect creates a Stripe Express Connected Account for you (no manual Stripe Dashboard work needed)
4. **Save integration** — persists the account to AI Connect
5. **Complete Onboarding** — opens Stripe's hosted onboarding flow in a new tab. You provide bank details, tax info, and identity verification. Stripe reviews and enables charges/payouts. This typically takes minutes but can take up to a day for full verification.

Toggle "Include in projects" on the integration row so Project Genesis will use it.

### What Project Genesis does with your Stripe integration

For each new project provisioned (Pro only):

1. Creates a **NEW** Express Connected Account (each project gets its own account for payment isolation)
2. Persists `stripe_account_id` to the project row
3. Generates an onboarding link — you complete Stripe's onboarding for the new project's account
4. Syncs env vars to your project's Render service:
   - `STRIPE_ACCOUNT_ID` — the new Connected Account ID
   - `STRIPE_PUBLISHABLE_KEY` — AI Connect's platform publishable key

### What's NOT synced (important)

`STRIPE_SECRET_KEY` is **NOT** synced to your project. AI Connect's platform secret key must never be given to user projects.

For server-side Stripe operations from your project, your backend uses:
- The publishable key + `Stripe-Account` header via Stripe Connect Direct Charges
- Per-project Restricted Keys (Sprint 10+ if you need this)

Most SaaS projects don't need the platform secret key. Client-side charges via Stripe.js + the publishable key + `Stripe-Account` header is the standard Connect pattern.

### Best-effort semantics

Stripe wiring is best-effort. If any step fails (Stripe API rate limit, network blip, Render API issue), the project provisioning itself STILL succeeds. The wiring result is included in the provisioning event stream (`details.stripe_wiring` on the `wire_stripe` event) so the UI shows whether wiring succeeded.

Failure modes returned as typed results:
- `no_integration` — user has no active Stripe integration with include_in_projects (silent skip)
- `integration_not_validated` — Stripe integration exists but validation didn't pass
- `stripe_account_creation_failed` — Stripe rejected the create request
- `onboarding_link_creation_failed` — account created but link generation failed (partial.account_id returned for manual recovery)
- `render_env_sync_failed` — account created but Render env sync failed (partial + manual onboarding URL returned)
- `db_update_failed` — account created but database persist failed (logs error for reconciliation)

### Deploy timing note

Same caveat as Sprint 8's Auth0 wiring: the STRIPE_* env vars are written AFTER the Render service is created. Render doesn't auto-redeploy on env var changes. The new vars take effect on the next deploy. If the project's first deploy already ran, trigger a manual redeploy for STRIPE_* vars to be active.

Auto-redeploy on env sync is deferred to Sprint 10+.

### Managing the Stripe account after creation

Settings → Integrations → click "Manage Account" on the Stripe integration row.

The Account Manager shows:
- Status Badge: pending / active / restricted
- Account ID (copyable)
- Country, business type
- Charges/Payouts/Details submitted flags
- Status-specific actions:
  - **pending** → Continue Onboarding
  - **restricted** → Complete Requirements + reasons list
  - **active** → Open Express Dashboard

The status auto-syncs via Stripe's `account.updated` webhook — as you complete onboarding, come back and hit Refresh to see the update.

## Security model

- Stripe Connect uses AI Connect's platform `STRIPE_SECRET_KEY` + Stripe-Account header per API call. No per-user secret in AI Connect's Vault.
- The user's Stripe Connected Account is created with metadata linking it to the AI Connect user_id and project_id.
- User projects only receive `STRIPE_ACCOUNT_ID` + `STRIPE_PUBLISHABLE_KEY` (publishable key is public-safe by design).
- Webhook signature verification protects against event replay and spoofing.

## What's not in v1 (deferred to Sprint 10+)

- Auto-redeploy Render after STRIPE_* env sync
- Per-project Restricted Keys instead of platform publishable key
- Reusing existing Stripe accounts across projects (currently creates fresh per project)
- Test charges / payment intent testing from AI Connect UI
- Custom onboarding UI (currently Stripe hosted)
- Multi-account per Stripe integration
- Country validation / whitelist of Stripe-supported countries
- Refund UI
- Invoice / payment history in AI Connect (Stripe Portal handles externally)
- Multi-tier (Team, Enterprise beyond Pro)
- Annual billing
- Promo codes / discounts

## Source code reference

- Types: `apps/api/src/lib/integrations/types.ts`
- Client: `apps/api/src/lib/integrations/stripeClient.ts`
- Validator: `apps/api/src/lib/integrations/validators/stripe.ts`
- Routes: `apps/api/src/routes/integrations.ts` (search for `handle*Stripe*` handlers)
- Subscription routes: `apps/api/src/routes/subscription.ts`
- Webhook: `apps/api/src/routes/stripeWebhook.ts`
- Genesis wiring: `apps/api/src/lib/genesis/stripeWiring.ts`
- Wizard: `apps/web/src/components/StripeWizard.tsx`
- Account manager: `apps/web/src/components/StripeAccountManager.tsx`
- Pricing/Subscription UI: `apps/web/src/components/{PricingPage,SubscriptionPanel,UpgradePromptModal}.tsx`
- Migrations: `apps/api/drizzle/0010_*.sql` (subscriptions), `0011_*.sql` (stripe integration_type + projects columns + webhook events), `0012_*.sql` (stripe_account_id index)
