import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTIVE_STATES,
  BUILD_RUN_STATES,
  RELEASE_STATUSES,
  REVIEW_VERDICTS,
  TERMINAL_STATES,
} from "../lib/buildControl/stateMachine.js";

// schema.ts cannot import the state machine: drizzle-kit 0.28.1 loads schema
// files through a CJS require that cannot resolve a NodeNext "./x.js"
// specifier from a sibling file, and a cross-file import made db:generate emit
// no migration at all while still exiting 0.
//
// The CHECK constraints and the partial index therefore repeat the state
// vocabulary as SQL string literals. These tests are what stop the two copies
// drifting apart — a drift would let the API write a state the database
// rejects, or leave a state permanently occupying the one-active-run slot.

const here = dirname(fileURLToPath(import.meta.url));
const schemaSource = readFileSync(join(here, "schema.ts"), "utf8");

function literalsIn(pattern: RegExp): string[] {
  const match = schemaSource.match(pattern);
  if (!match?.[1]) {
    throw new Error(`could not locate SQL literal list for ${pattern}`);
  }
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
}

describe("build_runs state CHECK constraint", () => {
  it("lists exactly the states the state machine knows", () => {
    const inSql = literalsIn(
      /build_runs_state_check[\s\S]*?state\} IN \(([^)]*)\)/,
    );
    expect([...inSql].sort()).toEqual([...BUILD_RUN_STATES].sort());
  });
});

describe("build_runs release status CHECK constraint", () => {
  it("lists exactly the release statuses the state machine knows", () => {
    const inSql = literalsIn(
      /build_runs_release_status_check[\s\S]*?releaseStatus\} IN \(([^)]*)\)/,
    );
    expect([...inSql].sort()).toEqual([...RELEASE_STATUSES].sort());
  });
});

describe("build_reviews verdict CHECK constraint", () => {
  it("lists exactly the verdicts the state machine knows", () => {
    const inSql = literalsIn(
      /build_reviews_verdict_check[\s\S]*?verdict\} IN \(([^)]*)\)/,
    );
    expect([...inSql].sort()).toEqual([...REVIEW_VERDICTS].sort());
  });
});

describe("one-active-run-per-project partial index", () => {
  it("covers exactly the active states, and no terminal state", () => {
    const inSql = literalsIn(
      /build_runs_one_active_per_project_idx[\s\S]*?state\} IN \(([^)]*)\)/,
    );
    expect([...inSql].sort()).toEqual([...ACTIVE_STATES].sort());

    // The consequence worth stating explicitly: if a terminal state leaked
    // into this index, ending a run would permanently block its project.
    for (const terminal of TERMINAL_STATES) {
      expect(inSql, `${terminal} must not occupy the active slot`).not.toContain(
        terminal,
      );
    }
  });
});

describe("generated migration", () => {
  // The migration is what actually reaches Postgres. Regenerating the schema
  // without regenerating the migration is a silent way for the two to diverge.
  const migration = readFileSync(
    join(here, "..", "..", "drizzle", "0016_same_lady_bullseye.sql"),
    "utf8",
  );

  it("creates all four Build Control tables", () => {
    for (const table of [
      "build_runs",
      "build_events",
      "build_reviews",
      "build_approvals",
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it("carries the full state vocabulary into the database constraint", () => {
    for (const state of BUILD_RUN_STATES) {
      expect(migration, `${state} missing from migration CHECK`).toContain(
        `'${state}'`,
      );
    }
  });

  it("is additive only — it drops and alters nothing that already exists", () => {
    // Build Control is new surface. A DROP or a column ALTER in this migration
    // would mean it is touching pre-existing tables, which is a review gate.
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE[\s\S]*?ALTER\s+COLUMN/i);
  });

  it("stores diff statistics as integers and cost as numeric", () => {
    // These were text in the first draft of the schema; counts and money are
    // not strings, and fixing it after the migration shipped would need a
    // second migration with a cast.
    expect(migration).toMatch(/"additions" integer/);
    expect(migration).toMatch(/"deletions" integer/);
    expect(migration).toMatch(/"cost_usd" numeric\(10, 6\)/);
  });
});
