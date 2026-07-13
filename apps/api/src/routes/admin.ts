import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb, getPool } from "../db/client.js";
import {
  githubWebhookEvents,
  integrations,
  projects,
  stripeWebhookEvents,
  subscriptions,
  systemLogs,
  users,
} from "../db/schema.js";
import { env } from "../lib/env.js";
import {
  StripeError,
  stripeStandardClient,
} from "../lib/integrations/stripeClient.js";
import { logSystem } from "../lib/logging.js";
import type { AuthedUserContext } from "../lib/orgScope.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireDiagnosticsToken } from "../middleware/requireDiagnosticsToken.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const DB_REACHABLE_TIMEOUT_MS = 2000;

// SELECT 1 with a hard 2s ceiling. If the DB hangs, we still answer the
// diagnostic request — that's the whole point of this endpoint.
async function checkDbReachable(): Promise<boolean> {
  if (!env.DATABASE_URL) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("db_reachable_timeout")),
          DB_REACHABLE_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleDiagnostics(_req: Request, res: Response): Promise<void> {
  const reachable = await checkDbReachable();
  res.status(200).json({
    service: "ai-connect-api",
    version: process.env.npm_package_version ?? "0.0.0",
    timestamp: new Date().toISOString(),
    node: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
    // Boolean presence only. Never leak secret values.
    env: {
      DATABASE_URL: Boolean(env.DATABASE_URL),
      AUTH0_ISSUER_BASE_URL: Boolean(env.AUTH0_ISSUER_BASE_URL),
      AUTH0_AUDIENCE: Boolean(env.AUTH0_AUDIENCE),
      MASTER_KEY: Boolean(env.MASTER_KEY),
      DIAGNOSTICS_TOKEN: Boolean(env.DIAGNOSTICS_TOKEN),
      ADMIN_EMAIL: Boolean(env.ADMIN_EMAIL),
    },
    db: {
      configured: Boolean(env.DATABASE_URL),
      reachable,
    },
  });
}

// ============================================================
// Admin panel (is_admin-gated). Separate from the token-gated
// diagnostics endpoint above. All routes stack requireAuth +
// requireHydratedUser + requireAdmin; mutations are audit-logged.
// ============================================================

// req.user is guaranteed by requireHydratedUser; this narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

// limit: 1-100 (default 50); offset: 0+ (default 0). Offset-based is fine here
// — these tables are small and admin-only.
function parsePagination(req: Request): { limit: number; offset: number } {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
}

// req.params values are loosely typed; narrow to a definite string ("" for a
// missing param → a lookup that simply finds nothing → 404).
function pathParam(req: Request, name: string): string {
  const v = req.params[name];
  return typeof v === "string" ? v : "";
}

// GET /api/admin/dashboard — aggregate counts for the overview.
async function handleDashboard(_req: Request, res: Response): Promise<void> {
  const db = getDb();

  const cnt = (rows: { count: number }[]) => Number(rows[0]?.count ?? 0);

  const [userRows, proRows, freeRows, integrationRows, projectRows] =
    await Promise.all([
      db.select({ count: count() }).from(users),
      db
        .select({ count: count() })
        .from(subscriptions)
        .where(eq(subscriptions.tier, "pro")),
      db
        .select({ count: count() })
        .from(subscriptions)
        .where(eq(subscriptions.tier, "free")),
      db.select({ count: count() }).from(integrations),
      db.select({ count: count() }).from(projects),
    ]);

  res.json({
    users: {
      total: cnt(userRows),
      pro: cnt(proRows),
      free: cnt(freeRows),
    },
    integrations: { total: cnt(integrationRows) },
    projects: { total: cnt(projectRows) },
  });
}

// GET /api/admin/users — list with pagination + optional admins_only filter.
async function handleListUsers(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();
  const showOnlyAdmins = req.query.admins_only === "true";
  const filter = showOnlyAdmins ? eq(users.isAdmin, true) : undefined;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      tier: subscriptions.tier,
      status: subscriptions.status,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(filter)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const [total] = await db
    .select({ count: count() })
    .from(users)
    .where(filter);

  res.json({
    users: rows,
    total: Number(total?.count ?? 0),
    limit,
    offset,
  });
}

// GET /api/admin/users/:id — single user detail with subscription + counts.
async function handleGetUser(req: Request, res: Response): Promise<void> {
  const db = getDb();

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      // The subscription row id — the admin UI needs it to force-cancel.
      subscriptionId: subscriptions.id,
      tier: subscriptions.tier,
      status: subscriptions.status,
      stripeCustomerId: subscriptions.stripeCustomerId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
    })
    .from(users)
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .where(eq(users.id, pathParam(req, "id")))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }

  const [ic] = await db
    .select({ count: count() })
    .from(integrations)
    .where(eq(integrations.userId, row.id));

  res.json({ ...row, integration_count: Number(ic?.count ?? 0) });
}

// PATCH /api/admin/users/:id/tier — manually set tier (upserts subscription).
async function handleSetTier(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);
  const targetUserId = pathParam(req, "id");
  const { tier } = (req.body ?? {}) as { tier?: unknown };

  if (tier !== "free" && tier !== "pro") {
    res.status(400).json({
      error: "invalid_tier",
      message: 'tier must be "free" or "pro"',
    });
    return;
  }

  const db = getDb();

  const [targetUser] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!targetUser) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }

  const [existing] = await db
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.userId, targetUserId))
    .limit(1);

  if (existing) {
    await db
      .update(subscriptions)
      .set({ tier, status: "active", updatedAt: new Date() })
      .where(eq(subscriptions.userId, targetUserId));
  } else {
    await db
      .insert(subscriptions)
      .values({ userId: targetUserId, tier, status: "active" });
  }

  await logSystem("info", "admin", "user_tier_changed", {
    admin_user_id: ctx.userId,
    target_user_id: targetUserId,
    target_user_email: targetUser.email,
    new_tier: tier,
  });

  res.json({ success: true, user_id: targetUserId, tier });
}

// GET /api/admin/subscriptions — list with tier/status filters.
async function handleListSubscriptions(
  req: Request,
  res: Response,
): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();

  const tierFilter = req.query.tier;
  const statusFilter = req.query.status;
  const conditions = [];
  if (tierFilter === "free" || tierFilter === "pro") {
    conditions.push(eq(subscriptions.tier, tierFilter));
  }
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    conditions.push(eq(subscriptions.status, statusFilter));
  }

  const rows = await db
    .select({
      id: subscriptions.id,
      userId: subscriptions.userId,
      email: users.email,
      tier: subscriptions.tier,
      status: subscriptions.status,
      stripeCustomerId: subscriptions.stripeCustomerId,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .leftJoin(users, eq(users.id, subscriptions.userId))
    .where(and(...conditions))
    .orderBy(desc(subscriptions.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ subscriptions: rows, limit, offset });
}

// POST /api/admin/subscriptions/:id/cancel — force cancel (syncs Stripe).
async function handleCancelSubscription(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const db = getDb();

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, pathParam(req, "id")))
    .limit(1);

  if (!sub) {
    res.status(404).json({ error: "subscription_not_found" });
    return;
  }

  if (sub.stripeSubscriptionId) {
    try {
      await stripeStandardClient.cancelSubscription(
        sub.stripeSubscriptionId,
        false,
      );
    } catch (err) {
      if (err instanceof StripeError && err.code !== "subscription_not_found") {
        res.status(502).json({ error: err.code, message: err.message });
        return;
      }
      // Already canceled / missing on Stripe's side — proceed with local update.
    }
  }

  await db
    .update(subscriptions)
    .set({
      tier: "free",
      status: "canceled",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, sub.id));

  await logSystem("info", "admin", "subscription_force_canceled", {
    admin_user_id: ctx.userId,
    subscription_id: sub.id,
    target_user_id: sub.userId,
  });

  res.json({ success: true });
}

// GET /api/admin/integrations — list across all users with type/status filters.
async function handleListIntegrations(
  req: Request,
  res: Response,
): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();

  const typeFilter = req.query.type;
  const statusFilter = req.query.status;
  const conditions = [];
  if (typeof typeFilter === "string" && typeFilter.length > 0) {
    conditions.push(eq(integrations.integrationType, typeFilter));
  }
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    conditions.push(eq(integrations.status, statusFilter));
  }

  const rows = await db
    .select({
      id: integrations.id,
      userId: integrations.userId,
      email: users.email,
      integrationType: integrations.integrationType,
      status: integrations.status,
      includeInProjects: integrations.includeInProjects,
      // integrations has no identity column (identity is validator-time only);
      // expose config for admin visibility instead.
      config: integrations.config,
      createdAt: integrations.createdAt,
    })
    .from(integrations)
    .leftJoin(users, eq(users.id, integrations.userId))
    .where(and(...conditions))
    .orderBy(desc(integrations.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ integrations: rows, limit, offset });
}

// GET /api/admin/logs — paginated system_logs with category/level/time filters.
async function handleListLogs(req: Request, res: Response): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();

  const category = req.query.category;
  const level = req.query.level;
  const fromStr = req.query.from;
  const toStr = req.query.to;

  const conditions = [];
  if (typeof category === "string" && category.length > 0) {
    conditions.push(eq(systemLogs.category, category));
  }
  if (typeof level === "string" && level.length > 0) {
    conditions.push(eq(systemLogs.level, level));
  }
  if (typeof fromStr === "string") {
    const from = new Date(fromStr);
    if (!Number.isNaN(from.getTime())) {
      conditions.push(gte(systemLogs.createdAt, from));
    }
  }
  if (typeof toStr === "string") {
    const to = new Date(toStr);
    if (!Number.isNaN(to.getTime())) {
      conditions.push(lte(systemLogs.createdAt, to));
    }
  }

  const rows = await db
    .select()
    .from(systemLogs)
    .where(and(...conditions))
    .orderBy(desc(systemLogs.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({ logs: rows, limit, offset });
}

// GET /api/admin/webhooks/stripe — list with event_type/processed filters.
async function handleListStripeWebhooks(
  req: Request,
  res: Response,
): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();

  const eventTypeFilter = req.query.event_type;
  const processedFilter = req.query.processed;
  const conditions = [];
  if (typeof eventTypeFilter === "string" && eventTypeFilter.length > 0) {
    conditions.push(eq(stripeWebhookEvents.eventType, eventTypeFilter));
  }
  if (processedFilter === "true") {
    conditions.push(eq(stripeWebhookEvents.processed, true));
  }
  if (processedFilter === "false") {
    conditions.push(eq(stripeWebhookEvents.processed, false));
  }

  const rows = await db
    .select()
    .from(stripeWebhookEvents)
    .where(and(...conditions))
    .orderBy(desc(stripeWebhookEvents.receivedAt))
    .limit(limit)
    .offset(offset);

  res.json({ events: rows, limit, offset });
}

// POST /api/admin/webhooks/stripe/:id/retry — reset processed state.
async function handleRetryStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  const db = getDb();

  const [event] = await db
    .select({
      id: stripeWebhookEvents.id,
      eventType: stripeWebhookEvents.eventType,
    })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.id, pathParam(req, "id")))
    .limit(1);

  if (!event) {
    res.status(404).json({ error: "webhook_event_not_found" });
    return;
  }

  // Reset processed state so a future delivery/retry re-processes cleanly.
  // v1 does NOT re-invoke the handler synchronously — that would require
  // extracting routeStripeEvent from the webhook route. Deferred to Sprint 10.5+.
  await db
    .update(stripeWebhookEvents)
    .set({ processed: false, processedAt: null, processingError: null })
    .where(eq(stripeWebhookEvents.id, event.id));

  await logSystem("info", "admin", "stripe_webhook_reset_for_retry", {
    admin_user_id: ctx.userId,
    event_id: event.id,
    event_type: event.eventType,
  });

  res.json({
    success: true,
    note: "Event reset to unprocessed. Full synchronous retry: Sprint 10.5+.",
  });
}

// GET /api/admin/webhooks/github — list with event_type/processed filters.
async function handleListGithubWebhooks(
  req: Request,
  res: Response,
): Promise<void> {
  const { limit, offset } = parsePagination(req);
  const db = getDb();

  const eventTypeFilter = req.query.event_type;
  const processedFilter = req.query.processed;
  const conditions = [];
  if (typeof eventTypeFilter === "string" && eventTypeFilter.length > 0) {
    conditions.push(eq(githubWebhookEvents.eventType, eventTypeFilter));
  }
  if (processedFilter === "true") {
    conditions.push(eq(githubWebhookEvents.processed, true));
  }
  if (processedFilter === "false") {
    conditions.push(eq(githubWebhookEvents.processed, false));
  }

  const rows = await db
    .select()
    .from(githubWebhookEvents)
    .where(and(...conditions))
    .orderBy(desc(githubWebhookEvents.receivedAt))
    .limit(limit)
    .offset(offset);

  res.json({ events: rows, limit, offset });
}

export function registerAdminRoutes(app: Express): void {
  // Ops diagnostics — bearer-token-gated, DB-optional. Not is_admin.
  app.get(
    "/api/admin/diagnostics",
    requireDiagnosticsToken,
    handleDiagnostics,
  );

  // Admin panel — is_admin-gated (requireAuth + requireHydratedUser + requireAdmin).
  const guards = [requireAuth, requireHydratedUser, requireAdmin] as const;

  app.get("/api/admin/dashboard", ...guards, handleDashboard);
  app.get("/api/admin/users", ...guards, handleListUsers);
  app.get("/api/admin/users/:id", ...guards, handleGetUser);
  app.patch("/api/admin/users/:id/tier", ...guards, handleSetTier);
  app.get("/api/admin/subscriptions", ...guards, handleListSubscriptions);
  app.post(
    "/api/admin/subscriptions/:id/cancel",
    ...guards,
    handleCancelSubscription,
  );
  app.get("/api/admin/integrations", ...guards, handleListIntegrations);
  app.get("/api/admin/logs", ...guards, handleListLogs);
  app.get("/api/admin/webhooks/stripe", ...guards, handleListStripeWebhooks);
  app.post(
    "/api/admin/webhooks/stripe/:id/retry",
    ...guards,
    handleRetryStripeWebhook,
  );
  app.get("/api/admin/webhooks/github", ...guards, handleListGithubWebhooks);
}
