// Apply generated Drizzle migrations to a NON-PRODUCTION database.
//
// MTTBuild forbids auto-applying schema migrations. This script does not
// change that: migrations are still generated, committed and reviewed first.
// What it adds is a repeatable, guarded way to apply the reviewed SQL to a
// staging/dev database so a schema can be exercised before it ever reaches
// production.
//
//   pnpm db:migrate            (root)
//   pnpm --filter @ai-connect/api db:migrate
//
// Safety model — see scripts/dbTarget.ts:
//
//   NODE_ENV=production          -> always refused.
//   host localhost/127.0.0.1     -> allowed (the docker staging DB).
//   any other host               -> refused unless DB_MIGRATE_ACK_TARGET is
//                                   set to the exact "host/database" targeted.
//
// History note: production's schema (migrations 0000-0015) was applied by
// other means, before this script existed. Drizzle's __drizzle_migrations
// bookkeeping table therefore does not exist there, and pointing this script
// at production would try to replay 0000 onward. That is what the guard is for.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { loadLocalEnv } from "../lib/loadLocalEnv.js";
import { requireNonProductionTarget, type DbTarget } from "./dbTarget.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const MIGRATIONS_FOLDER = resolve(API_ROOT, "drizzle");

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function fail(message: string): never {
  process.stderr.write("\n  migrate: REFUSED — " + message + "\n\n");
  process.exit(1);
}

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

async function main(): Promise<void> {
  const loaded = loadLocalEnv();
  out(loaded.file ? "env file: " + loaded.file : "env file: none (" + loaded.reason + ")");

  const url = process.env.DATABASE_URL;
  let target: DbTarget;
  try {
    target = requireNonProductionTarget(url);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  out("");
  out("  target host     : " + target.host + ":" + target.port);
  out("  target database : " + target.database);
  out("  target user     : " + target.user);
  out("  classification  : " + (target.isLocal ? "LOCAL" : "REMOTE"));
  if (!target.isLocal) out("  acknowledged    : " + target.ackValue);
  out("");

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    const before = await db.execute(
      sql`SELECT current_database() AS db,
                 (SELECT count(*)::int FROM information_schema.tables
                   WHERE table_schema = 'public') AS tables`,
    );
    const beforeRow = before.rows[0] as { db: string; tables: number };
    out(
      "  connected to '" + beforeRow.db + "' — " + beforeRow.tables +
        " table(s) in public before migrating",
    );

    const tags = journalTags();
    out("");
    out(
      "  applying " + tags.length + " migration(s): " + tags[0] + " .. " +
        tags[tags.length - 1],
    );

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const after = await db.execute(
      sql`SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS applied,
                 (SELECT count(*)::int FROM information_schema.tables
                   WHERE table_schema = 'public') AS tables`,
    );
    const afterRow = after.rows[0] as { applied: number; tables: number };
    out("");
    out(
      "  done — " + afterRow.applied + " migration(s) recorded, " +
        afterRow.tables + " table(s) in public",
    );
    out("");
  } finally {
    await pool.end();
  }
}

await main();
