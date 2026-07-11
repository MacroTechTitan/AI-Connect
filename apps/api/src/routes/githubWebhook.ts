import { eq } from "drizzle-orm";
import express, { type Express, type Request, type Response } from "express";

import { getDb } from "../db/client.js";
import { githubInstallations, githubWebhookEvents } from "../db/schema.js";
import { GithubError, githubClient } from "../lib/integrations/githubClient.js";
import { logSystem } from "../lib/logging.js";

/**
 * GitHub webhook handler.
 *
 * Flow:
 * 1. Verify signature (X-Hub-Signature-256 header via HMAC-SHA256)
 * 2. Insert event into github_webhook_events; PK conflict = duplicate, skip
 * 3. Route event to appropriate handler based on X-GitHub-Event header
 *    and payload.action
 * 4. On success: update processed=true, processed_at=now()
 * 5. On failure: log processing_error, return 500 (GitHub retries)
 *
 * Same infrastructure pattern as Sprint 9's Stripe webhook.
 * Route uses express.raw() so req.body is a Buffer, not a parsed object.
 */

// The subset of a GitHub webhook payload the v1 handlers read. External,
// untrusted JSON — everything is optional and defensively narrowed.
interface GithubWebhookPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string };
    permissions?: Record<string, unknown>;
    repository_selection?: string;
  };
  repository?: { full_name?: string };
  repositories_added?: unknown[];
  repositories_removed?: unknown[];
}

// node-postgres surfaces a unique_violation (PK conflict) as error.code
// "23505". For github_webhook_events the PK is the X-GitHub-Delivery id, so a
// 23505 on INSERT means GitHub re-delivered an event we already recorded.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

// GitHub sends X-GitHub-Delivery (a UUID) on every webhook.
function getDeliveryId(req: Request): string | null {
  const id = req.headers["x-github-delivery"];
  return typeof id === "string" ? id : null;
}

function getEventType(req: Request): string | null {
  const type = req.headers["x-github-event"];
  return typeof type === "string" ? type : null;
}

function getSignature(req: Request): string | null {
  const sig = req.headers["x-hub-signature-256"];
  return typeof sig === "string" ? sig : null;
}

export async function handleGithubWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const deliveryId = getDeliveryId(req);
  const eventType = getEventType(req);
  const signature = getSignature(req);

  if (!deliveryId || !eventType) {
    res.status(400).json({
      error: "missing_headers",
      message: "x-github-delivery and x-github-event headers are required.",
    });
    return;
  }

  // Step 1: Verify signature — req.body is a Buffer (from express.raw).
  const rawBody = (req.body as Buffer).toString("utf8");
  let valid: boolean;
  try {
    valid = await githubClient.verifyWebhookSignature(
      rawBody,
      signature ?? undefined,
    );
  } catch (err) {
    // Only thrown when GITHUB_APP_WEBHOOK_SECRET is unset (a config problem,
    // not the caller's fault). Surface as 500 rather than a silent crash.
    const message = err instanceof GithubError ? err.message : "unknown error";
    await logSystem("error", "github_webhook", "webhook_not_configured", {
      delivery_id: deliveryId,
      event_type: eventType,
      error: message,
    });
    res.status(500).json({ error: "webhook_not_configured", message });
    return;
  }

  if (!valid) {
    await logSystem(
      "warn",
      "github_webhook",
      "signature_verification_failed",
      {
        delivery_id: deliveryId,
        event_type: eventType,
        signature_present: !!signature,
      },
    );
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  // Parse the payload for handler use.
  let event: GithubWebhookPayload;
  try {
    event = JSON.parse(rawBody) as GithubWebhookPayload;
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  // Step 2: Idempotency via PK conflict on delivery ID.
  const db = getDb();
  let isDuplicate = false;

  try {
    await db.insert(githubWebhookEvents).values({
      id: deliveryId,
      eventType,
      payload: event as unknown as Record<string, unknown>,
      processed: false,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      isDuplicate = true;
    } else {
      await logSystem("error", "github_webhook", "db_insert_failed", {
        delivery_id: deliveryId,
        event_type: eventType,
        error: (err as Error).message ?? "",
      });
      res.status(500).json({ error: "db_error" });
      return;
    }
  }

  if (isDuplicate) {
    await logSystem("info", "github_webhook", "duplicate_event_skipped", {
      delivery_id: deliveryId,
      event_type: eventType,
    });
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  // Step 3: Route event to handler.
  try {
    await routeGithubEvent(eventType, event);

    await db
      .update(githubWebhookEvents)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(githubWebhookEvents.id, deliveryId));

    await logSystem("info", "github_webhook", "event_processed", {
      delivery_id: deliveryId,
      event_type: eventType,
      action: event.action,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    const errMsg = (err as Error).message ?? "Unknown error";
    await db
      .update(githubWebhookEvents)
      .set({ processingError: errMsg })
      .where(eq(githubWebhookEvents.id, deliveryId));

    await logSystem("error", "github_webhook", "handler_failed", {
      delivery_id: deliveryId,
      event_type: eventType,
      error: errMsg,
    });

    res.status(500).json({ error: "handler_failed", message: errMsg });
  }
}

/**
 * Routes GitHub webhook events to handlers.
 * v1 handles installation lifecycle events fully. Others are stubbed
 * (log-only) — real bot logic ships in Sprint 11+ (Maximus AI integration).
 */
async function routeGithubEvent(
  eventType: string,
  event: GithubWebhookPayload,
): Promise<void> {
  const action = event.action;

  switch (eventType) {
    // ============================================================
    // Installation lifecycle
    // ============================================================
    case "installation": {
      if (action === "created") {
        await handleInstallationCreated(event);
      } else if (action === "deleted") {
        await handleInstallationDeleted(event);
      } else if (action === "suspend") {
        await handleInstallationSuspended(event);
      } else if (action === "unsuspend") {
        await handleInstallationUnsuspended(event);
      } else {
        await logSystem(
          "info",
          "github_webhook",
          "installation_action_unhandled",
          {
            action,
            installation_id: event.installation?.id,
          },
        );
      }
      break;
    }

    case "installation_repositories": {
      // v1: log only. Repos are fetched on-demand from GitHub, not stored.
      await logSystem(
        "info",
        "github_webhook",
        "installation_repositories_changed",
        {
          action,
          installation_id: event.installation?.id,
          added: event.repositories_added?.length ?? 0,
          removed: event.repositories_removed?.length ?? 0,
        },
      );
      break;
    }

    // ============================================================
    // Repo activity — stubs for Sprint 11+ Maximus AI integration
    // ============================================================
    case "push":
    case "pull_request":
    case "issues":
    case "issue_comment":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread":
    case "check_run":
    case "check_suite": {
      await logSystem("info", "github_webhook", "stub_bot_event", {
        event_type: eventType,
        action,
        installation_id: event.installation?.id,
        repo: event.repository?.full_name,
      });
      break;
    }

    default:
      await logSystem("info", "github_webhook", "unhandled_event_type", {
        event_type: eventType,
        action,
      });
  }
}

// ============================================================
// Installation lifecycle handlers
// ============================================================

/**
 * installation.created:
 * Fires when a user installs the App on their account/org.
 *
 * We do NOT create the github_installations row here — that happens in the
 * OAuth callback route (Commit 6), which has the AI Connect user_id linkage
 * from the OAuth state parameter. This webhook could fire BEFORE the OAuth
 * callback completes.
 *
 * Instead: if a matching row already exists (OAuth callback already ran),
 * refresh its permissions snapshot; otherwise log and rely on the callback.
 */
async function handleInstallationCreated(
  event: GithubWebhookPayload,
): Promise<void> {
  const installation = event.installation;
  if (!installation?.id) {
    throw new Error("installation.created event missing installation.id");
  }
  const installationId = installation.id;

  const db = getDb();
  const existing = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing) {
    // OAuth callback already created the row — refresh permissions snapshot.
    await db
      .update(githubInstallations)
      .set({
        permissions: installation.permissions ?? {},
        repositorySelection: installation.repository_selection ?? "all",
        suspendedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(githubInstallations.installationId, installationId));

    await logSystem(
      "info",
      "github_webhook",
      "installation_created_row_updated",
      {
        installation_id: installationId,
      },
    );
  } else {
    // Webhook arrived before OAuth callback — rely on the callback to insert.
    // If it never runs (user closed the tab), GitHub has an installation we
    // don't track. Sprint 10.5+ could add reconciliation.
    await logSystem(
      "info",
      "github_webhook",
      "installation_created_awaiting_oauth",
      {
        installation_id: installationId,
        account_login: installation.account?.login,
      },
    );
  }
}

async function handleInstallationDeleted(
  event: GithubWebhookPayload,
): Promise<void> {
  const installation = event.installation;
  if (!installation?.id) {
    throw new Error("installation.deleted event missing installation.id");
  }

  const db = getDb();
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, installation.id));

  await logSystem("info", "github_webhook", "installation_deleted", {
    installation_id: installation.id,
  });
}

async function handleInstallationSuspended(
  event: GithubWebhookPayload,
): Promise<void> {
  const installation = event.installation;
  if (!installation?.id) return;

  const db = getDb();
  await db
    .update(githubInstallations)
    .set({ suspendedAt: new Date(), updatedAt: new Date() })
    .where(eq(githubInstallations.installationId, installation.id));

  await logSystem("info", "github_webhook", "installation_suspended", {
    installation_id: installation.id,
  });
}

async function handleInstallationUnsuspended(
  event: GithubWebhookPayload,
): Promise<void> {
  const installation = event.installation;
  if (!installation?.id) return;

  const db = getDb();
  await db
    .update(githubInstallations)
    .set({ suspendedAt: null, updatedAt: new Date() })
    .where(eq(githubInstallations.installationId, installation.id));

  await logSystem("info", "github_webhook", "installation_unsuspended", {
    installation_id: installation.id,
  });
}

// ============================================================
// Route registration
// ============================================================

/**
 * Registers the GitHub webhook route.
 *
 * CRITICAL: this route uses express.raw() so req.body is the unparsed Buffer
 * GitHub signature verification needs. It must be mounted BEFORE the app's
 * general express.json() middleware — otherwise express.json() consumes the
 * request stream first and the raw bytes are lost. It is also deliberately
 * NOT behind requireAuth: GitHub authenticates via the X-Hub-Signature-256
 * header, not an Auth0 bearer token.
 */
export function registerGithubWebhookRoutes(app: Express): void {
  app.post(
    "/api/github/webhook",
    express.raw({ type: "application/json" }),
    handleGithubWebhook,
  );
}
