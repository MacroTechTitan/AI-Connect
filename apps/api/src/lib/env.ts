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

  // Mobile auth broker (routes/mobileAuth.ts, docs/MOBILE_AUTH.md). Lets the
  // Life Hack Protocol mobile app authenticate WordPress/MemberPress users via
  // AI Connect, without the app ever touching WordPress. All optional so /health
  // and local mode boot without them; the login route fails with a clean 500 if
  // MOBILE_JWT_SIGNING_KEY or the site config is missing when first called.
  //
  // - MOBILE_JWT_SIGNING_KEY: HMAC secret for signing/verifying the tokens this
  //   broker issues to the app. A dedicated high-entropy secret — NOT reused
  //   from MASTER_KEY (vault AES key) or any other purpose. openssl rand -hex 32.
  // - LHP_SITE_URL: base URL of the target WordPress site.
  // - LHP_WP_TOKEN_SECRET_ID: Supabase Vault secret id (uuid) holding the
  //   ai-connect WordPress plugin token (X-AI-Connect-Token). The token value
  //   itself lives ONLY in Vault; this env var is just the pointer to it, mirroring
  //   how the integrations table stores vault_secret_id rather than the secret.
  MOBILE_JWT_SIGNING_KEY: z.string().min(32).optional(),
  LHP_SITE_URL: z.string().url().default("https://lifehackprotocol.com"),
  LHP_WP_TOKEN_SECRET_ID: z.string().uuid().optional(),

  // Sprint 7 — local vs cloud mode detection (lib/mode.ts). Either var flips
  // AI Connect into "local mode", enabling local-only integrations like
  // OpenClaw (which spawns maximus-bridge as a child process). Both unset =
  // cloud mode (the Render default), which refuses local-only operations.
  AICONNECT_LOCAL_MODE: z.string().optional(),
  OPENCLAW_BIN: z.string().optional(),
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
