# Sprint 9 Smoke Test Plan

Sprint 9 shipped two intertwined features: AI Connect's own paid tier (Stripe Standard) and the Stripe Connect connector for user projects. This is the end-to-end test plan.

## Prerequisites

- Sprint 9 branch merged to master OR local checkout at Commit 14
- All migrations applied to AI Connect Supabase (0010, 0011, 0012 — verified in prior sessions)
- Local dev environment: pnpm --filter @ai-connect/api dev + pnpm --filter @ai-connect/web dev
- Bootstrap script run at least once against dev DB: pnpm --filter @ai-connect/api tsx src/scripts/bootstrapSubscriptions.ts
- For Stripe sections: Stripe test-mode account with:
  - STRIPE_SECRET_KEY (test key, starts with sk_test_)
  - STRIPE_WEBHOOK_SECRET from a webhook endpoint in Stripe Dashboard (or from Stripe CLI listen)
  - STRIPE_PUBLISHABLE_KEY
  - STRIPE_PRO_PRICE_ID (create a $49/mo test Product + Price)
  - Stripe CLI installed and authenticated

## A. Grandfathering existing users

### A1. Bootstrap script grandfathers all existing users
- Fresh DB (or DB where bootstrap hasn't run)
- Confirm at least 1 existing user exists in the users table
- Run: pnpm --filter @ai-connect/api tsx src/scripts/bootstrapSubscriptions.ts
- Verify: script output shows "Bootstrapped N users to Pro"
- ✓ Pass: SELECT * FROM subscriptions shows a row per user with tier='pro', status='active', both stripe IDs NULL

### A2. Script is idempotent
- Run the bootstrap script a second time
- ✓ Pass: output shows "No users need bootstrapping. All users have subscription rows."
- ✓ Pass: subscription rows unchanged (no new inserts)

### A3. Lazy bootstrap catches new users
- Create a fresh user via the app's normal signup flow (or manually if easier)
- Do NOT run the bootstrap script
- Have the new user hit GET /api/subscription
- ✓ Pass: returns tier='pro', is_grandfathered=true
- ✓ Pass: SELECT * FROM subscriptions WHERE user_id=<new user> shows a lazily-created row

## B. Free tier limits

To test Free tier, first manually downgrade a user in SQL:

```
UPDATE subscriptions
SET tier='free', status='active'
WHERE user_id='<test user uuid>';
```

### B1. Free user can create 2 integrations
- Sign in as the downgraded test user
- Settings → Integrations → Add SendGrid → complete (integration count: 1)
- Add WordPress → complete (integration count: 2)
- ✓ Pass: Both integrations created successfully

### B2. Free user blocked on 3rd integration
- Try to add a 3rd integration of any type
- ✓ Pass: UpgradePromptModal opens with copy about max_integrations limit
- ✓ Pass: API returned 403 with error='tier_upgrade_required', limit_hit='max_integrations'
- ✓ Pass: Underlying integration was NOT created (check integrations table)

### B3. Free user blocked on non-allowed types
- Try to add OpenAI, Anthropic, OpenClaw, Auth0, or Stripe as a Free user
- ✓ Pass: UpgradePromptModal opens with copy about integration_type_not_allowed
- ✓ Pass: API returned 403 with limit_hit='integration_type_not_allowed'

### B4. Free user can create 1 project
- Trigger Project Genesis for a new project
- ✓ Pass: Project provisioning starts (or completes if platform creds are configured)

### B5. Free user blocked on 2nd project
- Try to create a second project
- ✓ Pass: UpgradePromptModal opens with copy about max_projects limit
- ✓ Pass: API returned 403 with limit_hit='max_projects'
- ✓ Pass: Project row NOT created

### B6. Downgraded Pro user keeps existing resources
- Downgrade a Pro user who has 5 integrations and 3 projects to Free (via SQL)
- ✓ Pass: All existing integrations still visible in UI
- ✓ Pass: All existing projects still visible
- ✓ Pass: Can VIEW / EDIT / DELETE existing resources
- ✓ Pass: CANNOT create new ones (feature gates fire)

## C. Pro upgrade flow (real Stripe test-mode)

### C1. Checkout flow works
- As a Free user (from Section B), visit /settings/billing
- Click "Upgrade to Pro"
- ✓ Pass: Browser redirects to Stripe hosted checkout URL (checkout.stripe.com/...)
- ✓ Pass: Page shows $49/mo Pro tier, correct branding
- Use test card: 4242 4242 4242 4242, any future date, any CVC
- Submit
- ✓ Pass: Browser redirects back to /settings/billing?session_id=...&result=success

### C2. Webhook fires and upgrades user
- In parallel with C1, run: stripe listen --forward-to localhost:8080/api/stripe/webhook
- After C1 checkout completes, verify Stripe CLI shows checkout.session.completed → 200
- ✓ Pass: stripe_webhook_events table has a row for the event with processed=true
- ✓ Pass: subscriptions table shows tier='pro', status='active', both Stripe IDs populated
- ✓ Pass: Refresh /settings/billing → SubscriptionPanel now shows "You're on the Pro plan"

### C3. Idempotency — replay attempt rejected
- With Stripe CLI still listening, note the event.id from C2
- Trigger the same event again (or use Stripe CLI to resend)
- ✓ Pass: Returns 200 with { received: true, duplicate: true }
- ✓ Pass: stripe_webhook_events row unchanged (no duplicate insert)

### C4. Signature verification
- Send a malformed POST directly to /api/stripe/webhook with a bad Stripe-Signature header
- ✓ Pass: Returns 400 with error='invalid_signature'

## D. Customer Portal

### D1. Portal redirect works
- As a Pro user (post-C2), Settings → Billing → click "Manage subscription"
- ✓ Pass: Browser opens Stripe Customer Portal in new tab
- ✓ Pass: Shows current subscription, payment method, invoice history

### D2. Cancellation schedule
- In portal, click "Cancel plan"
- Confirm cancellation
- ✓ Pass: Portal shows "Cancelling at period end on <date>"
- Wait for webhook to fire (or trigger customer.subscription.updated via CLI)
- ✓ Pass: subscriptions row shows cancel_at_period_end=true
- ✓ Pass: SubscriptionPanel now shows "Cancellation scheduled for <date>"

### D3. Cancellation via AI Connect UI
- As a paying Pro user, Settings → Billing → click "Cancel subscription"
- ✓ Pass: Confirm modal opens
- Click Confirm
- ✓ Pass: subscriptions row shows cancel_at_period_end=true
- ✓ Pass: SubscriptionPanel updates

## E. Downgrade (post-cancellation)

### E1. Period-end downgrade
- Manually trigger customer.subscription.deleted via CLI (simulates end-of-period)
- ✓ Pass: Webhook returns 200
- ✓ Pass: subscriptions row shows tier='free', status='canceled', stripe_subscription_id=NULL
- ✓ Pass: Refresh app → user now sees Free tier limits
- ✓ Pass: Existing resources still accessible (per B6)

## F. Stripe Connect integration setup

Requires C-D setup (user is Pro, real Stripe test-mode configured).

### F1. Wizard opens
- Settings → Integrations → Add Integration → "Stripe" appears in type dropdown
- ✓ Pass: Not gated behind local mode
- Select Stripe + Add → StripeWizard modal opens with Welcome step

### F2. Business info step
- Continue to step 2
- Fill in email, country (e.g., "US"), business_type (Individual)
- ✓ Pass: Continue disabled until all fields filled
- Continue → advances to Step 3

### F3. Create account step (auto-runs)
- ✓ Pass: Shows "Creating your Stripe Connected Account..." loading state
- ✓ Pass: POST /api/integrations/stripe/create-express-account returns 201 with account_id
- ✓ Pass: Auto-advances to Step 4

### F4. Save integration step (auto-runs)
- ✓ Pass: POST /api/integrations returns 201 with the integration row
- ✓ Pass: integrations table has new row with integration_type='stripe', status='validated', config.stripe_account_id set

### F5. Onboarding step
- ✓ Pass: Shows "Complete Stripe Onboarding" primary button
- Click it → opens Stripe hosted onboarding in new tab
- Complete test-mode onboarding (Stripe provides test data auto-fill in test mode)
- Come back to AI Connect, click "I've completed onboarding"
- ✓ Pass: Wizard closes, StripeAccountManager opens

## G. Project Genesis Stripe wiring

Requires F1-F5 completed AND platform Render/GitHub/Supabase credentials configured.

### G1. Toggle include_in_projects
- On the Stripe integration row, toggle "Include in projects" ON
- ✓ Pass: Toggle persists (integrations row: include_in_projects=true)

### G2. Provision project with Stripe wiring
- New Project → provide name, template
- Provision
- ✓ Pass: Standard provisioning steps complete
- ✓ Pass: The wire_stripe genesis step appears in the SSE event stream
- ✓ Pass: wire_stripe reports status='succeeded'

### G3. Verify Stripe account created
- Check Stripe Dashboard → Connect → Accounts
- ✓ Pass: New Express account exists with metadata.ai_connect_project_id = the project's ID
- ✓ Pass: projects table row has stripe_account_id populated, stripe_account_status='pending'

### G4. Verify Render env vars
- Render Dashboard → new project's service → Environment
- ✓ Pass: STRIPE_ACCOUNT_ID matches the new Connected Account ID
- ✓ Pass: STRIPE_PUBLISHABLE_KEY is set (matches platform publishable key)
- ✓ Pass: STRIPE_SECRET_KEY is NOT set (platform key intentionally never synced)

### G5. account.updated webhook syncs status
- In Stripe CLI: stripe trigger account.updated --add account:id=<new account_id>
  (or complete onboarding for the project's account to trigger it naturally)
- ✓ Pass: Webhook returns 200
- ✓ Pass: projects.stripe_account_status transitions to 'active' (if all conditions met) or stays 'pending'
- ✓ Pass: log entry account_updated_synced with from → to transition

## H. Webhook resilience

### H1. Signature verification catches spoofing
- Send a POST to /api/stripe/webhook with body like `{"type": "checkout.session.completed"}` and no signature header
- ✓ Pass: 400 error='missing_signature'

- Send POST with a fake signature header
- ✓ Pass: 400 error='invalid_signature'

### H2. Handler failure returns 500 (Stripe retries)
- Manually mangle stripe_webhook_events processing_error to non-null and cause a subsequent handler failure (or use a manually-crafted checkout event pointing at a non-existent client_reference_id user)
- ✓ Pass: Returns 500
- ✓ Pass: stripe_webhook_events row has processing_error populated

### H3. Unknown event types no-op
- Trigger an event type not in the handler list (e.g., stripe trigger checkout.session.async_payment_succeeded — if not handled)
- ✓ Pass: Returns 200 with { received: true }
- ✓ Pass: log entry unhandled_event_type

## I. Cross-cutting

### I1. Four wizards all use same design system
- Compare WordPress, OpenClaw, Auth0, Stripe wizards visually
- ✓ Pass: All use Modal chrome (rounded corners, shadow, backdrop)
- ✓ Pass: All use Button primitives with consistent styling
- ✓ Pass: All use Input primitives with consistent label/focus/error patterns
- ✓ Pass: All use the same Wizard step indicator

Confirms design system consistency after adding a 4th wizard.

### I2. Cloud vs Local mode behavior
- Cloud: curl -s https://api.aiconnect.macrotechtitan.com/health returns local_mode=false
- Local: curl -s http://localhost:8080/health returns local_mode=true
- ✓ Pass: Stripe works in BOTH modes (no local-only gating like OpenClaw)
- ✓ Pass: Auth0 still works in both modes (Sprint 8)

### I3. Sprint 8 features still work
- WordPress integration (Sprint 6) can still be added and modules configured
- OpenClaw integration (Sprint 7, local mode required) can still be added
- Auth0 integration (Sprint 8) can still be added and applications managed
- No regression from Sprint 9 changes

## Sprint 9 acceptance

Sprint 9 ships when:
- All Sprint 9 commits merged to master via PR
- Section A (Grandfathering) fully passes
- Section B (Free tier limits) fully passes
- Section C (Pro upgrade) fully passes
- Section D (Customer Portal) fully passes
- Section H (Webhook resilience) fully passes
- Section I (Cross-cutting) fully passes
- Sprint 9 SPRINT_LOG.md entry committed direct-to-master post-merge
- Sprints 6, 7, 8 smoke tests still pass (no regression)

Sections E, F, G can be verified post-merge on live system with real Stripe test-mode setup.

Known deferrals to Sprint 10+:
- Auto-redeploy Render after STRIPE_* env sync
- Per-project Restricted Keys instead of publishable key
- Reusing existing Stripe accounts across projects
- Test charges from AI Connect UI
- Custom onboarding UI
- Multi-account per integration
- Country whitelist / validation
- Refund UI
- Invoice history in AI Connect
- Team/Enterprise tiers
- Annual billing
- Promo codes
