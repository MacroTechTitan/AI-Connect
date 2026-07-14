# Stripe connector

The Stripe connector auto-provisions a Stripe Express Connected Account for each project you create through Project Genesis, and syncs the credentials into the project's environment. Your new SaaS can accept payments from day one.

> This article covers adding Stripe to *your projects*. For AI Connect's own Pro subscription, see [Upgrading to Pro](#upgrading-to-pro) and [Managing your subscription](#managing-your-subscription).

## Prerequisites

Before Project Genesis will auto-wire Stripe for a project:

1. AI Connect must be on the **Pro** tier (Free doesn't include the Stripe connector)
2. You must have added a Stripe integration in Settings → Integrations
3. That integration must have **Include in projects** toggled on

## Setting up the Stripe integration

Settings → Integrations → **Add Integration** → **Stripe**. The 5-step wizard walks you through:

1. **Welcome** — explains what Stripe Connect is
2. **Business info** — your email, country (2-letter ISO code like `US`), and business type (individual or company)
3. **Create account** — AI Connect creates a Stripe Express Connected Account for you (no manual Stripe Dashboard work needed)
4. **Save integration** — persists the account to AI Connect
5. **Complete onboarding** — opens Stripe's hosted onboarding in a new tab, where you provide bank details, tax info, and identity verification. Stripe reviews and enables charges/payouts. This usually takes minutes but can take up to a day for full verification.

Toggle **Include in projects** on the integration row so Project Genesis will use it.

## What Project Genesis does with your Stripe integration

For each new project provisioned (Pro only), Genesis:

1. Creates a **new** Express Connected Account (each project gets its own account for payment isolation)
2. Persists `stripe_account_id` to the project
3. Generates an onboarding link — you complete Stripe's onboarding for the new project's account
4. Syncs env vars to the project's Render service:
   - `STRIPE_ACCOUNT_ID` — the new Connected Account ID
   - `STRIPE_PUBLISHABLE_KEY` — AI Connect's platform publishable key

### What's *not* synced (important)

`STRIPE_SECRET_KEY` is **not** synced to your project. AI Connect's platform secret key must never be given to user projects.

For server-side Stripe operations from your project, your backend uses the publishable key plus the `Stripe-Account` header via Stripe Connect Direct Charges — the standard Connect pattern. Per-project Restricted Keys are on the roadmap if you need them. Most SaaS projects don't need the platform secret key at all.

### Best-effort semantics

Stripe wiring is best-effort. If any step fails (Stripe rate limit, network blip, Render API issue), the project provisioning itself *still* succeeds. The wiring result appears in the provisioning event stream (`details.stripe_wiring` on the `wire_stripe` event) so the UI shows whether it worked.

Typed failure modes:
- `no_integration` — no active Stripe integration with "Include in projects" (silent skip)
- `integration_not_validated` — the integration exists but validation didn't pass
- `stripe_account_creation_failed` — Stripe rejected the create request
- `onboarding_link_creation_failed` — account created but link generation failed (the account ID is returned for manual recovery)
- `render_env_sync_failed` — account created but the Render env sync failed (a manual onboarding URL is returned)
- `db_update_failed` — account created but the database persist failed (logged for reconciliation)

### Deploy timing note

The `STRIPE_*` env vars are written *after* the Render service is created. Render doesn't auto-redeploy on env var changes, so the new vars take effect on the next deploy. If the project's first deploy already ran, trigger a manual redeploy for the `STRIPE_*` vars to become active.

## Managing the Stripe account after creation

Settings → Integrations → **Manage Account** on the Stripe integration row. The Account Manager shows:

- A status badge: pending / active / restricted
- The Account ID (copyable)
- Country and business type
- Charges / Payouts / Details-submitted flags
- Status-specific actions:
  - **pending** → Continue Onboarding
  - **restricted** → Complete Requirements (with a reasons list)
  - **active** → Open Express Dashboard

Status auto-syncs via Stripe's `account.updated` webhook — as you complete onboarding, come back and hit **Refresh** to see the update.

## Security model

- Stripe Connect uses AI Connect's platform secret key plus a `Stripe-Account` header per API call — no per-user secret is stored in AI Connect's Vault
- Each Connected Account is created with metadata linking it to your AI Connect user and project
- Your projects only ever receive `STRIPE_ACCOUNT_ID` and `STRIPE_PUBLISHABLE_KEY` (the publishable key is public-safe by design)
- Webhook signature verification protects against event replay and spoofing

## Not in v1

- Auto-redeploy of Render after `STRIPE_*` env sync
- Per-project Restricted Keys instead of the platform publishable key
- Reusing an existing Stripe account across projects (currently a fresh account per project)
- Test charges / payment-intent testing from the AI Connect UI
- Custom onboarding UI (currently Stripe-hosted)
- Multiple accounts per Stripe integration
- Country validation / whitelist of Stripe-supported countries
