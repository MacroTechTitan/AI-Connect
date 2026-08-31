import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),

  // DB — only validated as a string here. Connection happens in src/db/client.ts
  // and only when a route actually needs the DB. /health must remain DB-free.
  DATABASE_URL: z.string().url().optional(),

  // Auth0 — required in production, optional in dev so /health can run alone.
  AUTH0_ISSUER_BASE_URL: z.string().url().optional(),
  AUTH0_AUDIENCE: z.string().optional(),

  // Stripe — Sprint 9 wires the paid tier + Connect connector. Required in
  // production, optional in dev so /health (and local mode) boot without them.
  // See lib/integrations/stripeClient.ts — the SDK is lazily instantiated and
  // only throws on first use if STRIPE_SECRET_KEY is missing.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // The Stripe Price ID for the $49/mo Pro tier. Created manually in the
  // Stripe Dashboard, not by AI Connect. Read by the subscription checkout route.
  STRIPE_PRO_PRICE_ID: z.string().optional(),

  // GitHub App — Sprint 10 ships the single ai-connect-app GitHub App users
  // install on their own org so Project Genesis can create repos there. Required
  // in production, optional in dev. See lib/integrations/githubClient.ts — the
  // App is lazily instantiated and only throws on first use if unset.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  // Multi-line PEM. Env vars often carry literal "\n"; githubClient normalizes
  // them to real newlines before signing.
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  // HMAC key for signing the GitHub install-flow state parameter (CSRF
  // protection — see lib/integrations/githubOAuthState.ts). A dedicated
  // high-entropy secret; deliberately NOT reusing MASTER_KEY (the vault AES
  // key) for a second cryptographic purpose. Optional in dev, required in
  // prod. Generate with openssl rand -hex 32.
  GITHUB_STATE_SIGNING_KEY: z.string().optional(),

  // Sprint 2 placeholder. 32-byte hex string. Generate with openssl rand -hex 32.
  MASTER_KEY: z.string().length(64).optional(),

  // Sprint 0 — admin diagnostics endpoint bearer token.
  // Bypasses Auth0 by design so logs are reachable when Auth0 is broken.
  DIAGNOSTICS_TOKEN: z.string().min(32).optional(),

  // Sprint 5 — Cloudflare DNS for Project Genesis subdomains. These are
  // AI-Connect-level credentials (not per-user platform credentials): AI
  // Connect owns the domain and provisions one CNAME per project. Read only
  // by lib/platforms/cloudflare.ts. Optional so /health boots without them.
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_BASE_DOMAIN: z.string().optional(),

  // Admin seed — written by lib/seed.ts on boot.
  ADMIN_EMAIL: z.string().email().default("jgelet@macrotechtitan.com"),

  // Sprint 7 — local vs cloud mode detection (lib/mode.ts). Either var flips
  // AI Connect into "local mode", enabling local-only integrations like
  // OpenClaw (which spawns maximus-bridge as a child process). Both unset =
  // cloud mode (the Render default), which refuses local-only operations.
  AICONNECT_LOCAL_MODE: z.string().optional(),
  OPENCLAW_BIN: z.string().optional(),

  // DevOS Agentic Build Control runner (lib/buildControl/worker/). Dispatching
  // a build run spawns a Claude Code process on the host, so the runner is OFF
  // unless BOTH of the first two are set: an API instance that is not meant to
  // execute anything must never be one flag away from doing so. On Render both
  // are unset and `start` behaves exactly as it did before the runner existed.
  AICONNECT_RUNNER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  // The ONLY directory tree a worker may be dispatched into. Every workspace
  // is resolved through realpath and must land inside it — see
  // lib/buildControl/worker/workspace.ts.
  AICONNECT_RUNNER_WORKSPACE_ROOT: z.string().optional(),
  // Claude Code executable. Overridable so a pinned or wrapped binary can be
  // used without changing code.
  CLAUDE_CODE_BIN: z.string().optional(),
  // Where raw worker transcripts are written. Kept OUT of the repository the
  // worker is editing, so a transcript never lands in the run's own diff.
  AICONNECT_RUNNER_LOG_DIR: z.string().optional(),
  // Hard ceiling on one dispatch. A worker that blows through it is terminated
  // and the run FAILS — supervision means no unbounded process.
  AICONNECT_RUNNER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  // Optional model override passed to the worker.
  AICONNECT_RUNNER_MODEL: z.string().optional(),
  // Optional JSON allow-list of selectable workspaces, key -> path (relative
  // to the root) or key -> {path, projects, description}. When set it is an
  // ALLOW-LIST: only these keys are selectable, so dropping a repository under
  // the root does not silently make it dispatchable. When unset, any git
  // repository directly beneath the root is selectable by directory name.
  // See lib/buildControl/worker/workspaceRegistry.ts.
  AICONNECT_RUNNER_WORKSPACES: z.string().optional(),

  // Independent reviewer (lib/buildControl/reviewer/). Separate from the
  // worker on purpose: the thing that did the work must never be the thing
  // that judges it. Provider-neutral — this names which adapter to use.
  AICONNECT_REVIEWER_PROVIDER: z.string().optional(),
  AICONNECT_REVIEWER_MODEL: z.string().optional(),
  // Hard ceiling on one review. A reviewer that blows through it fails the
  // review; it never silently leaves a run sitting in REVIEWING.
  AICONNECT_REVIEWER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  // Comma-separated workspace-relative files whose contents are included in
  // the review payload as architecture/policy context (e.g.
  // "CLAUDE.md,docs/MTTBuild.md"). Read-only, size-capped, and redacted like
  // everything else in the payload.
  AICONNECT_REVIEWER_CONTEXT_FILES: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
