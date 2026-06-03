# Changelog

All notable changes to AI Connect are documented here. Sprint-by-sprint, latest first.

This file is the public-facing version of `docs/sprints/SPRINT_LOG.md`. Methodology overhead and internal lessons live there; user-visible product changes live here.

---

## Sprint 2 — Bring-your-own-AI (2026-06-02)

**Shipped:** users can now connect their own AI provider API keys (Anthropic, OpenAI, Ollama) and route prompts through AI Connect with full audit trails and cost tracking.

### What's live

- Connect your own provider keys via the settings panel. Keys are encrypted at rest via Supabase Vault and never displayed back after entry.
- Three providers supported initially: Anthropic Claude (4.6/4.5/4.8 family), OpenAI (GPT-5 family), and Ollama (local LLM server).
- `POST /api/prompt` routes prompts to your configured providers and returns the AI response with full metadata: model used, input/output tokens, estimated USD cost, latency.
- `POST/GET/DELETE /api/keys` for managing your provider keys via API.
- Settings panel in the web UI: add/remove keys, see your defaults, send test prompts with live response + cost + latency.
- At-cost pass-through pricing: AI Connect does not mark up provider API calls. You pay providers directly via your own keys. AI Connect tracks costs as informational data — revenue comes from site access and features, not AI invocation margin.

### Privacy by default

- Prompt text is never persisted (only a SHA-256 fingerprint + length).
- Response text is never persisted (only a fingerprint + length; the response is returned to the caller but not stored).
- API key values never leave Supabase Vault. They are never logged, never returned in API responses, never displayed in the UI after entry.
- Every key event (add, remove) and every prompt invocation is logged structurally to the audit table.

### Out of scope (coming later)

- Multi-tenant org-level key sharing — Sprint 3-4
- Cost-aware routing rules ("send simple lookups to cheap models") — Sprint 6
- Streaming responses, conversation memory, tool use, image/audio inputs — deferred until there's user demand

---

## Sprint 0 — Phase 0 infrastructure (2026-05-24)

**Shipped:** monorepo scaffold, live API, live frontend, schema, logging, admin tooling, custom domains, secret-handling rules.

### Live in production
- API: `https://api.aiconnect.macrotechtitan.com/health`
- Frontend: `https://aiconnect.macrotechtitan.com`
- Both with valid SSL via Render + Vercel.

### What's in the code
- pnpm monorepo: `apps/api` (Express + TypeScript + Drizzle), `apps/web` (Vite + React), `packages/shared`.
- Drizzle schema with four tables: `users`, `system_logs`, `user_audit_logs`, `dev_logs` — with a CHECK constraint on log level, a foreign key from audit logs to users, and six indexes optimized for the read patterns MTTBuild Phase 0 calls out.
- Committed SQL migration in `apps/api/drizzle/` — never auto-applied; applied manually to the database per methodology.
- `lib/logging.ts` wrapper exposing `logSystem`, `logUserAction` (transactional across two tables with shared trace ID), and `logDev`. Logging errors are swallowed to stderr — logging can never break the calling code.
- Idempotent admin seed on boot. Safe to re-run.
- `GET /api/admin/diagnostics` behind bearer-token auth (SHA-256 + constant-time comparison). Returns boolean env presence and bounded DB reachability — never leaks secret values.
- `CLAUDE.md` with full project context, secret-handling rules, production state, and a deferred-services list.

### Infrastructure
- Render (Ohio, free plan): API service.
- Vercel (MacroTechTitan team): frontend.
- Supabase (us-east-2): Postgres via IPv4 session pooler.
- Auth0 (`macrotechtitandev.us.auth0.com`): SPA application + API audience configured.
- Cloudflare DNS for `macrotechtitan.com`: both subdomains routed DNS-only.

### Next
**Sprint 1** — Auth0 wiring + first authenticated route + minimal user dashboard. Targeted for June 2026.

---

*Last updated: 2026-06-02*
