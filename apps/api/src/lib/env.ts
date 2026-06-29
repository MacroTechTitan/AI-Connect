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

  // Stripe — test mode in Sprint 0. No products yet, just env wiring.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

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
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
