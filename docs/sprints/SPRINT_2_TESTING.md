# Sprint 2 — manual smoke test

Run this end-to-end after Sprint 2 merges to master and the deploy goes green. The goal is to confirm the BYOAI flow works in production: schema migration applied → pricing seeded → key added via the UI → secret encrypted in Vault → prompt routed to the provider → cost/tokens/latency logged → error path returns a usable provider message → keys can be cleanly removed.

Prerequisites:
- A valid Anthropic API key you can paste once and revoke afterwards (you should rotate it after the smoke test regardless).
- Access to the Supabase SQL editor for the `ai-connect-prod` project.
- Already-working Sprint 1 auth — you must be able to sign in to `https://aiconnect.macrotechtitan.com` before starting.

## Procedure

1. **Apply the Sprint 2 schema migration.** Open `apps/api/drizzle/0001_bizarre_shinko_yamashiro.sql` and paste its contents into the Supabase SQL editor. Run it. This was already done manually during Commit 1 review; if you're re-verifying, re-running is idempotent (every CREATE TABLE is `IF NOT EXISTS`, every ALTER … DISABLE ROW LEVEL SECURITY is idempotent, the foreign keys use a `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN null` guard).

2. **Apply the pricing seed.** Open `apps/api/drizzle/seeds/0001_provider_pricing.sql` and paste into the SQL editor. Run it. Every INSERT uses `ON CONFLICT (provider, model, effective_from) DO NOTHING`, so re-running is safe.

3. **Verify the pricing rows exist.** In the SQL editor:
   ```sql
   SELECT provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, is_default
   FROM provider_pricing
   WHERE is_active = true
   ORDER BY provider, model;
   ```
   Expect 9 rows: 3 anthropic, 3 openai, 3 ollama. Each provider should have exactly one row with `is_default = true`.

4. **Sign in and open settings.** Go to `https://aiconnect.macrotechtitan.com`, click **Sign in**, complete the Auth0 flow. After the redirect back, the status block should show `Signed in as <your email>`. Click **Manage provider keys**. The settings section should appear with "Provider keys" and "Test a prompt" subsections. The keys list should say "No keys yet. Add one below."

5. **Add the Anthropic key.** In the add form: select provider = **Anthropic**, label = `Smoke test Claude`, key = `<paste a real Anthropic API key>`. Click **Add key**. The form should clear, no error should appear, and the new row should show up in the keys list above.

6. **Verify the default badge.** The new row should read `Anthropic  Smoke test Claude  default` — the badge appears because it's the user's first Anthropic key.

7. **Verify the row landed in `provider_keys`.** In the SQL editor:
   ```sql
   SELECT id, user_id, provider, label, is_default, created_at, last_used_at, last_validated_at
   FROM provider_keys
   WHERE label = 'Smoke test Claude';
   ```
   Expect 1 row, `provider = 'anthropic'`, `is_default = true`, `last_used_at` and `last_validated_at` both still null.

8. **Verify the secret is encrypted in Vault.**
   ```sql
   SELECT id, name, decrypted_secret
   FROM vault.decrypted_secrets
   WHERE name LIKE '%Smoke test Claude%';
   ```
   Expect 1 row. `decrypted_secret` should match exactly what you pasted in step 5. `name` should look like `ai-connect:user:<uuid>:provider:anthropic:key:Smoke_test_Claude` (label sanitized — spaces become underscores). The `id` here is the `vault_secret_id` referenced by the row from step 7 (you'd join via the application; we don't expose the column in /api/keys).

9. **Send a test prompt.** Back in the UI, in the "Test a prompt" textarea: type `What is 2+2?`. Click **Send**. After a couple seconds the result block should render with the model response, a meta row showing `model: claude-3-5-sonnet-20241022`, token counts (`tokens: ~10 in / ~10 out`, depending on the model's reply), `cost: $0.0001` or thereabouts, and `latency: <some ms>`.

10. **Verify the response shape.** No error banner. Cost is non-zero (since Anthropic isn't free). Latency is a positive integer.

11. **Verify the prompts row.**
    ```sql
    SELECT id, provider, model, input_tokens, output_tokens, estimated_cost_usd, status, latency_ms,
           prompt_text_fingerprint, response_text_fingerprint
    FROM prompts
    ORDER BY created_at DESC
    LIMIT 1;
    ```
    Expect 1 row: `provider = 'anthropic'`, `model = 'claude-3-5-sonnet-20241022'`, both token counts > 0, `estimated_cost_usd` matches what the UI showed (to 6 decimal places), `status = 'success'`, `latency_ms` matches, fingerprints are 64-character hex strings. The prompt and response text themselves are NOT stored — only their SHA-256 fingerprints + lengths.

12. **Verify the audit log.**
    ```sql
    SELECT action, target_type, target_id, context, occurred_at
    FROM user_audit_logs
    WHERE action = 'invoke_prompt'
    ORDER BY occurred_at DESC
    LIMIT 1;
    ```
    Expect 1 row, `target_type = 'prompt'`, `target_id` matches the `id` from step 11, `context` includes `{provider, model, status: "success", cost}`.

13. **Verify `last_used_at` and `last_validated_at` got bumped.** Re-run the query from step 7. Both timestamps should now be populated and close to the current time. `last_validated_at` proves the key actually worked end-to-end (not just that we tried it).

14. **Test the error path.** Add a second key: provider = **Anthropic**, label = `Smoke test bad key`, key = `sk-ant-invalid-deadbeef`. The first key stays the default, so to exercise the failure: delete the good key (Remove button), which promotes the bad key to default. Send another prompt. Expect a red error block with a message similar to `Anthropic rejected the API key — verify it at https://console.anthropic.com/settings/keys`, plus a `code: http_401` line and `latency: <ms>` line. Verify the failure was logged:
    ```sql
    SELECT id, provider, model, status, error_code, latency_ms
    FROM prompts
    ORDER BY created_at DESC
    LIMIT 1;
    ```
    Expect `status = 'error'`, `error_code = 'http_401'`, `latency_ms` populated, tokens/cost/response fingerprint columns all NULL.

15. **Verify `last_used_at` bumped but `last_validated_at` did NOT.** Re-run the query from step 7 against the bad key. `last_used_at` should be fresh (we did make the attempt), `last_validated_at` should still be null (it was never set on this row — we only set it on success).

16. **Delete both test keys.** Click **Remove** on the remaining bad key in the UI. Confirm the keys list goes back to "No keys yet. Add one below." Verify everything is cleaned up:
    ```sql
    SELECT count(*) FROM provider_keys WHERE label LIKE 'Smoke test%';   -- expect 0
    SELECT count(*) FROM vault.decrypted_secrets WHERE name LIKE '%Smoke test%';   -- expect 0
    SELECT action, target_type FROM user_audit_logs
      WHERE action IN ('add_provider_key', 'remove_provider_key')
      ORDER BY occurred_at DESC LIMIT 6;
    ```
    The audit log query should show the full add/remove history (2 adds + 2 removes for the two test keys, possibly interleaved with `invoke_prompt` entries from earlier in this run).

17. **Sanity-check `/api/prompt` still rejects an unauthenticated request.** From a terminal:
    ```bash
    curl -i https://api.aiconnect.macrotechtitan.com/api/prompt
    ```
    Expect HTTP 401 with `{"error":"unauthorized","reason":"missing_bearer_token"}`.

18. **Rotate the Anthropic API key you used.** Even though we never echoed it in logs, error messages, or the UI, you exposed it to a clipboard and to your local machine. Rotate it in the Anthropic console.

## If anything fails

- **Step 3 returns 0 rows**: the seed didn't run, or it hit the ON CONFLICT path against pre-existing rows. Re-paste and re-run; if it still returns 0, check the unique constraint with `\d provider_pricing` and confirm `provider_pricing_provider_model_effective_from_unique` exists.
- **Step 5 errors with `invalid_provider` / `invalid_label` / `missing_key`**: the form validation in `apps/api/src/routes/keys.ts` rejected the payload. The browser dev-tools network tab will show the request body — compare against the validation in `handleAddKey`.
- **Step 5 errors with a 500**: most likely Vault isn't enabled in the Supabase project. From the Supabase dashboard → Database → Extensions, confirm `supabase_vault` is on. The Render logs (`/api/admin/diagnostics` or the Render UI) will have the error.
- **Step 8 returns 0 rows**: Vault write didn't happen. Check the Render logs for an error in `vault.createSecret`. If the row exists in `provider_keys` but not in `vault.decrypted_secrets`, that's a Sprint 2 invariant violation — file an issue and revert per MTTBuild §1.2.
- **Step 9 errors with `no_default_model`**: the pricing seed (step 2) wasn't applied. Re-run it.
- **Step 9 returns a 502 with a real Anthropic error**: the API key you pasted is bad or has been revoked. Use a different one.
- **Step 11 shows tokens/cost as NULL on a successful call**: the provider's response was missing its `usage` block. Open the prompt row's `error_message` (it should still be empty if status='success'). Investigate via `apps/api/src/lib/providers/anthropic.ts` — the success path falls back to null tokens when usage is missing, but this should not happen for normal Claude calls.
- **Step 14's error message is a generic 502 not the friendly text**: `friendlyMessage` in `anthropic.ts` didn't trigger. Check the actual HTTP status code on the network tab — if it's not 401/429/5xx, our friendly mapping doesn't cover it and we fall through to the provider's raw message.
- **Step 16's last query shows orphaned Vault rows**: `vault.deleteSecret` is best-effort in `apps/api/src/routes/keys.ts`. If you see orphans, manually clean them with `DELETE FROM vault.secrets WHERE name LIKE '%Smoke test%'` and file an issue — the best-effort delete should normally succeed.
