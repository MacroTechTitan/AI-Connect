# Sprint 5 — Project Genesis completion smoke test

This procedure exercises the COMPLETE Project Genesis flow end-to-end: template scaffolding + DNS provisioning + database connection string capture + env var injection. Sprint 4 tested rollback. Sprint 5 tests the happy path with a real working deployed project at a real subdomain URL.

## Prerequisites

You'll need the same four platform tokens as Sprint 4:

1. GitHub Personal Access Token (classic) — github.com/settings/tokens with scopes: repo, delete_repo, admin:repo_hook
2. Vercel Access Token — vercel.com/account/tokens (full access)
3. Render API Key — render.com/u/settings#api-keys
4. Supabase Personal Access Token — supabase.com/dashboard/account/tokens

PLUS — Sprint 5 requires AI Connect's own Cloudflare configuration to be live in Render env vars:
- CLOUDFLARE_API_TOKEN (with DNS:Edit scope on macrotechtitan.com)
- CLOUDFLARE_ZONE_ID (for macrotechtitan.com)
- CLOUDFLARE_BASE_DOMAIN = aiconnectprojects.macrotechtitan.com

These were set up during Sprint 5 prep. Verify they're still in Render's AI Connect API service env vars before testing.

Plus the 3 GitHub template repos created during Sprint 5 prep:
- MacroTechTitan/template-html-js (marked as template)
- MacroTechTitan/template-sveltekit (marked as template)
- MacroTechTitan/template-nextjs (marked as template)

## Steps

### Step 1 — Verify schema and configuration

In Supabase SQL editor:

    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'projects'
      AND column_name IN ('template_choice', 'subdomain', 'database_connection_string_vault_id')
    ORDER BY column_name;

Expected: 3 rows. template_choice with default 'html-js' and NOT NULL; subdomain and database_connection_string_vault_id both nullable.

In Render dashboard, navigate to the AI Connect API service → Environment. Verify all 3 CLOUDFLARE_* vars are present.

### Step 2 — Sign in to AI Connect

Open https://aiconnect.macrotechtitan.com in an incognito window. Sign in.

Verify status block shows your email + role + org name.

### Step 3 — Add 4 platform credentials

Click "Manage settings". In Hosting connections, add each platform's credential. Same as Sprint 4 — each validates against the platform's API on add.

After all 4 are added, "Hosting connections" should show 4 rows.

### Step 4 — Create a test project WITH template selection

In the Projects section, fill in:
- Name: "AIC Sprint 5 HTML-JS Test" (or pick whatever name you want)
- Description: "Sprint 5 smoke test - HTML+JS template"
- Template: select "HTML + JavaScript" (the simplest template — start with this one)

Click "Add project".

Expected: project appears with provisioning_state badge "Not provisioned" + template badge "Template: HTML + JavaScript" + a Provision button.

### Step 5 — Trigger Genesis

Click "Provision". The GenesisProgress component opens below the project row.

Expected step sequence (most steps take 1-10 seconds; verify_deployment takes 2-5 minutes):

1. Create GitHub repo — should now show "Template: MacroTechTitan/template-html-js" in details (Sprint 4 created empty repos via auto_init; Sprint 5 uses createRepoFromTemplate)
2. Create Supabase project — extended in Sprint 5: now waits for ACTIVE_HEALTHY status (will show 30-90 seconds elapsed) + captures connection string. Details should show "dbReady: true, vaultSecretId: <uuid>"
3. Create Vercel project
4. Create Render service
5. Wire GitHub to Render — Sprint 5 changes: now provisions a Cloudflare CNAME. Details should show subdomain + fullUrl
6. Inject env vars — Sprint 5 changes: now PUTs DATABASE_URL + NODE_ENV + PROJECT_NAME to Render. Details should show keysSet: ["DATABASE_URL", "NODE_ENV", "PROJECT_NAME"]
7. Verify deployment — polls the Render URL. Sprint 5 should succeed here (vs Sprint 4's empty-repo timeout) because the html-js template produces a real working app.

Final expected state:
- Project badge: "Provisioned" (green)
- All 7 steps green succeeded
- Subdomain URL is now displayed in the project row metadata as a clickable link

### Step 6 — Verify the deployed site

Click the subdomain URL in the project row. Expected: real working HTML page showing your project name, intro text, code block, footer link to AI Connect. The PROJECT_NAME env var injection worked.

Browser URL bar should read: https://aic-sprint-5-html-js-test.aiconnectprojects.macrotechtitan.com

### Step 7 — Verify the database connection works

The template doesn't query the database in Sprint 5 MVP, but verify the connection string is reachable:

In Supabase SQL editor (this project, AI Connect's):

    SELECT id, name, slug, template_choice, subdomain, database_connection_string_vault_id, provisioning_state
    FROM projects
    WHERE slug = 'aic-sprint-5-html-js-test';

Expected: 1 row with template_choice='html-js', subdomain='aic-sprint-5-html-js-test', database_connection_string_vault_id is a UUID (the Vault reference), provisioning_state='provisioned'.

### Step 8 — Verify the secret IS in Vault

Optional: in Supabase Dashboard for AI Connect's project, navigate to Vault → Secrets. Search for "ai-connect:project:" — you should see one matching the project ID. The decrypted value (don't decrypt unless investigating) would be the Postgres connection string.

### Step 9 — Verify the Render service has DATABASE_URL

In Render dashboard, find the newly-provisioned service "aic-sprint-5-html-js-test". Click Environment. Expected: DATABASE_URL, NODE_ENV=production, PROJECT_NAME all present.

### Step 10 — Cleanup

The smoke test created real cloud resources. Clean up:

1. Click "Remove" / Delete on the test project in AI Connect. Note: as in Sprint 4, this only deletes AI Connect's DB row, NOT the provisioned cloud resources. (Resource cleanup on DELETE is a Sprint 5.5+ follow-up.)
2. Manually delete from each platform:
   - GitHub: github.com/<your-username>/aic-sprint-5-html-js-test → Settings → Delete
   - Vercel: dashboard → aic-sprint-5-html-js-test → Settings → Delete
   - Render: dashboard → aic-sprint-5-html-js-test service → Delete
   - Supabase: dashboard → aic-sprint-5-html-js-test → Settings → Delete
   - Cloudflare DNS: dash.cloudflare.com → macrotechtitan.com → DNS → find the CNAME for aic-sprint-5-html-js-test → Delete (Note: Sprint 5's rollback handles this automatically on failure, but a successful provision means we left the record live)

Total cleanup time: ~7 minutes (slightly more than Sprint 4 because of the Cloudflare record).

## Optional: Test failure paths

### Test failure: revoke Render token mid-genesis

Same as Sprint 4. Should now:
- Create GitHub repo succeeds (template repo)
- Create Supabase project succeeds (with wait + vault capture)
- Create Vercel project succeeds
- Create Render service fails (auth)
- Rollback: Vercel → Supabase (with its Vault secret) → GitHub
- Verify the Cloudflare CNAME was NEVER created (step 5 didn't run)
- Verify Vault secret cleanup is best-effort (deleted with the Supabase project)

### Test failure: invalid template choice

Try POSTing directly to the API with template_choice: "doesnotexist" via curl. Expected: 400 invalid_template_choice. Cannot test this via the UI since the radio buttons only offer 3 valid options.

### Test the other 2 templates

Repeat steps 4-10 with template_choice "sveltekit" then "nextjs". Each should ship a slightly different working homepage but otherwise identical flow.

## If anything fails

- Subdomain doesn't resolve in browser after provisioning succeeds: DNS propagation can take a few minutes even though Cloudflare provisioning is instant. Try clearing DNS cache (ipconfig /flushdns on Windows) and waiting 2 minutes.
- Cloudflare CNAME exists but the subdomain returns Cloudflare error: usually means Cloudflare proxied=true is set but should be false. Verify in cloudflare.ts that proxied: false is hardcoded.
- DATABASE_URL is set but app can't connect: Supabase connection pooler can have brief startup delays. Try refreshing the deployed app after 30 seconds.
