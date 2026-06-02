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
-- Rates sourced 2026-05-26 from each vendor's public pricing page.

-- Anthropic
INSERT INTO provider_pricing
  (provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, context_window_tokens, is_default, is_active, effective_from)
VALUES
  ('anthropic', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet (2024-10-22)',  3.0000, 15.0000, 200000, true,  true, now()),
  ('anthropic', 'claude-3-5-haiku-20241022',  'Claude 3.5 Haiku (2024-10-22)',   0.8000,  4.0000, 200000, false, true, now()),
  ('anthropic', 'claude-3-opus-20240229',     'Claude 3 Opus',                  15.0000, 75.0000, 200000, false, true, now())
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- OpenAI
INSERT INTO provider_pricing
  (provider, model, display_name, input_per_1m_tokens_usd, output_per_1m_tokens_usd, context_window_tokens, is_default, is_active, effective_from)
VALUES
  ('openai', 'gpt-4o',      'GPT-4o',       2.5000, 10.0000, 128000, true,  true, now()),
  ('openai', 'gpt-4o-mini', 'GPT-4o mini',  0.1500,  0.6000, 128000, false, true, now()),
  ('openai', 'gpt-4-turbo', 'GPT-4 Turbo', 10.0000, 30.0000, 128000, false, true, now())
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
