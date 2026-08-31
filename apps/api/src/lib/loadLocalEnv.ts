// Local-only .env loader.
//
// AI Connect has no dotenv dependency by design: on Render every value is
// injected by the platform, and lib/env.ts parses process.env at import time.
// That is the right production shape, but it left local development with no
// supported way to point the API at a database — every developer had to export
// DATABASE_URL by hand in every shell.
//
// This closes that gap without adding a dependency and without weakening
// production: it reads a gitignored .env file with Node's built-in
// process.loadEnvFile(), and it refuses to do anything when NODE_ENV is
// production. Existing process.env values always win, so an explicitly
// exported variable is never overwritten by a file.
//
// It MUST run before lib/env.ts is imported. Because ESM hoists imports, that
// means calling it from a module whose only static import is this one and then
// dynamically importing the real entry point — see src/devServer.ts.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// src/lib/ in dev (tsx) and dist/lib/ after tsc — the package root is two up
// from either.
const API_ROOT = resolve(HERE, "..", "..");

// First match wins. .env.staging.local is the documented home for the local
// staging database URL; .env.local is the general-purpose local override.
const CANDIDATES = [".env.staging.local", ".env.local", ".env"];

export interface LoadedEnv {
  file: string | null;
  reason?: string;
}

export function loadLocalEnv(): LoadedEnv {
  if (process.env.NODE_ENV === "production") {
    return { file: null, reason: "skipped: NODE_ENV=production" };
  }
  if (process.env.AICONNECT_SKIP_ENV_FILE) {
    return { file: null, reason: "skipped: AICONNECT_SKIP_ENV_FILE set" };
  }

  const explicit = process.env.AICONNECT_ENV_FILE;
  const names = explicit ? [explicit] : CANDIDATES;

  for (const name of names) {
    const path = resolve(API_ROOT, name);
    if (!existsSync(path)) continue;
    // Node's loader does not overwrite variables that are already set, so an
    // exported DATABASE_URL still beats the file.
    process.loadEnvFile(path);
    return { file: path };
  }

  return {
    file: null,
    reason: `no env file found (looked for ${names.join(", ")} in ${API_ROOT})`,
  };
}

export default loadLocalEnv;
