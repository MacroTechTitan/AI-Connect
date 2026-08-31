import { describe, expect, it } from "vitest";

import {
  findPgError,
  isUniqueViolation,
  pgErrorCode,
  PG_UNIQUE_VIOLATION,
} from "./pgErrors.js";

// Shaped like node-postgres' DatabaseError.
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error("db"), { code, constraint });
}

// Shaped like drizzle-orm 0.45's DrizzleQueryError: no code of its own, the
// driver error on `cause`. This is the wrapper that broke the hand-rolled
// one-level checks in the route handlers.
function drizzleWrap(cause: unknown): Error {
  return Object.assign(new Error("Failed query: insert into ..."), { cause });
}

describe("pgErrors", () => {
  it("recognizes a bare driver error", () => {
    expect(isUniqueViolation(pgError(PG_UNIQUE_VIOLATION))).toBe(true);
  });

  it("recognizes a driver error wrapped by drizzle", () => {
    expect(isUniqueViolation(drizzleWrap(pgError(PG_UNIQUE_VIOLATION)))).toBe(true);
  });

  it("recognizes a doubly-wrapped driver error", () => {
    const err = drizzleWrap(drizzleWrap(pgError(PG_UNIQUE_VIOLATION)));
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("matches on constraint name when one is required", () => {
    const err = drizzleWrap(pgError(PG_UNIQUE_VIOLATION, "build_runs_one_active_per_project_idx"));
    expect(isUniqueViolation(err, "build_runs_one_active_per_project_idx")).toBe(true);
  });

  it("rejects a unique violation raised by a different constraint", () => {
    const err = drizzleWrap(pgError(PG_UNIQUE_VIOLATION, "users_email_unique"));
    expect(isUniqueViolation(err, "build_runs_one_active_per_project_idx")).toBe(false);
  });

  it("rejects other SQLSTATEs", () => {
    expect(isUniqueViolation(drizzleWrap(pgError("23503")))).toBe(false);
  });

  it("rejects non-database errors", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  it("does not loop forever on a self-referential cause chain", () => {
    const err: Record<string, unknown> = { message: "cyclic" };
    err.cause = err;
    expect(isUniqueViolation(err)).toBe(false);
    expect(findPgError(err)).toBeUndefined();
  });

  it("exposes the underlying SQLSTATE", () => {
    expect(pgErrorCode(drizzleWrap(pgError("23514")))).toBe("23514");
    expect(pgErrorCode(new Error("boom"))).toBeUndefined();
  });
});
