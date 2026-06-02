import { sql } from "drizzle-orm";
import { getDb } from "../db/client.js";

// Wraps Supabase Vault. The actual secret value lives in vault.secrets
// (encrypted by Vault); our application tables hold only the UUID reference.
// Never log, never echo, never include secret values in error messages.

export async function createSecret(
  name: string,
  secret: string,
  description?: string,
): Promise<string> {
  const result = await getDb().execute(
    sql`select vault.create_secret(${secret}, ${name}, ${description ?? null}) as id`,
  );
  const row = result.rows[0] as { id?: string } | undefined;
  if (!row?.id) {
    throw new Error("vault.create_secret returned no id");
  }
  return row.id;
}

export async function getSecret(secretId: string): Promise<string> {
  const result = await getDb().execute(
    sql`select decrypted_secret from vault.decrypted_secrets where id = ${secretId}::uuid`,
  );
  const row = result.rows[0] as { decrypted_secret?: string } | undefined;
  if (!row || typeof row.decrypted_secret !== "string") {
    throw new Error(`vault secret not found for id ${secretId}`);
  }
  return row.decrypted_secret;
}

export async function updateSecret(
  secretId: string,
  newSecret: string,
): Promise<void> {
  await getDb().execute(
    sql`select vault.update_secret(${secretId}::uuid, ${newSecret})`,
  );
}

export async function deleteSecret(secretId: string): Promise<void> {
  // Idempotent: row may already be gone if Vault and our table diverged.
  await getDb().execute(
    sql`delete from vault.secrets where id = ${secretId}::uuid`,
  );
}
