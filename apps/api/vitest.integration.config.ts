import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

import { loadLocalEnv } from "./src/lib/loadLocalEnv.js";

// Load the gitignored .env file HERE, in the vitest process, so DATABASE_URL
// reaches the workers through `test.env` below. It cannot be left to the test
// harness: lib/env.ts parses process.env at import time, and a test file whose
// static imports reach env.ts would parse it before any beforeAll hook runs.
loadLocalEnv();

// Integration tests. Unlike vitest.config.ts (pure unit tests, no I/O), these
// boot the real Express app against a real Postgres — the local staging
// database from docs/STAGING_DATABASE.md.
//
//   pnpm staging:db:up && pnpm db:migrate && pnpm test:integration
//
// They are a separate config, not a separate glob in the unit config, so
// `pnpm test` stays fast, hermetic, and runnable with no database at all.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Runner configuration for the tests that exercise it. Note what is NOT
    // here: AICONNECT_RUNNER_ENABLED. The real Claude Code worker therefore
    // reports itself unavailable and `start` dispatches nothing, exactly as on
    // a cloud instance — so no test in this suite can spawn a real process or
    // spend real money. The runner tests register a fake worker instead.
    //
    // The one test that drives real Claude Code is deliberately NOT a vitest
    // test: it costs money and needs a Claude login, so it lives in
    // scripts/runnerLiveSmoke.ts behind `pnpm smoke:runner`.
    env: {
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      AICONNECT_RUNNER_WORKSPACE_ROOT: resolve(tmpdir(), "ai-connect-runner-tests"),
      AICONNECT_RUNNER_LOG_DIR: resolve(tmpdir(), "ai-connect-runner-logs"),
    },
    environment: "node",
    // One shared server + database per run: the suites seed and tear down
    // their own organizations, and parallel forks would fight over the
    // one-active-run-per-project index.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
  },
});
