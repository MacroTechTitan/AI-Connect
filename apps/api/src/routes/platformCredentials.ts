import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { platformCredentials } from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import {
  getPlatformClient,
  type Platform,
} from "../lib/platforms/index.js";
import * as vault from "../lib/vault.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LABEL_CHARS = 100;
const MAX_CREDENTIAL_CHARS = 1000;

function isPlatform(value: unknown): value is Platform {
  return (
    value === "vercel" ||
    value === "render" ||
    value === "github" ||
    value === "supabase"
  );
}

// Vault-name-safe label: letters, digits, dash, underscore only. Mirrors the
// sanitizer in /api/keys so the two namespaces stay consistent.
function sanitizeLabelForVaultName(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function vaultSecretName(
  userId: string,
  platform: Platform,
  label: string,
): string {
  return `ai-connect:user:${userId}:platform:${platform}:credential:${sanitizeLabelForVaultName(label)}`;
}

// req.user is guaranteed by requireHydratedUser; this just narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

async function handleAddCredential(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const { userId, organizationId } = ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;

  const platform = body.platform;
  if (!isPlatform(platform)) {
    res.status(400).json({ error: "invalid_platform" });
    return;
  }

  const label = body.label;
  if (
    typeof label !== "string" ||
    label.length < 1 ||
    label.length > MAX_LABEL_CHARS
  ) {
    res.status(400).json({ error: "invalid_label" });
    return;
  }

  const credential = body.credential;
  if (typeof credential !== "string" || credential.length === 0) {
    res.status(400).json({ error: "missing_credential" });
    return;
  }
  if (credential.length > MAX_CREDENTIAL_CHARS) {
    res.status(400).json({ error: "credential_too_long" });
    return;
  }

  // Validate against the platform BEFORE storing. Closes the "discovered at
  // first use" failure class that Sprint 2's pricing seed exposed — the user
  // gets immediate 400 feedback if the token is bad.
  const validation = await getPlatformClient(platform).validate(credential);
  if (!validation.valid) {
    res.status(400).json({
      error: "credential_invalid",
      reason:
        validation.errorMessage ??
        `${platform} rejected the credential.`,
    });
    return;
  }

  const secretName = vaultSecretName(userId, platform, label);

  // Vault write happens before the DB insert. If the insert fails, roll the
  // Vault secret back so we don't leak orphan rows in vault.secrets.
  const vaultSecretId = await vault.createSecret(
    secretName,
    credential,
    `AI Connect platform credential for user ${userId} / ${platform}`,
  );

  let inserted: {
    id: string;
    platform: string;
    label: string;
    createdAt: Date;
    lastValidatedAt: Date | null;
  };
  try {
    const now = new Date();
    const [row] = await getDb()
      .insert(platformCredentials)
      .values({
        userId,
        organizationId,
        platform,
        label,
        vaultSecretId,
        lastValidatedAt: now,
      })
      .returning({
        id: platformCredentials.id,
        platform: platformCredentials.platform,
        label: platformCredentials.label,
        createdAt: platformCredentials.createdAt,
        lastValidatedAt: platformCredentials.lastValidatedAt,
      });
    if (!row) {
      throw new Error("platform_credentials insert returned no row");
    }
    inserted = row;
  } catch (err) {
    await vault.deleteSecret(vaultSecretId).catch(() => {});
    throw err;
  }

  await logUserAction(
    userId,
    "add_platform_credential",
    "platform_credential",
    inserted.id,
    organizationId,
    { platform: inserted.platform },
  );

  res.status(201).json({
    id: inserted.id,
    platform: inserted.platform,
    label: inserted.label,
    created_at: inserted.createdAt,
    last_validated_at: inserted.lastValidatedAt,
    identity: validation.identity,
  });
}

async function handleListCredentials(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  const rows = await getDb()
    .select({
      id: platformCredentials.id,
      platform: platformCredentials.platform,
      label: platformCredentials.label,
      createdAt: platformCredentials.createdAt,
      lastUsedAt: platformCredentials.lastUsedAt,
      lastValidatedAt: platformCredentials.lastValidatedAt,
    })
    .from(platformCredentials)
    .where(
      and(
        orgScopeFilter(platformCredentials, ctx),
        eq(platformCredentials.userId, ctx.userId),
      ),
    )
    .orderBy(
      platformCredentials.platform,
      desc(platformCredentials.createdAt),
    );

  res.status(200).json({
    credentials: rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      label: r.label,
      created_at: r.createdAt,
      last_used_at: r.lastUsedAt,
      last_validated_at: r.lastValidatedAt,
    })),
  });
}

async function handleDeleteCredential(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const { userId, organizationId } = ctx;

  const credentialId = req.params.id;
  if (typeof credentialId !== "string" || !UUID_RE.test(credentialId)) {
    res.status(404).json({ error: "credential_not_found" });
    return;
  }

  const db = getDb();

  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: platformCredentials.id,
        platform: platformCredentials.platform,
        organizationId: platformCredentials.organizationId,
        vaultSecretId: platformCredentials.vaultSecretId,
      })
      .from(platformCredentials)
      .where(
        and(
          orgScopeFilter(platformCredentials, ctx),
          eq(platformCredentials.id, credentialId),
          eq(platformCredentials.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return null;

    // Belt-and-braces: SELECT above is already org-scoped, but the explicit
    // assertion catches the case where a future change drops the scope.
    assertOrgAccess(row.organizationId, ctx);

    await tx
      .delete(platformCredentials)
      .where(eq(platformCredentials.id, row.id));

    return row;
  });

  if (!removed) {
    res.status(404).json({ error: "credential_not_found" });
    return;
  }

  // Best effort — the metadata row removal is what users care about; if Vault
  // is already missing the secret, that's fine.
  await vault.deleteSecret(removed.vaultSecretId).catch(() => {});

  await logUserAction(
    userId,
    "remove_platform_credential",
    "platform_credential",
    removed.id,
    organizationId,
    { platform: removed.platform },
  );

  res.status(200).json({ id: removed.id, deleted: true });
}

export function registerPlatformCredentialsRoutes(app: Express): void {
  app.post(
    "/api/platform-credentials",
    requireAuth,
    requireHydratedUser,
    handleAddCredential,
  );
  app.get(
    "/api/platform-credentials",
    requireAuth,
    requireHydratedUser,
    handleListCredentials,
  );
  app.delete(
    "/api/platform-credentials/:id",
    requireAuth,
    requireHydratedUser,
    handleDeleteCredential,
  );
}
