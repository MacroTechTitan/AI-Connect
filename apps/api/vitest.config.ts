import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only. Nothing here touches a database or the network: the
    // Build Control lifecycle is a pure transition table by design, so it is
    // exhaustively testable without Postgres.
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
