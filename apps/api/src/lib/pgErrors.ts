// Postgres error classification.
//
// drizzle-orm 0.45 wraps every failed query in a `DrizzleQueryError` and hangs
// the original node-postgres `DatabaseError` off `.cause`. The wrapper carries
// no `code`, so the obvious `err.code === "23505"` check — which this codebase
// hand-rolled in five routes — silently stopped matching and turned every
// intended 409 into an unhandled 500.
//
// Walking the cause chain rather than checking one level deep keeps this
// correct whether the driver wraps, double-wraps, or stops wrapping again in a
// future release.

// https://www.postgresql.org/docs/current/errcodes-appendix.html
export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";

const MAX_CAUSE_DEPTH = 8;

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Finds the first error in the cause chain that carries a Postgres SQLSTATE.
 * Returns undefined when the error did not originate in the driver.
 */
export function findPgError(err: unknown): PgErrorShape | undefined {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    const candidate = current as PgErrorShape & { cause?: unknown };
    if (typeof candidate.code === "string") return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/** The SQLSTATE of the underlying Postgres error, if there is one. */
export function pgErrorCode(err: unknown): string | undefined {
  const pg = findPgError(err);
  return typeof pg?.code === "string" ? pg.code : undefined;
}

/**
 * True when `err` is a unique_violation. Pass `constraint` to also require a
 * specific index/constraint name, so an unrelated collision in the same
 * transaction is not mistaken for the one being handled.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = findPgError(err);
  if (pg?.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  return pg.constraint === constraint;
}
