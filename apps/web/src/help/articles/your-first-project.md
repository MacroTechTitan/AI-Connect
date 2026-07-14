# Your first project

Provisioning your first project via Project Genesis takes about 3 minutes.

## Before you start

You'll need:
- An AI Connect account
- (Optional) Platform credentials configured for GitHub, Render, and Supabase — these live in Settings → Integrations. Without them, Project Genesis falls back to MacroTechTitan's platform infrastructure.

## Walkthrough

### Step 1 — Click "New Project"

From your dashboard, click **New Project**. A modal opens.

### Step 2 — Name your project

Enter a name (e.g., "my-first-app"). AI Connect generates a slug from it. The slug becomes:
- Your GitHub repo name
- Your Render service name
- Your Supabase project reference

### Step 3 — Pick a template

Templates provide starter code. v1 includes:
- **HTML/JS** — static site
- **SvelteKit** — full-stack SvelteKit
- **Next.js** — Next.js app router

### Step 4 — Confirm and provision

Click **Provision**. AI Connect runs Project Genesis:
1. Creates GitHub repo (in MacroTechTitan's org, or your own org if you've added the GitHub integration)
2. Creates Supabase project
3. Creates Render web service pointed at the GitHub repo
4. Syncs Auth0 credentials (if Auth0 integration active)
5. Syncs Stripe credentials (if Stripe integration active)

The whole thing takes 60-120 seconds. Watch the progress stream in real-time.

### Step 5 — Deploy

Your project is live at `https://<slug>.onrender.com`. Push commits to the GitHub repo to trigger new deploys.

## What if something fails?

Project Genesis is fail-safe by design — auto-wired integrations (Auth0, Stripe, GitHub App) use best-effort semantics. If any wire step fails, the underlying project still provisions successfully. The wire step reports the failure so you can retry manually.

## Next steps

- [Understanding tiers](#understanding-tiers) — what happens when you hit Free limits
- [Project Genesis overview](#project-genesis-overview) — how the internals work
