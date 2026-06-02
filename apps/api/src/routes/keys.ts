import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { getDb } from "../db/client.js";
import { providerKeys, users } from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import * as vault from "../lib/vault.js";
import { requireAuth } from "../middleware/requireAuth.js";

type Provider = "anthropic" | "openai" | "ollama";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const keyProjection = {
  id: providerKeys.id,
  provider: providerKeys.provider,
  label: providerKeys.label,
  isDefault: providerKeys.isDefault,
  createdAt: providerKeys.createdAt,
  lastUsedAt: providerKeys.lastUsedAt,
  lastValidatedAt: providerKeys.lastValidatedAt,
} as const;

// Label characters that are safe inside a Vault secret name.
function sanitizeLabelForVaultName(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function vaultSecretName(
  userId: string,
  provider: Provider,
  label: string,
): string {
  return `ai-connect:user:${userId}:provider:${provider}:key:${sanitizeLabelForVaultName(label)}`;
}

// Resolve the authenticated user's row id. Writes the failure response and
// returns null when the caller should stop.
async function resolveUserId(
  req: Request,
  res: Response,
): Promise<string | null> {
  const auth = req.user;
  if (!auth) {
    res.status(401).json({ error: "unauthorized", reason: "no_user_context" });
    return null;
  }
  if (!auth.email) {
    res.status(400).json({ error: "email claim missing" });
    return null;
  }
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, auth.email))
    .limit(1);
  if (!row) {
    res.status(401).json({ error: "unauthorized", reason: "user_not_found" });
    return null;
  }
  return row.id;
}

async function handleAddKey(req: Request, res: Response): Promise<void> {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const body = (req.body ?? {}) as Record<string, unknown>;

  const provider = body.provider;
  if (
    provider !== "anthropic" &&
    provider !== "openai" &&
    provider !== "ollama"
  ) {
    res.status(400).json({ error: "invalid_provider" });
    return;
  }

  const label = body.label;
  if (typeof label !== "string" || label.length < 1 || label.length > 100) {
    res.status(400).json({ error: "invalid_label" });
    return;
  }

  const key = body.key;
  if (typeof key !== "string" || key.length === 0) {
    res.status(400).json({ error: "missing_key" });
    return;
  }

  const db = getDb();
  const secretName = vaultSecretName(userId, provider, label);

  // Vault write happens before the DB insert. If the insert fails, roll the
  // Vault secret back so we don't leak orphan rows in vault.secrets.
  const vaultSecretId = await vault.createSecret(
    secretName,
    key,
    `AI Connect provider key for user ${userId} / ${provider}`,
  );

  let inserted: {
    id: string;
    provider: string;
    label: string;
    isDefault: boolean;
    createdAt: Date;
  };
  try {
    inserted = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: providerKeys.id })
        .from(providerKeys)
        .where(
          and(
            eq(providerKeys.userId, userId),
            eq(providerKeys.provider, provider),
          ),
        )
        .limit(1);
      const isDefault = existing.length === 0;

      const [row] = await tx
        .insert(providerKeys)
        .values({
          userId,
          provider,
          label,
          vaultSecretId,
          isDefault,
        })
        .returning({
          id: providerKeys.id,
          provider: providerKeys.provider,
          label: providerKeys.label,
          isDefault: providerKeys.isDefault,
          createdAt: providerKeys.createdAt,
        });
      if (!row) {
        throw new Error("provider_keys insert returned no row");
      }
      return row;
    });
  } catch (err) {
    // Best-effort cleanup of the orphaned Vault secret. Don't mask the
    // original error if cleanup also fails.
    await vault.deleteSecret(vaultSecretId).catch(() => {});
    throw err;
  }

  await logUserAction(
    userId,
    "add_provider_key",
    "provider_key",
    inserted.id,
    { provider: inserted.provider },
  );

  res.status(201).json({
    id: inserted.id,
    provider: inserted.provider,
    label: inserted.label,
    is_default: inserted.isDefault,
    created_at: inserted.createdAt,
  });
}

async function handleListKeys(req: Request, res: Response): Promise<void> {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const rows = await getDb()
    .select(keyProjection)
    .from(providerKeys)
    .where(eq(providerKeys.userId, userId))
    .orderBy(
      providerKeys.provider,
      desc(providerKeys.isDefault),
      desc(providerKeys.createdAt),
    );

  res.status(200).json({
    keys: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label,
      is_default: r.isDefault,
      created_at: r.createdAt,
      last_used_at: r.lastUsedAt,
      last_validated_at: r.lastValidatedAt,
    })),
  });
}

async function handleDeleteKey(req: Request, res: Response): Promise<void> {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const keyId = req.params.id;
  if (typeof keyId !== "string" || !UUID_RE.test(keyId)) {
    res.status(404).json({ error: "key_not_found" });
    return;
  }

  const db = getDb();

  // Single transaction: confirm ownership, delete, promote a replacement
  // default if the removed key was flagged. Returns the row we removed so
  // the caller can clean up Vault afterward.
  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: providerKeys.id,
        provider: providerKeys.provider,
        vaultSecretId: providerKeys.vaultSecretId,
        isDefault: providerKeys.isDefault,
      })
      .from(providerKeys)
      .where(
        and(eq(providerKeys.id, keyId), eq(providerKeys.userId, userId)),
      )
      .limit(1);
    if (!row) return null;

    await tx.delete(providerKeys).where(eq(providerKeys.id, row.id));

    if (row.isDefault) {
      const [next] = await tx
        .select({ id: providerKeys.id })
        .from(providerKeys)
        .where(
          and(
            eq(providerKeys.userId, userId),
            eq(providerKeys.provider, row.provider),
          ),
        )
        .orderBy(desc(providerKeys.createdAt))
        .limit(1);
      if (next) {
        await tx
          .update(providerKeys)
          .set({ isDefault: true })
          .where(eq(providerKeys.id, next.id));
      }
    }

    return row;
  });

  if (!removed) {
    res.status(404).json({ error: "key_not_found" });
    return;
  }

  // Best effort — the row reference is what users care about; if Vault is
  // already missing the secret, that's fine.
  await vault.deleteSecret(removed.vaultSecretId).catch(() => {});

  await logUserAction(
    userId,
    "remove_provider_key",
    "provider_key",
    removed.id,
    { provider: removed.provider },
  );

  res.status(200).json({ id: removed.id, deleted: true });
}

export function registerKeysRoutes(app: Express): void {
  app.post("/api/keys", requireAuth, handleAddKey);
  app.get("/api/keys", requireAuth, handleListKeys);
  app.delete("/api/keys/:id", requireAuth, handleDeleteKey);
}
