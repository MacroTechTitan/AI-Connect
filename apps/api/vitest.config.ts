import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Nothing here touches a database or the network: the
    // Build Control lifecycle is a pure transition table by design, so it is
    // exhaustively testable without Postgres.
    include: ["src/**/*.test.ts"],
    // *.integration.test.ts needs a real Postgres and a booted server. Those
    // live in vitest.integration.config.ts so `pnpm test` stays runnable with
    // no database at all — see docs/STAGING_DATABASE.md.
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
