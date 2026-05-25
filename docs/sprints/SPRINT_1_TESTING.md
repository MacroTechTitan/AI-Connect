# Sprint 1 — manual smoke test

Run this end-to-end after Sprint 1 merges to master and the deploy goes green. The goal is to confirm Auth0 sign-up → JWT → lazy user creation → audit log → sign-out all work in production.

Prerequisite: a fresh Auth0-eligible email you have not used on this project before. **Do not use `jgelet@macrotechtitan.com`** — that email already exists as the admin seed, so it won't exercise the create branch.

## Procedure

1. Open `https://aiconnect.macrotechtitan.com` (or the local dev URL once we set that up).
2. Click **Sign in**. Auth0's hosted login page opens.
3. Sign up with a fresh email (NOT `jgelet@macrotechtitan.com` — that already exists as admin).
4. Auth0 redirects back to the landing page.
5. The page now shows `Signed in as <email> (role: user)`.
6. Open the Supabase SQL editor and run:
   ```sql
   SELECT * FROM users WHERE email = '<that email>';
   ```
7. Confirm: 1 row, `role = 'user'`, `created_at` is current time, `last_seen_at` is current time.
8. Also run:
   ```sql
   SELECT * FROM user_audit_logs ORDER BY occurred_at DESC LIMIT 5;
   ```
9. Confirm: an `action = 'first_login_create_user'` entry exists for the new user (the `user_id` column should match the `id` from step 7).
10. Hit `https://api.aiconnect.macrotechtitan.com/api/me` without auth (curl, browser, Postman — any unauthenticated request) and confirm the response is HTTP 401.
11. Click **Sign out**. The page returns to the logged-out state.
12. Click **Sign in** again. This should **NOT** create a new user row — re-run the query from step 6 and confirm there's still exactly one row for that email, and `last_seen_at` has been updated to the current time.

## If anything fails

- Steps 1-5 fail: check Vercel env vars (`VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE`, `VITE_API_BASE_URL`) and Auth0 dashboard allowed-callback-URLs.
- Step 7 fails (no row): check Render logs for `[api/me]` errors. Most likely the API can't reach the DB (env `DATABASE_URL`) or the schema migration wasn't applied.
- Step 9 fails (no audit log row): `logUserAction` swallows errors and prints to stderr — check Render logs for `[logging] logUserAction failed:` lines.
- Step 10 returns anything other than 401: `requireAuth` middleware isn't wired correctly. Check `apps/api/src/index.ts` registers `registerMeRoutes(app)`.
- Step 12 creates a duplicate row: the upsert in `apps/api/src/routes/me.ts` is broken. Check the `onConflictDoNothing` clause and the `users.email` unique constraint.
