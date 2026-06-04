# Sprint 4 — Project Genesis MVP smoke test

This procedure exercises the end-to-end Project Genesis flow against real platform APIs. Unlike Sprints 0-3 which tested entirely against AI Connect's own infrastructure, Sprint 4 creates real cloud resources in your accounts. Plan to clean them up manually after a successful run.

## Prerequisites

You'll need to generate four platform tokens:

1. GitHub Personal Access Token (classic) — generate at github.com/settings/tokens with scopes: repo, delete_repo, admin:repo_hook
2. Vercel Access Token — generate at vercel.com/account/tokens (full access scope)
3. Render API Key — generate at render.com/u/settings#api-keys
4. Supabase Personal Access Token — generate at supabase.com/dashboard/account/tokens

Save these temporarily in a password manager scratch note. They'll be encrypted in Vault after entry and never displayed again.

## Steps

### Step 1 — Verify schema is live
Run in Supabase SQL editor:

    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename IN ('platform_credentials', 'project_provisioning_events') 
    ORDER BY tablename;

Expected: 2 rows. Both tables exist.

Then verify the events constraint includes all 6 status values:

    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'project_provisioning_events'::regclass
      AND conname = 'project_provisioning_events_status_check';

Expected: 1 row showing CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'rolled_back', 'failed_to_rollback')).

### Step 2 — Sign in to AI Connect
Open https://aiconnect.macrotechtitan.com in an incognito window. Sign in (Google or existing email account).

Verify status block shows your email + role + org name + "Manage settings" link.

### Step 3 — Add 4 platform credentials
Click "Manage settings". Find "Hosting connections" section (between Projects and Provider keys).

Add each credential one at a time:

For each platform:
1. Select platform from dropdown
2. Label (e.g., "Smoke test GitHub")
3. Paste the token
4. Click "Add connection"

Expected per credential:
- Brief loading state
- New row appears with the credential
- Identity shown muted (e.g., "as yourusername" for GitHub)
- No errors

If a credential fails validation, the platform's error message will surface. Common issues:
- GitHub: missing repo or delete_repo scope
- Vercel: token doesn't have full access
- Render: API key revoked
- Supabase: PAT vs anon key confusion (must be PAT)

After all 4 are added, you should see 4 rows in the Hosting connections list.

### Step 4 — Create a test project
In the Projects section above Hosting connections, fill in:
- Name: "AIC Smoke Test"
- Description: "Sprint 4 Project Genesis end-to-end smoke test"

Click "Add project".

Expected: project appears in list with slug "aic-smoke-test", state badge shows "Not provisioned".

### Step 5 — Trigger Genesis
Click the "Provision" button on the test project row.

Expected immediately:
- State badge changes to "Provisioning..."
- A live progress component opens below the project
- First event arrives within ~2 seconds: "Create GitHub repo" → in_progress
- Then succeeded, with the new repo URL displayed as a link

Then watch the rest of the steps stream in over ~3-8 minutes:
1. Create GitHub repo — usually <5 seconds
2. Create Supabase project — usually <10 seconds (project initialization continues async; AI Connect doesn't poll for ACTIVE_HEALTHY in MVP)
3. Create Vercel project — usually <5 seconds
4. Create Render service — usually <10 seconds
5. Wire GitHub to Render — instant (no-op placeholder)
6. Inject env vars — instant (no-op placeholder)
7. Verify deployment — polls Render URL for up to 5 minutes; usually succeeds in 2-4 minutes once Render finishes building from the empty repo

Final expected state:
- Project badge shows "Provisioned" in green
- Each step shows green succeeded icon
- The Render URL is clickable and returns 200 (probably a Render placeholder page since the repo is empty)

### Step 6 — Verify provisioning events in DB
In Supabase SQL editor:

    SELECT step_name, status, completed_at - started_at AS duration, details
    FROM project_provisioning_events 
    WHERE project_id = (SELECT id FROM projects WHERE slug = 'aic-smoke-test')
    ORDER BY created_at;

Expected: 7 rows, all with status='succeeded' and reasonable durations. The details column should show URLs and resource IDs.

Then verify the project's final state:

    SELECT id, name, slug, provisioning_state FROM projects WHERE slug = 'aic-smoke-test';

Expected: provisioning_state = 'provisioned'.

### Step 7 — Cleanup
The smoke test created real cloud resources. Clean them up:

1. Click "Remove" on the test project in AI Connect — this only deletes the AI Connect DB row, NOT the cloud resources (Sprint 5+ work).
2. Manually delete the resources from each platform:
   - GitHub: github.com/<your-username>/aic-smoke-test → Settings → Delete repository
   - Vercel: vercel.com/<your-username>/aic-smoke-test → Settings → Delete project
   - Render: dashboard.render.com → find the aic-smoke-test service → Delete
   - Supabase: supabase.com/dashboard → find the aic-smoke-test project → Settings → Delete project
3. Optionally remove the test credentials from AI Connect:
   - Click "Remove" on each Hosting connection in the settings panel.

Total cleanup time: ~5 minutes manually.

## Failure paths (also worth testing)

If you have time, test the failure path explicitly:

### Test failure: revoke a token mid-genesis

Add 4 credentials normally. Start genesis on a NEW test project. While genesis is running, immediately go to vercel.com/account/tokens and revoke the Vercel token you just used.

Expected:
- create_github_repo succeeds
- create_supabase_project succeeds  
- create_vercel_project fails with platform error (Vercel API returns 401/403)
- Orchestrator starts rollback
- rollback:create_supabase_project succeeds (Supabase API still has its own token)
- rollback:create_github_repo succeeds
- rollback_summary event written
- Project state = 'rolled_back' (clean rollback)
- No orphan resources

Verify no orphan resources remain by checking each platform's dashboard.

## If anything fails

- Frontend console errors → check that authedFetch is working and JWT is valid
- "missing_platform_credentials" → verify all 4 platforms added
- Render service stuck "Build failed" → expected on empty repo; the verify_deployment step polls for 200 and may time out at 5 minutes
- Stuck "Provisioning..." with no events → orchestrator crashed; manually update the project's provisioning_state to 'failed' via SQL editor
