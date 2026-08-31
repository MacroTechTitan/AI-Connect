import { describe, expect, it } from "vitest";

import { redact, redactDeep, REDACTED } from "./redact.js";

// The review payload carries a repository diff to a separate process and, for
// a hosted provider, a separate network. This is the last point at which we
// control what is disclosed.
//
// The values below are synthetic and structurally shaped like the real thing;
// none of them is a live credential.

describe("provider key shapes", () => {
  const cases: [string, string][] = [
    ["anthropic", "sk-ant-api03-" + "A".repeat(40)],
    ["openai", "sk-" + "B".repeat(32)],
    ["github", "ghp_" + "C".repeat(36)],
    ["stripe secret live", "sk_live_" + "D".repeat(24)],
    ["stripe secret test", "sk_test_" + "E".repeat(24)],
    ["stripe restricted", "rk_live_" + "F".repeat(24)],
    ["slack", "xoxb-1234567890-abcdefghij"],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
  ];

  for (const [name, value] of cases) {
    it(`redacts a ${name} key`, () => {
      const report = redact(`const key = "${value}";`);
      expect(report.text).not.toContain(value);
      expect(report.redacted).toBe(true);
    });
  }

  it("leaves a Stripe publishable key alone", () => {
    // pk_ keys are designed to be public and appear in client code.
    // Redacting them would make a diff less reviewable for no benefit.
    const line = 'const pk = "pk_test_' + "E".repeat(24) + '";';
    expect(redact(line).text).toBe(line);
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    expect(redact(`token: ${jwt}`).text).not.toContain(jwt);
  });

  it("redacts a private key block but keeps its shape visible", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nAAAABBBBCCCC\n-----END RSA PRIVATE KEY-----";
    const out = redact(pem).text;
    expect(out).not.toContain("AAAABBBBCCCC");
    expect(out).toContain("BEGIN PRIVATE KEY");
  });
});

describe("secret-named assignments", () => {
  it("hides the value and keeps the name", () => {
    // A reviewer should be able to see that a run touched a credential
    // without seeing the credential.
    const out = redact('DATABASE_PASSWORD="hunter2correct"').text;
    expect(out).toContain("DATABASE_PASSWORD");
    expect(out).not.toContain("hunter2correct");
    expect(out).toContain(REDACTED);
  });

  it("handles env, JSON and YAML shapes", () => {
    for (const line of [
      "API_KEY=abcdef123456",
      '"apiKey": "abcdef123456"',
      "client_secret: abcdef123456",
      "MASTER_KEY = abcdef123456",
    ]) {
      expect(redact(line).text, line).not.toContain("abcdef123456");
    }
  });

  it("leaves placeholders alone so a diff stays reviewable", () => {
    for (const line of [
      "API_KEY=",
      "API_KEY=${API_KEY}",
      "API_KEY=<your-key-here>",
      "API_KEY=changeme",
      "API_KEY=xxxxx",
      "ENABLE_AUTH=true",
    ]) {
      expect(redact(line).text, line).toBe(line);
    }
  });

  it("does not touch ordinary assignments", () => {
    const line = 'const timeout = "30000";';
    expect(redact(line).text).toBe(line);
    expect(redact(line).redacted).toBe(false);
  });
});

describe("connection strings", () => {
  it("removes the password but keeps the shape", () => {
    const out = redact("postgresql://user:s3cr3tpw@db.example.com:5432/app").text;
    expect(out).not.toContain("s3cr3tpw");
    // The reviewer can still tell a database URL is present and where it points.
    expect(out).toContain("postgresql://user:");
    expect(out).toContain("@db.example.com:5432/app");
  });

  it("covers the other common drivers", () => {
    for (const url of [
      "mysql://u:pw123456@h/db",
      "mongodb+srv://u:pw123456@h/db",
      "redis://u:pw123456@h:6379",
    ]) {
      expect(redact(url).text, url).not.toContain("pw123456");
    }
  });
});

describe("reporting", () => {
  it("counts what it hit without ever recording the value", () => {
    const report = redact(`A=${"sk-ant-api03-" + "Z".repeat(40)}\nB=ghp_${"Y".repeat(36)}`);
    expect(report.redacted).toBe(true);
    expect(Object.keys(report.counts).length).toBeGreaterThan(0);
    // The counts are what goes on the timeline; they must not carry values.
    expect(JSON.stringify(report.counts)).not.toContain("Z");
    expect(JSON.stringify(report.counts)).not.toContain("Y");
  });

  it("reports clean text as clean", () => {
    const report = redact("a perfectly ordinary diff line");
    expect(report.redacted).toBe(false);
    expect(report.counts).toEqual({});
  });
});

describe("redactDeep", () => {
  it("walks nested structures", () => {
    const { value, counts } = redactDeep({
      patch: 'API_KEY="abcdef123456"',
      files: ["a.ts"],
      nested: { deep: [{ url: "postgres://u:pw123456@h/db" }] },
      count: 3,
      flag: true,
      nothing: null,
    });
    expect(JSON.stringify(value)).not.toContain("abcdef123456");
    expect(JSON.stringify(value)).not.toContain("pw123456");
    // Non-strings survive unchanged.
    expect(value.count).toBe(3);
    expect(value.flag).toBe(true);
    expect(value.nothing).toBeNull();
    expect(value.files).toEqual(["a.ts"]);
    expect(Object.keys(counts).length).toBeGreaterThan(0);
  });
});
