import { and, eq, type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, type PgTable } from "drizzle-orm/pg-core";

import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";

// The hydrated identity of a request. Built once per request by requireAuth
// (via getUserOrgContext) and attached to req.user. Every protected route
// reads userId + organizationId from here instead of doing its own DB lookup.
export interface AuthedUserContext {
  userId: string;
  organizationId: string | null;
  role: string;
  email: string;
}

// Any table in our schema that carries an organization_id column.
type OrgScopedTable = PgTable & { organizationId: AnyPgColumn };

// SQL fragment that matches rows belonging to ctx's organization. When ctx
// has no org (a backfill gap, or a brand new user on their first request),
// match rows whose organization_id is also NULL — that is, restrict to the
// caller's "orgless" scope rather than leaking everyone's orgless rows.
export function orgScopeFilter<T extends OrgScopedTable>(
  table: T,
  ctx: AuthedUserContext,
): SQL {
  if (ctx.organizationId === null) {
    return sql`${table.organizationId} IS NULL`;
  }
  return eq(table.organizationId, ctx.organizationId);
}

// Thin wrapper that exposes select/update/delete pre-bound to the org filter.
// Each method takes an optional extra WHERE that gets ANDed with the org
// filter, then returns the drizzle chain so the caller can keep chaining
// (.orderBy, .limit, .returning, .set, …). Inside a transaction, use
// orgScopeFilter() directly with the transaction's own chain.
//
// Typing note: drizzle 0.45's `.from(table)` chain has a conditional type
// that doesn't smoothly accept our intersected OrgScopedTable. The wrapper
// casts internally and exposes a loose Record-based API. For type-safe
// queries with full result-row inference, use orgScopeFilter inline with
// the normal db.select(...).from(...).where(and(orgScopeFilter(...), ...))
// chain.
export function withOrgScope<T extends OrgScopedTable>(
  table: T,
  ctx: AuthedUserContext,
) {
  const orgFilter = orgScopeFilter(table, ctx);
  const db = getDb();

  const combine = (extra?: SQL): SQL =>
    extra ? (and(orgFilter, extra) as SQL) : orgFilter;

  const baseTable = table as PgTable;

  return {
    select(projection: Record<string, unknown>, extra?: SQL) {
      return db
        .select(projection as never)
        .from(baseTable)
        .where(combine(extra));
    },
    update(values: Record<string, unknown>, extra?: SQL) {
      return db
        .update(baseTable)
        .set(values as never)
        .where(combine(extra));
    },
    delete(extra?: SQL) {
      return db.delete(baseTable).where(combine(extra));
    },
  };
}

// Defensive cross-check used in routes that fetch a row by id and then act
// on it. The fetch should already be org-scoped, but this catches the
// degenerate case where a future code change drops the scope and a row
// slips through. Throws — callers don't continue past this on failure.
export function assertOrgAccess(
  rowOrgId: string | null,
  ctx: AuthedUserContext,
): void {
  if (rowOrgId !== ctx.organizationId) {
    throw new Error(
      `org access violation: expected org ${ctx.organizationId ?? "<null>"}, got row org ${rowOrgId ?? "<null>"}`,
    );
  }
}

// Look up the hydrated context for an authenticated email. Returns null if
// the user row doesn't exist yet (first /api/me hit hasn't created it).
// Callers decide whether that's a 401 or a lazy-create.
export async function getUserOrgContext(
  email: string,
): Promise<AuthedUserContext | null> {
  const [row] = await getDb()
    .select({
      userId: users.id,
      organizationId: users.organizationId,
      role: users.role,
      email: users.email,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
}
