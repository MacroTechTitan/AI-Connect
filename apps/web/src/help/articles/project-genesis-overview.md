# Project Genesis overview

Project Genesis is AI Connect's provisioning engine. When you click "New Project," Genesis runs a sequence of steps to create and wire together the infrastructure your project needs.

## Steps

1. **create_github_repo** — creates a Git repo (in MacroTechTitan's org, or your own org if the GitHub connector is enabled)
2. **create_supabase_project** — provisions a Supabase project for your database
3. **create_render_service** — deploys the repo to Render as a web service
4. **wire_auth0** — auto-creates an Auth0 application and syncs `AUTH0_*` env vars (if the Auth0 integration is active)
5. **wire_stripe** — creates a Stripe Express Connected Account and syncs `STRIPE_*` env vars (if the Stripe integration is active)

## Best-effort semantics

Wire steps (`wire_auth0`, `wire_stripe`) are best-effort — if they fail, the underlying project provisioning still succeeds. Each wire step reports its outcome in `details.<integration>_wiring` so you can see whether it worked and retry manually if needed.

## Rollback

If a core step fails (repo, database, or service creation), Genesis rolls back all completed steps. Your GitHub repo, Supabase project, and Render service are torn down cleanly.

## Deployment timing

Some env vars (`AUTH0_*`, `STRIPE_*`) are synced *after* the Render service is created. Render doesn't auto-redeploy when env vars change, so those vars take effect on the next deploy. Push a commit to trigger a redeploy, or use Render's manual redeploy button.

## SSE event stream

Progress is streamed in real-time via Server-Sent Events. The AI Connect UI shows each step as it starts and completes.
