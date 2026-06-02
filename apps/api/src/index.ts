import cors from "cors";
import express from "express";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { seedAdmin } from "./lib/seed.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerKeysRoutes } from "./routes/keys.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerPromptRoutes } from "./routes/prompt.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = [
  "https://aiconnect.macrotechtitan.com",
  "http://localhost:5173",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, server-to-server, mobile apps)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS: origin not allowed: " + origin), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// /health — MTTBuild Phase 0 contract:
// - returns 200 with no auth, no DB dependency
// - never blocks on anything that could be slow
// - used by Render's health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "ai-connect-api",
    version: process.env.npm_package_version ?? "0.0.0",
    timestamp: new Date().toISOString(),
  });
});

// /version — same as /health but with build metadata. Useful for confirming
// which commit is deployed without poking through Render's UI.
app.get("/version", (_req, res) => {
  res.status(200).json({
    service: "ai-connect-api",
    version: process.env.npm_package_version ?? "0.0.0",
    commit: process.env.RENDER_GIT_COMMIT ?? "unknown",
    branch: process.env.RENDER_GIT_BRANCH ?? "unknown",
  });
});

// Routes that need DB / auth get wired in Task 10.

// /api/admin/diagnostics — bearer-token-gated, does not touch /health or /version.
registerAdminRoutes(app);

// /api/me — Auth0 JWT-gated, lazily creates the user row on first login.
registerMeRoutes(app);

// /api/keys — Auth0 JWT-gated provider-key CRUD; secrets live in Supabase Vault.
registerKeysRoutes(app);

// /api/prompt — Auth0 JWT-gated; routes prompts to the user's provider key
// and logs every invocation with cost, tokens, and latency.
registerPromptRoutes(app);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Idempotent admin seed. Runs after routes are wired but before listen.
// Wrapped to never crash boot — /health must come up even if the DB is down.
try {
  await seedAdmin();
} catch (err) {
  process.stderr.write(
    `[boot] seedAdmin failed (continuing): ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
}

const port = env.PORT;
const host = "0.0.0.0"; // MTTBuild Phase 0: bind explicitly, never default.

app.listen(port, host, () => {
  logger.info({ port, host, nodeEnv: env.NODE_ENV }, "ai-connect-api listening");
});
