-- Provider pricing seed — initial set of AI provider/model rates for cost display.
--
-- This file is MANUALLY applied to Supabase (via the SQL editor) — it is not
-- run by drizzle-kit, not part of the migration journal, and does not auto-apply
-- on deploy. Re-running is safe because every INSERT uses ON CONFLICT DO NOTHING
-- against the (provider, model, effective_from) unique constraint.
--
-- Pricing is updated by hand when models are added/deprecated or vendors change
-- public rates. When a price changes, INSERT a new row with a fresh effective_from
-- and (optionally) flip the old row's is_active to false rather than UPDATE in place
-- — the prompts table will keep referencing the historical model identifier and
-- /api/prompt's pricing lookup orders by effective_from DESC.
--
-- Each provider has exactly one is_default = true row. The /api/prompt model
-- resolver falls back to that default when the request body omits a model.
--
-- IMPORTANT: When updating this seed, also check the corresponding deprecation
-- status on each vendor's docs. Stale model IDs return 404 from the upstream API
-- and break /api/prompt silently from the user's perspective (just a provider error
-- bubbled through). Sprint 2 smoke test caught this — the original seed used
-- claude-3-5-sonnet-20241022 and gpt-4o which had been deprecated by mid-2026.
--
-- Rates and model IDs sourced 2026-06-02 from each vendor's public pricing page.

-- Anthropic (current models as of 2026-06-02 per platform.claude.com/docs/en/about-claude/pricing)
INSERT INTO provider_pricing
  (provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, context_window_tokens, is_default, is_active, effective_from)
VALUES
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 3.0000, 15.0000, 1000000, true,  true, now()),
  ('anthropic', 'claude-haiku-4-5',  'Claude Haiku 4.5',  1.0000,  5.0000,  200000, false, true, now()),
  ('anthropic', 'claude-opus-4-8',   'Claude Opus 4.8',   5.0000, 25.0000, 1000000, false, true, now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- OpenAI (current GPT-5 family as of 2026-06-02; verify on openai.com/pricing)
INSERT INTO provider_pricing
  (provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, context_window_tokens, is_default, is_active, effective_from)
VALUES
  ('openai', 'gpt-5',      'GPT-5',      5.0000, 20.0000, 400000, true,  true, now()),
  ('openai', 'gpt-5-mini', 'GPT-5 mini', 0.5000,  2.0000, 400000, false, true, now()),
  ('openai', 'gpt-4.1',    'GPT-4.1',    2.0000,  8.0000, 200000, false, true, now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- Ollama (local — no per-token cost; rows exist so the model dropdown / default
-- resolver have something to point at)
INSERT INTO provider_pricing
  (provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, context_window_tokens, is_default, is_active, effective_from)
VALUES
  ('ollama', 'llama3.2', 'Llama 3.2 (local)', 0.0000, 0.0000, 128000, true,  true, now()),
  ('ollama', 'llama3.1', 'Llama 3.1 (local)', 0.0000, 0.0000, 128000, false, true, now()),
  ('ollama', 'mistral',  'Mistral (local)',   0.0000, 0.0000,  32768, false, true, now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;
