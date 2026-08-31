import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workerEnv } from "./worker/claudeCodeAdapter.js";
import { reviewerEnv } from "./reviewer/claudeReviewer.js";

// Build Control spawns two child processes that run a model: the worker and
// the reviewer. Neither has any business inheriting the API's credentials, and
// "we filtered them" is worth nothing without a test that a real-looking
// environment actually comes out clean.
//
// Every value below is synthetic.

const SECRETS: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  MASTER_KEY: "a".repeat(64),
  DIAGNOSTICS_TOKEN: "b".repeat(48),
  AUTH0_ISSUER_BASE_URL: "https://tenant.us.auth0.com/",
  AUTH0_AUDIENCE: "https://api.example.com",
  STRIPE_SECRET_KEY: "sk_live_" + "c".repeat(24),
  STRIPE_WEBHOOK_SECRET: "whsec_" + "d".repeat(24),
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----x-----END RSA PRIVATE KEY-----",
  GITHUB_STATE_SIGNING_KEY: "e".repeat(64),
  CLOUDFLARE_API_TOKEN: "f".repeat(40),
  AICONNECT_RUNNER_WORKSPACE_ROOT: "/srv/repos",
  SOME_CLIENT_SECRET: "g".repeat(30),
  VENDOR_ACCESS_TOKEN: "h".repeat(30),
  DB_PASSWORD: "i".repeat(20),
  ENCRYPTION_KEY: "j".repeat(32),
};

const HARMLESS: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin",
  HOME: "/home/dev",
  LANG: "en_US.UTF-8",
  NODE_ENV: "development",
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries({ ...SECRETS, ...HARMLESS })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const BUILDERS: [string, () => NodeJS.ProcessEnv][] = [
  ["worker", workerEnv],
  ["reviewer", reviewerEnv],
];

for (const [name, build] of BUILDERS) {
  describe(`${name} child environment`, () => {
    it("passes through no secret VALUE at all", () => {
      const child = build();
      const serialized = JSON.stringify(child);
      for (const [key, value] of Object.entries(SECRETS)) {
        expect(serialized, `${key} leaked`).not.toContain(value);
      }
    });

    it("drops every secret-bearing NAME", () => {
      const child = build();
      for (const key of Object.keys(SECRETS)) {
        expect(child, key).not.toHaveProperty(key);
      }
    });

    it("drops the whole AICONNECT_ namespace", () => {
      // The runner's own configuration — workspace root, log dir, provider —
      // tells a model exactly what the supervision boundary is. It does not
      // need to know.
      const child = build();
      for (const key of Object.keys(child)) {
        expect(key.startsWith("AICONNECT_"), key).toBe(false);
      }
    });

    it("keeps the ordinary variables a process needs to run", () => {
      const child = build();
      expect(child.PATH).toBeTruthy();
      expect(child.HOME).toBe("/home/dev");
      expect(child.LANG).toBe("en_US.UTF-8");
    });

    it("passes ANTHROPIC_API_KEY through, and only that credential", () => {
      // The one credential the child legitimately needs, and only when the
      // machine is not using an interactive Claude login.
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-value";
      try {
        const child = build();
        expect(child.ANTHROPIC_API_KEY).toBe("sk-ant-test-value");
        // …and it did not drag anything else through with it.
        expect(child).not.toHaveProperty("STRIPE_SECRET_KEY");
        expect(child).not.toHaveProperty("MASTER_KEY");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it("catches secret-shaped names it was never explicitly told about", () => {
      process.env.SOME_NEW_VENDOR_SECRET = "zzzzzzzzzzzz";
      process.env.ANOTHER_THING_PASSWORD = "yyyyyyyyyyyy";
      try {
        const child = build();
        expect(child).not.toHaveProperty("SOME_NEW_VENDOR_SECRET");
        expect(child).not.toHaveProperty("ANOTHER_THING_PASSWORD");
      } finally {
        delete process.env.SOME_NEW_VENDOR_SECRET;
        delete process.env.ANOTHER_THING_PASSWORD;
      }
    });
  });
}

describe("both children are filtered the same way", () => {
  it("neither is more permissive than the other", () => {
    const workerKeys = new Set(Object.keys(workerEnv()));
    const reviewerKeys = new Set(Object.keys(reviewerEnv()));
    expect([...workerKeys].sort()).toEqual([...reviewerKeys].sort());
  });
});
