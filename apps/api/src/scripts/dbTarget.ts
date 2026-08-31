// Shared non-production guard for scripts that write to a database.
//
// Nothing in this repository should ever be able to point a developer's
// keyboard at the production Supabase project by accident. Both the migration
// runner and the Build Control smoke script route their DATABASE_URL through
// here first.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface DbTarget {
  host: string;
  port: string;
  database: string;
  user: string;
  isLocal: boolean;
  /** The exact value DB_MIGRATE_ACK_TARGET must carry to allow a remote host. */
  ackValue: string;
}

export function describeTarget(url: string): DbTarget {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, "") || "(default)";
  return {
    host,
    port: parsed.port || "5432",
    database,
    user: parsed.username || "(default)",
    isLocal: LOCAL_HOSTS.has(host),
    ackValue: `${host}/${database}`,
  };
}

/**
 * Throws unless the configured DATABASE_URL can be shown to be a
 * non-production target. Returns the parsed target on success.
 */
export function requireNonProductionTarget(url: string | undefined): DbTarget {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NODE_ENV=production — this script never targets production.");
  }
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a staging database — see docs/STAGING_DATABASE.md.",
    );
  }

  let target: DbTarget;
  try {
    target = describeTarget(url);
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL.");
  }

  if (!target.isLocal && process.env.DB_MIGRATE_ACK_TARGET !== target.ackValue) {
    throw new Error(
      `host '${target.host}' is not local, so this script cannot verify it is not ` +
        `production.\nIf this really is a non-production database, re-run with:\n` +
        `  DB_MIGRATE_ACK_TARGET="${target.ackValue}"`,
    );
  }

  return target;
}
