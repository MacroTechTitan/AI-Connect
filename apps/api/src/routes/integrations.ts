import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { integrations } from "../db/schema.js";
import { getIntegrationValidator } from "../lib/integrations/index.js";
import {
  isIntegrationType,
  type IntegrationConfig,
  type IntegrationType,
} from "../lib/integrations/types.js";
import { logUserAction } from "../lib/logging.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import * as vault from "../lib/vault.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_CREDENTIAL_CHARS = 1000;
const MAX_URL_CHARS = 2000;

// One integration per user per type (MVP) → no label sub-namespace.
function vaultSecretName(
  userId: string,
  integrationType: IntegrationType,
): string {
  return `ai-connect:user:${userId}:integration:${integrationType}:credential`;
}

// node-postgres surfaces a unique_violation as error.code "23505". Translate
// that to a 409 rather than letting it bubble to a generic 500.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

interface IntegrationRow {
  id: string;
  integrationType: string;
  config: unknown;
  includeInProjects: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastValidatedAt: Date | null;
  validationError: string | null;
}

const integrationProjection = {
  id: integrations.id,
  integrationType: integrations.integrationType,
  config: integrations.config,
  includeInProjects: integrations.includeInProjects,
  status: integrations.status,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
  lastValidatedAt: integrations.lastValidatedAt,
  validationError: integrations.validationError,
} as const;

function toResponse(r: IntegrationRow) {
  return {
    id: r.id,
    integration_type: r.integrationType,
    config: r.config,
    include_in_projects: r.includeInProjects,
    status: r.status,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    last_validated_at: r.lastValidatedAt,
    validation_error: r.validationError,
  };
}

// req.user is guaranteed by requireHydratedUser; this just narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

async function handleAddIntegration(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const { userId, organizationId } = ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;

  const integrationType = body.integration_type;
  if (!isIntegrationType(integrationType)) {
    res.status(400).json({ error: "invalid_integration_type" });
    return;
  }

  const rawConfig = body.config;
  if (
    rawConfig !== undefined &&
    (typeof rawConfig !== "object" ||
      rawConfig === null ||
      Array.isArray(rawConfig))
  ) {
    res.status(400).json({ error: "invalid_config" });
    return;
  }
  const configIn = (rawConfig ?? {}) as Record<string, unknown>;

  // Credential is required for sendgrid (API key) and wordpress (plugin token);
  // openai/anthropic reuse an existing provider_keys row via provider_key_id and
  // store no Vault secret of their own.
  const credentialRequired =
    integrationType === "sendgrid" || integrationType === "wordpress";

  let credential: string | undefined;
  if (credentialRequired) {
    const rawCredential = body.credential;
    if (typeof rawCredential !== "string" || rawCredential.length === 0) {
      res.status(400).json({ error: "missing_credential" });
      return;
    }
    if (rawCredential.length > MAX_CREDENTIAL_CHARS) {
      res.status(400).json({ error: "credential_too_long" });
      return;
    }
    credential = rawCredential;
  }

  // Build the per-type config we will persist.
  let config: IntegrationConfig;
  if (integrationType === "openai" || integrationType === "anthropic") {
    const providerKeyId = configIn.provider_key_id;
    if (typeof providerKeyId !== "string" || !UUID_RE.test(providerKeyId)) {
      res.status(400).json({ error: "missing_provider_key_id" });
      return;
    }
    config = { provider_key_id: providerKeyId };
  } else if (integrationType === "wordpress") {
    const siteUrl = configIn.site_url;
    if (
      typeof siteUrl !== "string" ||
      !/^https?:\/\//i.test(siteUrl) ||
      siteUrl.length > MAX_URL_CHARS
    ) {
      res.status(400).json({ error: "invalid_site_url" });
      return;
    }
    config = { site_url: siteUrl };
  } else {
    // sendgrid — credential is the whole story.
    config = {};
  }

  // Validate BEFORE storing — matches platform_credentials' fail-fast pattern.
  // Commit 3 ships a stub validator (always valid: true); real per-type
  // validators replace it in later commits.
  const validation = await getIntegrationValidator(integrationType, userId)({
    integrationType,
    credential,
    config,
  });
  if (!validation.valid) {
    res.status(400).json({
      error: "integration_invalid",
      reason:
        validation.errorMessage ??
        `${integrationType} rejected the integration.`,
    });
    return;
  }

  // Vault write happens before the DB insert (credential-bearing types only).
  // If the insert fails, roll the Vault secret back so we don't leak orphans.
  let vaultSecretId: string | null = null;
  if (credential) {
    vaultSecretId = await vault.createSecret(
      vaultSecretName(userId, integrationType),
      credential,
      `AI Connect integration credential for user ${userId} / ${integrationType}`,
    );
  }

  let inserted: IntegrationRow;
  try {
    const now = new Date();
    const [row] = await getDb()
      .insert(integrations)
      .values({
        userId,
        organizationId,
        integrationType,
        vaultSecretId,
        config,
        status: "validated",
        lastValidatedAt: now,
      })
      .returning(integrationProjection);
    if (!row) {
      throw new Error("integrations insert returned no row");
    }
    inserted = row;
  } catch (err) {
    if (vaultSecretId) {
      await vault.deleteSecret(vaultSecretId).catch(() => {});
    }
    if (isUniqueViolation(err)) {
      res.status(409).json({
        error: "integration_exists",
        reason: `An integration of type '${integrationType}' already exists for this user.`,
      });
      return;
    }
    throw err;
  }

  await logUserAction(
    userId,
    "add_integration",
    "integration",
    inserted.id,
    organizationId,
    { integration_type: integrationType },
  );

  res.status(201).json({ ...toResponse(inserted), identity: validation.identity });
}

async function handleListIntegrations(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  const rows = (await getDb()
    .select(integrationProjection)
    .from(integrations)
    .where(
      and(
        orgScopeFilter(integrations, ctx),
        eq(integrations.userId, ctx.userId),
      ),
    )
    .orderBy(
      integrations.integrationType,
      desc(integrations.createdAt),
    )) as IntegrationRow[];

  res.status(200).json({ integrations: rows.map(toResponse) });
}

async function handleUpdateIntegration(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const { userId, organizationId } = ctx;

  const integrationId = req.params.id;
  if (typeof integrationId !== "string" || !UUID_RE.test(integrationId)) {
    res.status(404).json({ error: "integration_not_found" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const includeInProjects = body.include_in_projects;
  if (typeof includeInProjects !== "boolean") {
    res.status(400).json({ error: "invalid_include_in_projects" });
    return;
  }

  const [updated] = (await getDb()
    .update(integrations)
    .set({ includeInProjects, updatedAt: new Date() })
    .where(
      and(
        orgScopeFilter(integrations, ctx),
        eq(integrations.id, integrationId),
        eq(integrations.userId, userId),
      ),
    )
    .returning(integrationProjection)) as IntegrationRow[];

  if (!updated) {
    res.status(404).json({ error: "integration_not_found" });
    return;
  }

  await logUserAction(
    userId,
    "update_integration_toggle",
    "integration",
    updated.id,
    organizationId,
    { include_in_projects: includeInProjects },
  );

  res.status(200).json(toResponse(updated));
}

async function handleDeleteIntegration(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const { userId, organizationId } = ctx;

  const integrationId = req.params.id;
  if (typeof integrationId !== "string" || !UUID_RE.test(integrationId)) {
    res.status(404).json({ error: "integration_not_found" });
    return;
  }

  const db = getDb();

  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: integrations.id,
        integrationType: integrations.integrationType,
        organizationId: integrations.organizationId,
        vaultSecretId: integrations.vaultSecretId,
      })
      .from(integrations)
      .where(
        and(
          orgScopeFilter(integrations, ctx),
          eq(integrations.id, integrationId),
          eq(integrations.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return null;

    // Belt-and-braces: SELECT above is already org-scoped, but the explicit
    // assertion catches the case where a future change drops the scope.
    assertOrgAccess(row.organizationId, ctx);

    await tx.delete(integrations).where(eq(integrations.id, row.id));

    return row;
  });

  if (!removed) {
    res.status(404).json({ error: "integration_not_found" });
    return;
  }

  // Best effort — only credential-bearing integrations have a Vault secret.
  if (removed.vaultSecretId) {
    await vault.deleteSecret(removed.vaultSecretId).catch(() => {});
  }

  await logUserAction(
    userId,
    "remove_integration",
    "integration",
    removed.id,
    organizationId,
    { integration_type: removed.integrationType },
  );

  res.status(200).json({ id: removed.id, deleted: true });
}

export function registerIntegrationsRoutes(app: Express): void {
  app.post(
    "/api/integrations",
    requireAuth,
    requireHydratedUser,
    handleAddIntegration,
  );
  app.get(
    "/api/integrations",
    requireAuth,
    requireHydratedUser,
    handleListIntegrations,
  );
  app.patch(
    "/api/integrations/:id",
    requireAuth,
    requireHydratedUser,
    handleUpdateIntegration,
  );
  app.delete(
    "/api/integrations/:id",
    requireAuth,
    requireHydratedUser,
    handleDeleteIntegration,
  );
}
