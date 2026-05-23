import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../lib/env.js";
import * as schema from "./schema.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;
let dbInstance: NodePgDatabase<typeof schema> | undefined;

// Lazy connect. Never called from /health — that route must remain DB-free.
// First call opens the pool; subsequent calls reuse it.
export function getDb(): NodePgDatabase<typeof schema> {
  if (dbInstance) return dbInstance;
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — cannot open database connection.",
    );
  }
  pool = new Pool({ connectionString: env.DATABASE_URL });
  dbInstance = drizzle(pool, { schema });
  return dbInstance;
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  // Force pool initialization through getDb so we keep one code path for connect.
  getDb();
  return pool!;
}
