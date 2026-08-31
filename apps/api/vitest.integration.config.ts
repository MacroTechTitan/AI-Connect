import { defineConfig } from "vitest/config";

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
