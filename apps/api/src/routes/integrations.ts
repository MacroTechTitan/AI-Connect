import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { integrations } from "../db/schema.js";
import { getIntegrationValidator } from "../lib/integrations/index.js";
import {
  openclawClient,
  OpenClawError,
} from "../lib/integrations/openclawClient.js";
import {
  isIntegrationType,
  type IntegrationConfig,
  type IntegrationType,
  type OpenClawConfig,
  type WordPressConfig,
} from "../lib/integrations/types.js";
import { isLocalMode, LOCAL_ONLY_ERROR } from "../lib/mode.js";
import {
  WordPressClientError,
  wordpressClient,
  type WordPressModule,
} from "../lib/integrations/wordpressClient.js";
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

// ── WordPress module management ─────────────────────────────────────────────
// These routes proxy to the user's installed AI Connect plugin. They load the
// wordpress integration row (org- + user-scoped), read its plugin token from
// Vault, and call the plugin's REST API. The integration must be type=wordpress
// and validated.

interface WordPressTarget {
  integrationId: string;
  siteUrl: string;
  token: string;
}

// Resolves the wordpress integration for req.params.id and returns the data
// needed to call its plugin. Writes the error response and returns null on any
// failure (not found / wrong type / not validated / missing secret).
async function resolveWordPressTarget(
  req: Request,
  res: Response,
): Promise<WordPressTarget | null> {
  const ctx = getCtx(req);
  const integrationId = req.params.id;
  if (typeof integrationId !== "string" || !UUID_RE.test(integrationId)) {
    res.status(404).json({ error: "integration_not_found" });
    return null;
  }

  const [row] = await getDb()
    .select({
      id: integrations.id,
      integrationType: integrations.integrationType,
      config: integrations.config,
      status: integrations.status,
      vaultSecretId: integrations.vaultSecretId,
    })
    .from(integrations)
    .where(
      and(
        orgScopeFilter(integrations, ctx),
        eq(integrations.id, integrationId),
        eq(integrations.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "integration_not_found" });
    return null;
  }
  if (row.integrationType !== "wordpress") {
    res.status(400).json({ error: "not_a_wordpress_integration" });
    return null;
  }
  if (row.status !== "validated") {
    res.status(409).json({ error: "integration_not_validated" });
    return null;
  }
  if (!row.vaultSecretId) {
    res.status(500).json({ error: "integration_missing_credential" });
    return null;
  }

  const cfg = row.config as WordPressConfig;
  if (typeof cfg.site_url !== "string") {
    res.status(500).json({ error: "integration_missing_site_url" });
    return null;
  }

  const token = await vault.getSecret(row.vaultSecretId);
  return { integrationId: row.id, siteUrl: cfg.site_url, token };
}

// Parses + validates a module payload from the request body. Returns null and
// writes a 400 on bad input. The plugin re-validates, but failing fast here
// gives a cleaner error and avoids a wasted round trip.
function parseModuleBody(
  req: Request,
  res: Response,
  slugOverride?: string,
): WordPressModule | null {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const slug = slugOverride ?? body.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: "invalid_slug" });
    return null;
  }
  const title = body.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    res.status(400).json({ error: "invalid_title" });
    return null;
  }
  const sourceUrl = body.source_url;
  if (
    typeof sourceUrl !== "string" ||
    !/^https?:\/\//i.test(sourceUrl) ||
    sourceUrl.length > MAX_URL_CHARS
  ) {
    res.status(400).json({ error: "invalid_source_url" });
    return null;
  }
  const tierRaw = body.required_memberpress_tier;
  let tier: string | null;
  if (tierRaw === null || tierRaw === undefined || tierRaw === "") {
    tier = null;
  } else if (typeof tierRaw === "string") {
    tier = tierRaw;
  } else {
    res.status(400).json({ error: "invalid_required_memberpress_tier" });
    return null;
  }

  return {
    slug,
    title: title.trim(),
    source_url: sourceUrl,
    required_memberpress_tier: tier,
  };
}

// Translates a thrown WordPressClientError into a response; rethrows anything
// else so the global handler turns it into a 500.
function handleWordPressError(err: unknown, res: Response): void {
  if (err instanceof WordPressClientError) {
    res.status(err.status).json({ error: "wordpress_error", reason: err.message });
    return;
  }
  throw err;
}

// After any module mutation, refresh the cached module list on the integration
// row's config so the DB reflects the plugin's truth (best-effort).
async function syncModulesToConfig(
  target: WordPressTarget,
  modules: WordPressModule[],
): Promise<void> {
  await getDb()
    .update(integrations)
    .set({
      config: { site_url: target.siteUrl, modules },
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, target.integrationId));
}

async function handleWordPressStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveWordPressTarget(req, res);
  if (!target) return;
  try {
    const status = await wordpressClient.getStatus(
      target.siteUrl,
      target.token,
    );
    res.status(200).json(status);
  } catch (err) {
    handleWordPressError(err, res);
  }
}

async function handleListModules(req: Request, res: Response): Promise<void> {
  const target = await resolveWordPressTarget(req, res);
  if (!target) return;
  try {
    const modules = await wordpressClient.listModules(
      target.siteUrl,
      target.token,
    );
    res.status(200).json({ modules });
  } catch (err) {
    handleWordPressError(err, res);
  }
}

async function handleAddModule(req: Request, res: Response): Promise<void> {
  const target = await resolveWordPressTarget(req, res);
  if (!target) return;
  const module = parseModuleBody(req, res);
  if (!module) return;
  try {
    const created = await wordpressClient.addModule(
      target.siteUrl,
      target.token,
      module,
    );
    const modules = await wordpressClient.listModules(
      target.siteUrl,
      target.token,
    );
    await syncModulesToConfig(target, modules);
    await logUserAction(
      getCtx(req).userId,
      "add_wordpress_module",
      "integration",
      target.integrationId,
      getCtx(req).organizationId,
      { slug: module.slug },
    );
    res.status(201).json({ module: created, modules });
  } catch (err) {
    handleWordPressError(err, res);
  }
}

async function handleUpdateModule(req: Request, res: Response): Promise<void> {
  const target = await resolveWordPressTarget(req, res);
  if (!target) return;
  const slug = req.params.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(404).json({ error: "module_not_found" });
    return;
  }
  const module = parseModuleBody(req, res, slug);
  if (!module) return;
  try {
    const updated = await wordpressClient.updateModule(
      target.siteUrl,
      target.token,
      slug,
      module,
    );
    const modules = await wordpressClient.listModules(
      target.siteUrl,
      target.token,
    );
    await syncModulesToConfig(target, modules);
    res.status(200).json({ module: updated, modules });
  } catch (err) {
    handleWordPressError(err, res);
  }
}

async function handleDeleteModule(req: Request, res: Response): Promise<void> {
  const target = await resolveWordPressTarget(req, res);
  if (!target) return;
  const slug = req.params.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(404).json({ error: "module_not_found" });
    return;
  }
  try {
    await wordpressClient.deleteModule(target.siteUrl, target.token, slug);
    const modules = await wordpressClient.listModules(
      target.siteUrl,
      target.token,
    );
    await syncModulesToConfig(target, modules);
    await logUserAction(
      getCtx(req).userId,
      "remove_wordpress_module",
      "integration",
      target.integrationId,
      getCtx(req).organizationId,
      { slug },
    );
    res.status(200).json({ slug, deleted: true, modules });
  } catch (err) {
    handleWordPressError(err, res);
  }
}

// ── OpenClaw agent access ───────────────────────────────────────────────────
// These routes expose the OpenClawClient to the UI: list the agents the bridge
// can reach, and send a message to one. Both require a validated openclaw
// integration and both refuse in cloud mode (AI Connect on Render cannot spawn
// the local bridge). See lib/mode.ts and docs/LOCAL_MODE.md.

interface OpenClawTarget {
  integrationId: string;
  config: OpenClawConfig;
}

// Resolves the openclaw integration for req.params.id (org- + user-scoped) and
// returns its config. Writes the error response and returns null on any failure
// (bad id / not found / wrong type / not validated). Mirrors
// resolveWordPressTarget.
async function resolveOpenClawTarget(
  req: Request,
  res: Response,
): Promise<OpenClawTarget | null> {
  const ctx = getCtx(req);
  const integrationId = req.params.id;
  if (typeof integrationId !== "string" || !UUID_RE.test(integrationId)) {
    res.status(404).json({
      error: "integration_not_found",
      message: "Integration not found or does not belong to this user.",
    });
    return null;
  }

  const [row] = await getDb()
    .select({
      id: integrations.id,
      integrationType: integrations.integrationType,
      config: integrations.config,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(
        orgScopeFilter(integrations, ctx),
        eq(integrations.id, integrationId),
        eq(integrations.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!row) {
    res.status(404).json({
      error: "integration_not_found",
      message: "Integration not found or does not belong to this user.",
    });
    return null;
  }
  if (row.integrationType !== "openclaw") {
    res.status(400).json({
      error: "wrong_integration_type",
      message: `Integration is type '${row.integrationType}', expected 'openclaw'.`,
    });
    return null;
  }
  if (row.status !== "validated") {
    res.status(400).json({
      error: "integration_not_validated",
      message: `Integration has status '${row.status}'. Run validation first.`,
    });
    return null;
  }

  return { integrationId: row.id, config: row.config as OpenClawConfig };
}

// Maps an OpenClawError to an HTTP status. Bridge unreachable / bad response is
// an upstream failure (502); a timeout is a gateway timeout (504); a missing
// agent is a 404. Anything non-OpenClawError is rethrown for the global handler.
function handleOpenClawError(err: unknown, res: Response): void {
  if (err instanceof OpenClawError) {
    let status = 502;
    if (err.code === "agent_not_found") status = 404;
    if (err.code === "bridge_timeout") status = 504;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

async function handleListOpenClawAgents(
  req: Request,
  res: Response,
): Promise<void> {
  // Cloud mode refusal — never attempt to spawn the bridge on Render.
  if (!isLocalMode()) {
    res.status(LOCAL_ONLY_ERROR.status).json({
      error: LOCAL_ONLY_ERROR.code,
      message: LOCAL_ONLY_ERROR.message,
    });
    return;
  }

  const target = await resolveOpenClawTarget(req, res);
  if (!target) return;

  try {
    const agents = await openclawClient.listAgents(target.config.bridge_path);
    res.status(200).json({ agents });
  } catch (err) {
    handleOpenClawError(err, res);
  }
}

async function handleSendOpenClawMessage(
  req: Request,
  res: Response,
): Promise<void> {
  // Cloud mode refusal — never attempt to spawn the bridge on Render.
  if (!isLocalMode()) {
    res.status(LOCAL_ONLY_ERROR.status).json({
      error: LOCAL_ONLY_ERROR.code,
      message: LOCAL_ONLY_ERROR.message,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const message = body.message;
  if (typeof message !== "string" || message.length === 0) {
    res.status(400).json({
      error: "message_required",
      message: 'Request body must include a non-empty "message" string.',
    });
    return;
  }
  if (message.length > 10_000) {
    res.status(400).json({
      error: "message_too_long",
      message: "Message exceeds 10,000 character limit.",
    });
    return;
  }

  const agentNameRaw = body.agent_name;
  if (agentNameRaw !== undefined && typeof agentNameRaw !== "string") {
    res.status(400).json({
      error: "invalid_agent_name",
      message: "agent_name must be a string when provided.",
    });
    return;
  }

  const target = await resolveOpenClawTarget(req, res);
  if (!target) return;

  const ctx = getCtx(req);
  const targetAgent =
    agentNameRaw && agentNameRaw.length > 0
      ? agentNameRaw
      : target.config.default_agent;

  try {
    const reply = await openclawClient.sendMessage(
      target.config.bridge_path,
      targetAgent,
      message,
    );

    // Audit the send. Log lengths, not contents — user instructions to an agent
    // are sensitive and must not land in the audit log.
    await logUserAction(
      ctx.userId,
      "openclaw_message_sent",
      "integration",
      target.integrationId,
      ctx.organizationId,
      {
        agent_name: targetAgent,
        message_length: message.length,
        reply_length: reply.reply.length,
      },
    );

    res.status(200).json(reply);
  } catch (err) {
    handleOpenClawError(err, res);
  }
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

  // WordPress module management — proxies to the user's installed plugin.
  app.get(
    "/api/integrations/:id/status",
    requireAuth,
    requireHydratedUser,
    handleWordPressStatus,
  );
  app.get(
    "/api/integrations/:id/modules",
    requireAuth,
    requireHydratedUser,
    handleListModules,
  );
  app.post(
    "/api/integrations/:id/modules",
    requireAuth,
    requireHydratedUser,
    handleAddModule,
  );
  app.patch(
    "/api/integrations/:id/modules/:slug",
    requireAuth,
    requireHydratedUser,
    handleUpdateModule,
  );
  app.delete(
    "/api/integrations/:id/modules/:slug",
    requireAuth,
    requireHydratedUser,
    handleDeleteModule,
  );

  // OpenClaw agent access — proxies to the local maximus-bridge. Both refuse
  // in cloud mode (503 openclaw_local_only).
  app.get(
    "/api/integrations/:id/agents",
    requireAuth,
    requireHydratedUser,
    handleListOpenClawAgents,
  );
  app.post(
    "/api/integrations/:id/messages",
    requireAuth,
    requireHydratedUser,
    handleSendOpenClawMessage,
  );
}
