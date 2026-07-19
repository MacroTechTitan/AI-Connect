import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { githubInstallations, integrations } from "../db/schema.js";
import { getIntegrationValidator } from "../lib/integrations/index.js";
import {
  auth0Client,
  Auth0Error,
  type Auth0AppType,
  type CreateApplicationParams,
  type UpdateApplicationCallbacksParams,
} from "../lib/integrations/auth0Client.js";
import {
  GithubError,
  githubClient,
} from "../lib/integrations/githubClient.js";
import {
  openclawClient,
  OpenClawError,
} from "../lib/integrations/openclawClient.js";
import {
  StripeError,
  stripeConnectClient,
} from "../lib/integrations/stripeClient.js";
import {
  isIntegrationType,
  type Auth0Config,
  type GithubConfig,
  type IntegrationConfig,
  type IntegrationType,
  type OpenClawConfig,
  type StripeConfig,
  type WordPressConfig,
} from "../lib/integrations/types.js";
import { isLocalMode, LOCAL_ONLY_ERROR } from "../lib/mode.js";
import {
  WordPressClientError,
  wordpressClient,
  type WordPressModule,
} from "../lib/integrations/wordpressClient.js";
import { logSystem, logUserAction } from "../lib/logging.js";
import { checkCanCreateIntegration } from "../lib/tiers.js";
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

  // Feature gate: Free tier caps integration count and restricts which types
  // are allowed. Enforced on CREATE only — existing integrations are never
  // touched. Runs after auth (we have ctx.userId) and after the type is known.
  const gate = await checkCanCreateIntegration(userId, integrationType);
  if (gate) {
    res.status(403).json({
      error: "tier_upgrade_required",
      message: gate.reason,
      current_tier: gate.current_tier,
      limit_hit: gate.limit_hit,
      upgrade_url: "/settings/billing",
    });
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

  // Credential is required for sendgrid (API key), wordpress (plugin token), and
  // auth0 (M2M client_secret); openai/anthropic reuse an existing provider_keys
  // row via provider_key_id and store no Vault secret of their own.
  const credentialRequired =
    integrationType === "sendgrid" ||
    integrationType === "wordpress" ||
    integrationType === "auth0";

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
  } else if (integrationType === "auth0") {
    const domainRaw = configIn.domain;
    if (
      typeof domainRaw !== "string" ||
      domainRaw.length === 0 ||
      domainRaw.length > MAX_URL_CHARS
    ) {
      res.status(400).json({ error: "invalid_auth0_domain" });
      return;
    }
    const m2mClientId = configIn.m2m_client_id;
    if (typeof m2mClientId !== "string" || m2mClientId.length === 0) {
      res.status(400).json({ error: "missing_m2m_client_id" });
      return;
    }
    // Normalize the domain (strip protocol + trailing slash) so the stored
    // config is clean; the validator and routes prepend https:// themselves.
    const domain = domainRaw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    config = { domain, m2m_client_id: m2mClientId };
  } else if (integrationType === "stripe") {
    // Stripe Connect: no per-user credential (uses AI Connect's platform key
    // + Stripe-Account header), so 'stripe' is NOT in credentialRequired. The
    // config carries the Express Connected Account ID plus optional metadata.
    const stripeAccountId = configIn.stripe_account_id;
    if (typeof stripeAccountId !== "string" || stripeAccountId.length === 0) {
      res.status(400).json({ error: "missing_stripe_account_id" });
      return;
    }
    if (stripeAccountId.length > MAX_CREDENTIAL_CHARS) {
      res.status(400).json({ error: "stripe_account_id_too_long" });
      return;
    }
    const businessType = configIn.business_type;
    if (
      businessType !== undefined &&
      businessType !== "individual" &&
      businessType !== "company"
    ) {
      res.status(400).json({ error: "invalid_business_type" });
      return;
    }
    const country = configIn.country;
    if (
      country !== undefined &&
      (typeof country !== "string" || country.length !== 2)
    ) {
      res.status(400).json({ error: "invalid_country" });
      return;
    }
    config = {
      stripe_account_id: stripeAccountId,
      ...(businessType ? { business_type: businessType } : {}),
      ...(country ? { country } : {}),
    };
  } else if (integrationType === "github") {
    // GitHub App: no per-user credential (server-side private key + per-
    // installation tokens), so 'github' is NOT in credentialRequired. The
    // config carries the installation metadata captured by the OAuth callback.
    const installationId = configIn.installation_id;
    if (typeof installationId !== "number" || !installationId) {
      res.status(400).json({ error: "missing_installation_id" });
      return;
    }
    const accountLogin = configIn.account_login;
    if (typeof accountLogin !== "string" || accountLogin.length === 0) {
      res.status(400).json({ error: "missing_account_login" });
      return;
    }
    const accountType = configIn.account_type;
    if (accountType !== "User" && accountType !== "Organization") {
      res.status(400).json({ error: "invalid_account_type" });
      return;
    }
    const repositorySelection = configIn.repository_selection;
    if (
      repositorySelection !== "all" &&
      repositorySelection !== "selected"
    ) {
      res.status(400).json({ error: "invalid_repository_selection" });
      return;
    }
    config = {
      installation_id: installationId,
      account_login: accountLogin,
      account_type: accountType,
      repository_selection: repositorySelection,
    };
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

// Pre-creation agent discovery. The wizard calls this with a bare bridge_path
// (no integration row yet) so the user can pick a default agent before the
// integration is created. Unlike the /:id routes there's no DB row to scope —
// the gate is local mode + auth. Refused in cloud mode like the others.
async function handleOpenClawDiscover(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isLocalMode()) {
    res.status(LOCAL_ONLY_ERROR.status).json({
      error: LOCAL_ONLY_ERROR.code,
      message: LOCAL_ONLY_ERROR.message,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const bridgePath = body.bridge_path;
  if (typeof bridgePath !== "string" || bridgePath.length === 0) {
    res.status(400).json({
      error: "bridge_path_required",
      message: "bridge_path is required.",
    });
    return;
  }

  try {
    const agents = await openclawClient.listAgents(bridgePath);
    res.status(200).json({ agents });
  } catch (err) {
    handleOpenClawError(err, res);
  }
}

// ── Auth0 application management ─────────────────────────────────────────────
// These routes proxy to the user's Auth0 Management API. They load the auth0
// integration row (org- + user-scoped), read its M2M client_secret from Vault,
// and call auth0Client. The integration must be type=auth0 and validated.

interface Auth0Target {
  integrationId: string;
  config: Auth0Config;
  m2mSecret: string;
}

const AUTH0_APP_TYPES: readonly Auth0AppType[] = [
  "spa",
  "native",
  "regular_web",
  "non_interactive",
];

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === "string")) return undefined;
  return value as string[];
}

function asAuth0AppType(value: unknown): Auth0AppType | undefined {
  return typeof value === "string" &&
    (AUTH0_APP_TYPES as readonly string[]).includes(value)
    ? (value as Auth0AppType)
    : undefined;
}

// Resolves the auth0 integration for req.params.id (org- + user-scoped) and
// reads its M2M secret from Vault. Writes the error response and returns null on
// any failure (bad id / not found / wrong type / not validated / missing
// secret). Mirrors resolveWordPressTarget / resolveOpenClawTarget.
async function resolveAuth0Target(
  req: Request,
  res: Response,
): Promise<Auth0Target | null> {
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
    res.status(404).json({
      error: "integration_not_found",
      message: "Integration not found or does not belong to this user.",
    });
    return null;
  }
  if (row.integrationType !== "auth0") {
    res.status(400).json({
      error: "wrong_integration_type",
      message: `Integration is type '${row.integrationType}', expected 'auth0'.`,
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
  if (!row.vaultSecretId) {
    res.status(500).json({
      error: "vault_secret_missing",
      message: "Integration has no vault secret on file.",
    });
    return null;
  }

  let m2mSecret: string;
  try {
    m2mSecret = await vault.getSecret(row.vaultSecretId);
  } catch (err) {
    res.status(500).json({
      error: "vault_read_failed",
      message: `Could not read M2M secret from vault: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    });
    return null;
  }

  return { integrationId: row.id, config: row.config as Auth0Config, m2mSecret };
}

// Maps an Auth0Error to an HTTP status. Anything non-Auth0Error is rethrown for
// the global handler.
function handleAuth0Error(err: unknown, res: Response): void {
  if (err instanceof Auth0Error) {
    const statusByCode: Record<string, number> = {
      invalid_credentials: 401,
      insufficient_scope: 403,
      application_not_found: 404,
      application_already_exists: 409,
      rate_limited: 429,
      validation_error: 400,
      network_error: 502,
      token_refresh_failed: 502,
      unexpected_response: 502,
    };
    res.status(statusByCode[err.code] ?? 502).json({
      error: err.code,
      message: err.message,
      details: err.responseBody,
    });
    return;
  }
  throw err;
}

async function handleListAuth0Applications(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveAuth0Target(req, res);
  if (!target) return;
  try {
    const applications = await auth0Client.listApplications(
      target.config.domain,
      target.config.m2m_client_id,
      target.m2mSecret,
    );
    // The list endpoint never exposes secrets (a single GET does, if the M2M
    // cred has read:client_keys). Strip client_secret defensively.
    const sanitized = applications.map((app) => ({
      ...app,
      client_secret: undefined,
    }));
    res.status(200).json({ applications: sanitized });
  } catch (err) {
    handleAuth0Error(err, res);
  }
}

async function handleGetAuth0Application(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveAuth0Target(req, res);
  if (!target) return;
  const appId = req.params.appId;
  if (typeof appId !== "string" || appId.length === 0) {
    res.status(400).json({
      error: "application_id_required",
      message: "application_id is required.",
    });
    return;
  }
  try {
    const application = await auth0Client.getApplication(
      target.config.domain,
      target.config.m2m_client_id,
      target.m2mSecret,
      appId,
    );
    res.status(200).json({ application });
  } catch (err) {
    handleAuth0Error(err, res);
  }
}

async function handleCreateAuth0Application(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveAuth0Target(req, res);
  if (!target) return;
  const ctx = getCtx(req);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== "string" || name.length === 0) {
    res.status(400).json({
      error: "name_required",
      message: "Application name is required.",
    });
    return;
  }
  if (name.length > 100) {
    res.status(400).json({
      error: "name_too_long",
      message: "Application name exceeds 100 character limit.",
    });
    return;
  }

  const params: CreateApplicationParams = {
    name,
    description:
      typeof body.description === "string" ? body.description : undefined,
    app_type: asAuth0AppType(body.app_type),
    callbacks: asStringArray(body.callbacks),
    allowed_logout_urls: asStringArray(body.allowed_logout_urls),
    allowed_origins: asStringArray(body.allowed_origins),
    web_origins: asStringArray(body.web_origins),
  };

  try {
    const application = await auth0Client.createApplication(
      target.config.domain,
      target.config.m2m_client_id,
      target.m2mSecret,
      params,
    );
    await logUserAction(
      ctx.userId,
      "auth0_application_created",
      "integration",
      target.integrationId,
      ctx.organizationId,
      {
        application_id: application.client_id,
        application_name: application.name,
      },
    );
    res.status(201).json({ application });
  } catch (err) {
    handleAuth0Error(err, res);
  }
}

async function handleUpdateAuth0Callbacks(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveAuth0Target(req, res);
  if (!target) return;
  const ctx = getCtx(req);
  const appId = req.params.appId;
  if (typeof appId !== "string" || appId.length === 0) {
    res.status(400).json({
      error: "application_id_required",
      message: "application_id is required.",
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const params: UpdateApplicationCallbacksParams = {
    callbacks: asStringArray(body.callbacks),
    allowed_logout_urls: asStringArray(body.allowed_logout_urls),
    allowed_origins: asStringArray(body.allowed_origins),
    web_origins: asStringArray(body.web_origins),
  };

  try {
    const application = await auth0Client.updateApplicationCallbacks(
      target.config.domain,
      target.config.m2m_client_id,
      target.m2mSecret,
      appId,
      params,
    );
    await logUserAction(
      ctx.userId,
      "auth0_application_callbacks_updated",
      "integration",
      target.integrationId,
      ctx.organizationId,
      { application_id: application.client_id },
    );
    res.status(200).json({ application });
  } catch (err) {
    handleAuth0Error(err, res);
  }
}

// Sets default_application_id on the auth0 integration's config (metadata about
// which app new projects should use — stored on our row, not on Auth0's side).
// Pure DB update, so it does not need resolveAuth0Target's vault read.
async function handleSetAuth0DefaultApplication(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const integrationId = req.params.id;
  if (typeof integrationId !== "string" || !UUID_RE.test(integrationId)) {
    res.status(404).json({ error: "integration_not_found" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const applicationId = body.application_id;
  if (typeof applicationId !== "string" || applicationId.length === 0) {
    res.status(400).json({
      error: "application_id_required",
      message: "application_id is required.",
    });
    return;
  }

  const [row] = await getDb()
    .select({
      id: integrations.id,
      integrationType: integrations.integrationType,
      config: integrations.config,
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

  if (!row || row.integrationType !== "auth0") {
    res.status(404).json({
      error: "integration_not_found",
      message: "Auth0 integration not found.",
    });
    return;
  }

  const newConfig: Auth0Config = {
    ...(row.config as Auth0Config),
    default_application_id: applicationId,
  };

  await getDb()
    .update(integrations)
    .set({ config: newConfig, updatedAt: new Date() })
    .where(eq(integrations.id, row.id));

  await logUserAction(
    ctx.userId,
    "auth0_default_application_set",
    "integration",
    row.id,
    ctx.organizationId,
    { application_id: applicationId },
  );

  res
    .status(200)
    .json({ success: true, default_application_id: applicationId });
}

// ============================================================
// Stripe Connect (user projects' Express Connected Accounts)
// ============================================================

interface StripeTarget {
  integration: { id: string };
  config: StripeConfig;
}

// The frontend origin used to build Stripe onboarding refresh/return URLs.
// Prefer the request's Origin header (localhost + preview deploys); fall back
// to production. Mirrors the resolver in routes/subscription.ts.
const DEFAULT_WEB_APP_URL = "https://aiconnect.macrotechtitan.com";

function resolveOrigin(req: Request): string {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin.length > 0
    ? origin
    : DEFAULT_WEB_APP_URL;
}

// Resolves the stripe integration for req.params.id (org- + user-scoped) and
// asserts it is a validated 'stripe' integration. Writes the error response
// and returns null on any failure. Mirrors resolveAuth0Target, minus the vault
// read (Connect needs no per-user secret).
async function resolveStripeTarget(
  req: Request,
  res: Response,
): Promise<StripeTarget | null> {
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
  if (row.integrationType !== "stripe") {
    res.status(400).json({
      error: "wrong_integration_type",
      message: `Integration is type '${row.integrationType}', expected 'stripe'.`,
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

  return { integration: { id: row.id }, config: row.config as StripeConfig };
}

// Maps a StripeError to an HTTP status. Anything non-StripeError is rethrown
// for the global handler (matches handleAuth0Error).
function handleStripeConnectError(err: unknown, res: Response): void {
  if (err instanceof StripeError) {
    const statusByCode: Record<string, number> = {
      account_not_found: 404,
      invalid_credentials: 500,
      rate_limited: 429,
      invalid_request: 400,
      api_error: 502,
      network_error: 502,
    };
    const status = statusByCode[err.code] ?? 502;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

// Derives our three-state account status the same way the account.updated
// webhook handler and the validator do.
function deriveStripeAccountStatus(account: {
  requirements?: { disabled_reason?: string | null } | null;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
}): "pending" | "active" | "restricted" {
  if (account.requirements?.disabled_reason) return "restricted";
  if (
    account.charges_enabled &&
    account.payouts_enabled &&
    account.details_submitted
  ) {
    return "active";
  }
  return "pending";
}

// POST /api/integrations/stripe/create-express-account — pre-wizard: creates a
// new Express Connected Account (no integration row yet). The wizard then POSTs
// /api/integrations with config.stripe_account_id to persist it.
async function handleCreateStripeExpressAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { email, country, business_type: businessType } = body;

  if (typeof email !== "string" || email.length === 0) {
    res.status(400).json({
      error: "email_required",
      message: "email is required for Stripe Express account creation.",
    });
    return;
  }
  if (typeof country !== "string" || country.length !== 2) {
    res.status(400).json({
      error: "country_required",
      message: "country is required (2-letter ISO code).",
    });
    return;
  }
  if (businessType !== "individual" && businessType !== "company") {
    res.status(400).json({
      error: "business_type_invalid",
      message: 'business_type must be "individual" or "company".',
    });
    return;
  }

  try {
    const account = await stripeConnectClient.createExpressAccount({
      email,
      country,
      businessType,
      projectId: "wizard-preprovision", // no project yet; wizard is standalone
      userId: ctx.userId,
    });

    await logSystem("info", "stripe", "express_account_created_via_wizard", {
      user_id: ctx.userId,
      account_id: account.id,
      country,
      business_type: businessType,
    });

    res.status(201).json({
      account_id: account.id,
      country: account.country,
      business_type: account.business_type,
    });
  } catch (err) {
    handleStripeConnectError(err, res);
  }
}

// POST /api/integrations/:id/stripe/onboarding-link — fresh Account Link for
// Stripe's hosted onboarding.
async function handleCreateStripeOnboardingLink(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveStripeTarget(req, res);
  if (!target) return;

  const origin = resolveOrigin(req);

  try {
    const link = await stripeConnectClient.createAccountLink({
      accountId: target.config.stripe_account_id,
      refreshUrl: `${origin}/settings/integrations?stripe_onboarding=refresh&integration_id=${target.integration.id}`,
      returnUrl: `${origin}/settings/integrations?stripe_onboarding=complete&integration_id=${target.integration.id}`,
    });

    await logSystem("info", "stripe", "onboarding_link_created", {
      integration_id: target.integration.id,
      account_id: target.config.stripe_account_id,
    });

    res.json({ url: link.url, expires_at: link.expires_at });
  } catch (err) {
    handleStripeConnectError(err, res);
  }
}

// POST /api/integrations/:id/stripe/dashboard-link — Login Link for the Express
// Dashboard.
async function handleCreateStripeDashboardLink(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveStripeTarget(req, res);
  if (!target) return;

  try {
    const link = await stripeConnectClient.createLoginLink(
      target.config.stripe_account_id,
    );

    await logSystem("info", "stripe", "dashboard_link_created", {
      integration_id: target.integration.id,
      account_id: target.config.stripe_account_id,
    });

    res.json({ url: link.url });
  } catch (err) {
    handleStripeConnectError(err, res);
  }
}

// GET /api/integrations/:id/stripe/account — current Account details for the
// management UI (Commit 12).
async function handleGetStripeAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveStripeTarget(req, res);
  if (!target) return;

  try {
    const account = await stripeConnectClient.getAccount(
      target.config.stripe_account_id,
    );

    res.json({
      account_id: account.id,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      status: deriveStripeAccountStatus(account),
      country: account.country,
      business_type: account.business_type,
      requirements: account.requirements
        ? {
            currently_due: account.requirements.currently_due ?? [],
            past_due: account.requirements.past_due ?? [],
            disabled_reason: account.requirements.disabled_reason ?? null,
            current_deadline: account.requirements.current_deadline
              ? new Date(
                  account.requirements.current_deadline * 1000,
                ).toISOString()
              : null,
          }
        : null,
    });
  } catch (err) {
    handleStripeConnectError(err, res);
  }
}

// ============================================================
// GitHub App (installation-scoped repo / issue / PR operations)
// ============================================================

interface GithubTarget {
  integration: { id: string };
  config: GithubConfig;
}

// Resolves the github integration for req.params.id (org- + user-scoped) and
// asserts it is a validated 'github' integration. Mirrors resolveStripeTarget.
async function resolveGithubTarget(
  req: Request,
  res: Response,
): Promise<GithubTarget | null> {
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
  if (row.integrationType !== "github") {
    res.status(400).json({
      error: "wrong_integration_type",
      message: `Integration is type '${row.integrationType}', expected 'github'.`,
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

  return { integration: { id: row.id }, config: row.config as GithubConfig };
}

// Maps a GithubError to an HTTP status. Anything non-GithubError is rethrown
// for the global handler (matches handleStripeConnectError / handleAuth0Error).
function handleGithubConnectError(err: unknown, res: Response): void {
  if (err instanceof GithubError) {
    const statusByCode: Record<string, number> = {
      installation_not_found: 404,
      installation_suspended: 403,
      repo_not_found: 404,
      permissions_missing: 403,
      invalid_credentials: 500,
      rate_limited: 429,
      invalid_request: 400,
      api_error: 502,
      network_error: 502,
      webhook_signature_invalid: 400,
    };
    const status = statusByCode[err.code] ?? 502;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }
  throw err;
}

// GET /api/integrations/:id/github/repositories — repos the installation can reach.
async function handleListGithubRepositories(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveGithubTarget(req, res);
  if (!target) return;

  try {
    const repos = await githubClient.getInstallationRepos(
      target.config.installation_id,
    );
    res.json({
      repositories: repos.map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        html_url: r.html_url,
        default_branch: r.default_branch,
        description: r.description,
      })),
    });
  } catch (err) {
    handleGithubConnectError(err, res);
  }
}

// POST /api/integrations/:id/github/issues — create an issue in a repo.
async function handleCreateGithubIssue(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveGithubTarget(req, res);
  if (!target) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { owner, repo, title, body: issueBody, labels } = body;

  if (typeof owner !== "string" || owner.length === 0) {
    res.status(400).json({ error: "owner_required", message: "owner is required" });
    return;
  }
  if (typeof repo !== "string" || repo.length === 0) {
    res.status(400).json({ error: "repo_required", message: "repo is required" });
    return;
  }
  if (typeof title !== "string" || title.length === 0) {
    res.status(400).json({ error: "title_required", message: "title is required" });
    return;
  }

  try {
    const issue = await githubClient.createIssue(target.config.installation_id, {
      owner,
      repo,
      title,
      body: typeof issueBody === "string" ? issueBody : undefined,
      labels: Array.isArray(labels)
        ? labels.filter((l): l is string => typeof l === "string")
        : undefined,
    });

    await logSystem("info", "github", "issue_created", {
      integration_id: target.integration.id,
      installation_id: target.config.installation_id,
      owner,
      repo,
      issue_number: issue.number,
    });

    res.status(201).json({ number: issue.number, html_url: issue.html_url });
  } catch (err) {
    handleGithubConnectError(err, res);
  }
}

// POST /api/integrations/:id/github/pull-requests — create a pull request.
async function handleCreateGithubPullRequest(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveGithubTarget(req, res);
  if (!target) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { owner, repo, title, head, base, body: prBody, draft } = body;

  if (typeof owner !== "string" || owner.length === 0) {
    res.status(400).json({ error: "owner_required", message: "owner is required" });
    return;
  }
  if (typeof repo !== "string" || repo.length === 0) {
    res.status(400).json({ error: "repo_required", message: "repo is required" });
    return;
  }
  if (typeof title !== "string" || title.length === 0) {
    res.status(400).json({ error: "title_required", message: "title is required" });
    return;
  }
  if (typeof head !== "string" || head.length === 0) {
    res
      .status(400)
      .json({ error: "head_required", message: "head branch is required" });
    return;
  }
  if (typeof base !== "string" || base.length === 0) {
    res
      .status(400)
      .json({ error: "base_required", message: "base branch is required" });
    return;
  }

  try {
    const pr = await githubClient.createPullRequest(
      target.config.installation_id,
      {
        owner,
        repo,
        title,
        head,
        base,
        body: typeof prBody === "string" ? prBody : undefined,
        draft: Boolean(draft),
      },
    );

    await logSystem("info", "github", "pull_request_created", {
      integration_id: target.integration.id,
      installation_id: target.config.installation_id,
      owner,
      repo,
      pr_number: pr.number,
    });

    res.status(201).json({ number: pr.number, html_url: pr.html_url });
  } catch (err) {
    handleGithubConnectError(err, res);
  }
}

// POST /api/integrations/:id/github/test-connection — ping the installation.
async function handleGithubTestConnection(
  req: Request,
  res: Response,
): Promise<void> {
  const target = await resolveGithubTarget(req, res);
  if (!target) return;

  try {
    const result = await githubClient.testConnection(
      target.config.installation_id,
    );
    res.json(result);
  } catch (err) {
    handleGithubConnectError(err, res);
  }
}

// GET /api/integrations/github/installation/:installationId — hydrates the
// installation metadata (login/type/repo-selection) the wizard needs to build
// the integration config after the user returns from GitHub's install flow.
// Scoped to the owning user. Distinct from the /:id/github/* routes — the
// second path segment is the literal "github", so it never collides.
async function handleGetInstallationForWizard(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const installationId = Number(req.params.installationId);

  if (!Number.isFinite(installationId) || installationId <= 0) {
    res.status(400).json({ error: "invalid_installation_id" });
    return;
  }

  const [installation] = await getDb()
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      repositorySelection: githubInstallations.repositorySelection,
      suspendedAt: githubInstallations.suspendedAt,
    })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!installation) {
    res.status(404).json({
      error: "installation_not_found",
      message: "Installation not found or does not belong to you.",
    });
    return;
  }

  if (installation.suspendedAt) {
    res.status(400).json({
      error: "installation_suspended",
      message: "This installation is suspended on GitHub.",
    });
    return;
  }

  res.json({
    installation_id: installation.installationId,
    account_login: installation.accountLogin,
    account_type: installation.accountType,
    repository_selection: installation.repositorySelection,
  });
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

  // OpenClaw agent access — proxies to the local maximus-bridge. All refuse
  // in cloud mode (503 openclaw_local_only). The literal /openclaw/discover
  // path is registered before the parameterized /:id routes so Express never
  // mistakes "openclaw" for an :id.
  app.post(
    "/api/integrations/openclaw/discover",
    requireAuth,
    requireHydratedUser,
    handleOpenClawDiscover,
  );
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

  // Auth0 application management — proxies to the Auth0 Management API. Each
  // path requires a validated auth0 integration; the M2M secret is read from
  // the integration's Vault entry per request (see resolveAuth0Target).
  app.get(
    "/api/integrations/:id/auth0/applications",
    requireAuth,
    requireHydratedUser,
    handleListAuth0Applications,
  );
  app.post(
    "/api/integrations/:id/auth0/applications",
    requireAuth,
    requireHydratedUser,
    handleCreateAuth0Application,
  );
  app.get(
    "/api/integrations/:id/auth0/applications/:appId",
    requireAuth,
    requireHydratedUser,
    handleGetAuth0Application,
  );
  app.patch(
    "/api/integrations/:id/auth0/applications/:appId/callbacks",
    requireAuth,
    requireHydratedUser,
    handleUpdateAuth0Callbacks,
  );
  app.patch(
    "/api/integrations/:id/auth0/default-application",
    requireAuth,
    requireHydratedUser,
    handleSetAuth0DefaultApplication,
  );

  // Stripe Connect (user projects' Express Connected Accounts). The pre-wizard
  // create route has no :id (the integration row doesn't exist yet); the other
  // three operate on a validated 'stripe' integration via resolveStripeTarget.
  app.post(
    "/api/integrations/stripe/create-express-account",
    requireAuth,
    requireHydratedUser,
    handleCreateStripeExpressAccount,
  );
  app.post(
    "/api/integrations/:id/stripe/onboarding-link",
    requireAuth,
    requireHydratedUser,
    handleCreateStripeOnboardingLink,
  );
  app.post(
    "/api/integrations/:id/stripe/dashboard-link",
    requireAuth,
    requireHydratedUser,
    handleCreateStripeDashboardLink,
  );
  app.get(
    "/api/integrations/:id/stripe/account",
    requireAuth,
    requireHydratedUser,
    handleGetStripeAccount,
  );

  // GitHub App — operate on a validated 'github' integration via
  // resolveGithubTarget. Installs happen via the OAuth flow (routes/githubOAuth),
  // not here; these routes act on an already-linked installation.
  app.get(
    "/api/integrations/:id/github/repositories",
    requireAuth,
    requireHydratedUser,
    handleListGithubRepositories,
  );
  app.post(
    "/api/integrations/:id/github/issues",
    requireAuth,
    requireHydratedUser,
    handleCreateGithubIssue,
  );
  app.post(
    "/api/integrations/:id/github/pull-requests",
    requireAuth,
    requireHydratedUser,
    handleCreateGithubPullRequest,
  );
  app.post(
    "/api/integrations/:id/github/test-connection",
    requireAuth,
    requireHydratedUser,
    handleGithubTestConnection,
  );
  app.get(
    "/api/integrations/github/installation/:installationId",
    requireAuth,
    requireHydratedUser,
    handleGetInstallationForWizard,
  );
}
