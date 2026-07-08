import { and, asc, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import {
  platformCredentials,
  projectProvisioningEvents,
  projects,
} from "../db/schema.js";
import { runGenesis } from "../lib/genesis/index.js";
import { logSystem, logUserAction } from "../lib/logging.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import type { Platform } from "../lib/platforms/index.js";
import { deriveSlugFromText } from "../lib/slug.js";
import { checkCanCreateProject } from "../lib/tiers.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]+$/;
const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 5000;
const MIN_SLUG_CHARS = 2;
const MAX_SLUG_CHARS = 50;
const MAX_SLUG_RETRIES = 5;

// The three Project Genesis templates; mirrors the projects.template_choice
// CHECK constraint. Local to the route layer so it doesn't couple to genesis
// internals — the orchestrator validates independently.
const TEMPLATE_CHOICES = ["html-js", "sveltekit", "nextjs"] as const;
type TemplateChoice = (typeof TEMPLATE_CHOICES)[number];
const DEFAULT_TEMPLATE_CHOICE: TemplateChoice = "html-js";

function isTemplateChoice(value: unknown): value is TemplateChoice {
  return (
    typeof value === "string" &&
    (TEMPLATE_CHOICES as readonly string[]).includes(value)
  );
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  provisioningState: string;
  templateChoice: string;
  subdomain: string | null;
  deployedUrl: string | null;
  organizationId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const projectProjection = {
  id: projects.id,
  name: projects.name,
  slug: projects.slug,
  description: projects.description,
  provisioningState: projects.provisioningState,
  templateChoice: projects.templateChoice,
  subdomain: projects.subdomain,
  deployedUrl: projects.deployedUrl,
  organizationId: projects.organizationId,
  createdByUserId: projects.createdByUserId,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
} as const;

function getCtx(req: Request): AuthedUserContext {
  // Guaranteed by requireHydratedUser running before this handler.
  return req.user!;
}

function toResponse(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    provisioning_state: p.provisioningState,
    template_choice: p.templateChoice,
    subdomain: p.subdomain,
    deployed_url: p.deployedUrl,
    organization_id: p.organizationId,
    created_by_user_id: p.createdByUserId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

interface ParsedBody {
  name: string;
  description: string | null;
  slug: string | undefined; // explicit slug from caller; undefined → derive
  templateChoice: TemplateChoice; // defaults to html-js when omitted
}

function parseBody(req: Request, res: Response): ParsedBody | null {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = body.name;
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_NAME_CHARS) {
    res.status(400).json({ error: "invalid_name" });
    return null;
  }

  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (
      typeof body.description !== "string" ||
      body.description.length > MAX_DESCRIPTION_CHARS
    ) {
      res.status(400).json({ error: "invalid_description" });
      return null;
    }
    description = body.description;
  }

  let slug: string | undefined;
  if (
    body.slug !== undefined &&
    body.slug !== null &&
    body.slug !== ""
  ) {
    if (
      typeof body.slug !== "string" ||
      body.slug.length < MIN_SLUG_CHARS ||
      body.slug.length > MAX_SLUG_CHARS ||
      !SLUG_RE.test(body.slug)
    ) {
      res.status(400).json({
        error: "invalid_slug",
        reason: `Slug must be ${MIN_SLUG_CHARS}-${MAX_SLUG_CHARS} chars of lowercase letters, digits, or hyphens.`,
      });
      return null;
    }
    slug = body.slug;
  }

  // template_choice is optional; omitted/null defaults to html-js (matches the
  // DB default). Any other non-allowed value is a hard 400.
  let templateChoice: TemplateChoice = DEFAULT_TEMPLATE_CHOICE;
  if (body.template_choice !== undefined && body.template_choice !== null) {
    if (!isTemplateChoice(body.template_choice)) {
      res.status(400).json({ error: "invalid_template_choice" });
      return null;
    }
    templateChoice = body.template_choice;
  }

  return { name, description, slug, templateChoice };
}

async function handleCreateProject(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  if (!ctx.organizationId) {
    res.status(400).json({
      error: "no_organization",
      reason: "User is not in an organization.",
    });
    return;
  }
  const organizationId = ctx.organizationId;

  // Feature gate: Free tier is limited to 1 project. Enforced on CREATE only —
  // existing projects are never touched. A downgraded Pro user keeps their
  // projects but can't create more.
  const gate = await checkCanCreateProject(ctx.userId);
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

  const body = parseBody(req, res);
  if (!body) return;

  const baseSlug = body.slug ?? deriveSlugFromText(body.name);
  if (!baseSlug) {
    res.status(400).json({
      error: "invalid_slug",
      reason: "Could not derive a usable slug from the project name.",
    });
    return;
  }

  const candidates: string[] = [baseSlug];
  for (let i = 2; i <= MAX_SLUG_RETRIES; i++) {
    candidates.push(`${baseSlug}-${i}`);
  }
  candidates.push(`${baseSlug}-${ctx.userId.slice(0, 8)}`);

  const db = getDb();

  let inserted: ProjectRow | undefined;
  for (const slug of candidates) {
    const [row] = await db
      .insert(projects)
      .values({
        organizationId,
        name: body.name,
        slug,
        description: body.description,
        templateChoice: body.templateChoice,
        createdByUserId: ctx.userId,
      })
      .onConflictDoNothing({
        target: [projects.organizationId, projects.slug],
      })
      .returning(projectProjection);
    if (row) {
      inserted = row;
      break;
    }
  }

  if (!inserted) {
    res.status(409).json({
      error: "slug_unavailable",
      reason: `Could not allocate a unique slug for organization based on '${baseSlug}'.`,
    });
    return;
  }

  await logUserAction(
    ctx.userId,
    "create_project",
    "project",
    inserted.id,
    ctx.organizationId,
    { slug: inserted.slug },
  );

  res.status(201).json(toResponse(inserted));
}

async function handleListProjects(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  const rows = await getDb()
    .select(projectProjection)
    .from(projects)
    .where(orgScopeFilter(projects, ctx))
    .orderBy(desc(projects.createdAt));

  res.status(200).json({ projects: rows.map(toResponse) });
}

async function handleDeleteProject(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  const projectId = req.params.id;
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  const db = getDb();

  const removed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        slug: projects.slug,
      })
      .from(projects)
      .where(
        and(orgScopeFilter(projects, ctx), eq(projects.id, projectId)),
      )
      .limit(1);
    if (!row) return null;

    // Belt-and-braces: SELECT above is already org-scoped, but the explicit
    // assertion catches the case where a future change drops the scope.
    assertOrgAccess(row.organizationId, ctx);

    await tx
      .delete(projects)
      .where(
        and(orgScopeFilter(projects, ctx), eq(projects.id, row.id)),
      );

    return row;
  });

  if (!removed) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  await logUserAction(
    ctx.userId,
    "delete_project",
    "project",
    removed.id,
    ctx.organizationId,
    { slug: removed.slug },
  );

  res.status(200).json({ id: removed.id, deleted: true });
}

const GENESIS_REQUIRED_PLATFORMS: Platform[] = [
  "vercel",
  "render",
  "github",
  "supabase",
];

async function handleStartGenesis(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);
  if (!ctx.organizationId) {
    res.status(400).json({
      error: "no_organization",
      reason: "User is not in an organization.",
    });
    return;
  }

  const projectId = req.params.id;
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  const db = getDb();

  const [project] = await db
    .select({
      id: projects.id,
      provisioningState: projects.provisioningState,
    })
    .from(projects)
    .where(and(orgScopeFilter(projects, ctx), eq(projects.id, projectId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  // Launchable only from a terminal-but-retryable state. Everything else is a
  // 409 with a code the frontend can branch on.
  switch (project.provisioningState) {
    case "provisioning":
      res.status(409).json({ error: "already_provisioning" });
      return;
    case "provisioned":
      res.status(409).json({ error: "already_provisioned" });
      return;
    case "rolled_back":
      res.status(409).json({ error: "manual_intervention_required" });
      return;
    case "not_started":
    case "failed":
      break;
    default:
      // Unknown/unexpected state — refuse rather than launch blindly.
      res.status(409).json({ error: "not_launchable" });
      return;
  }

  // The starting user must have all four platform credentials. The orchestrator
  // re-checks (against the project creator's set) as the authoritative source,
  // but this gives the caller immediate, specific feedback.
  const credRows = await db
    .select({ platform: platformCredentials.platform })
    .from(platformCredentials)
    .where(
      and(
        orgScopeFilter(platformCredentials, ctx),
        eq(platformCredentials.userId, ctx.userId),
      ),
    );
  const present = new Set(credRows.map((r) => r.platform));
  const missing = GENESIS_REQUIRED_PLATFORMS.filter((p) => !present.has(p));
  if (missing.length > 0) {
    res.status(400).json({ error: "missing_platform_credentials", missing });
    return;
  }

  await db
    .update(projects)
    .set({ provisioningState: "provisioning", updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  await logUserAction(
    ctx.userId,
    "start_genesis",
    "project",
    projectId,
    ctx.organizationId,
    { user_id: ctx.userId },
  );

  // Detached: the orchestrator runs in the background, reporting progress via
  // project_provisioning_events rows. Never awaited — the request returns 202
  // immediately. A crash is logged here; the orchestrator also marks the
  // project failed internally.
  void runGenesis(projectId).catch((err) => {
    void logSystem(
      "error",
      "genesis",
      `Detached runGenesis rejected for project ${projectId}`,
      {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  });

  res.status(202).json({
    id: projectId,
    provisioning_state: "provisioning",
    message:
      "Genesis started. Subscribe to /api/projects/:id/provisioning-events for progress.",
  });
}

// --- SSE: GET /api/projects/:id/provisioning-events ------------------------
// Tails project_provisioning_events to the browser in real time. Read-only:
// only the orchestrator writes events. 1-second DB poll (Sprint 6+ may move to
// LISTEN/NOTIFY). Heartbeats + buffering-defeat headers keep the connection
// alive through Cloudflare/Render.

const SSE_POLL_MS = 1000;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_HARD_TIMEOUT_MS = 15 * 60_000;
const SSE_MAX_EVENTS = 500;
// Once a poll requires this many quiet cycles (no row changes) AFTER the project
// reached a terminal state, we send `done`. The buffer exists because the
// failure path writes its rollback_summary event AFTER flipping project state,
// so closing the instant we see a terminal state could drop that final row.
const SSE_TERMINAL_QUIET_POLLS = 2;
const SSE_TERMINAL_STATES = new Set(["provisioned", "failed", "rolled_back"]);

const provisioningEventProjection = {
  id: projectProvisioningEvents.id,
  projectId: projectProvisioningEvents.projectId,
  stepName: projectProvisioningEvents.stepName,
  status: projectProvisioningEvents.status,
  startedAt: projectProvisioningEvents.startedAt,
  completedAt: projectProvisioningEvents.completedAt,
  details: projectProvisioningEvents.details,
  errorMessage: projectProvisioningEvents.errorMessage,
  createdAt: projectProvisioningEvents.createdAt,
} as const;

interface ProvisioningEventRow {
  id: string;
  projectId: string;
  stepName: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  details: unknown;
  errorMessage: string | null;
  createdAt: Date;
}

function toEventResponse(row: ProvisioningEventRow) {
  return {
    id: row.id,
    project_id: row.projectId,
    step_name: row.stepName,
    status: row.status,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    details: row.details,
    error_message: row.errorMessage,
    created_at: row.createdAt,
  };
}

// A row mutates in place (pending → in_progress → terminal). The signature lets
// the poll re-emit a row when its status/timestamps change rather than only on
// first sight — event-row ids are random UUIDs, so an id-only cursor wouldn't
// catch updates and isn't monotonic anyway.
function eventSignature(row: ProvisioningEventRow): string {
  return [
    row.status,
    row.startedAt?.toISOString() ?? "",
    row.completedAt?.toISOString() ?? "",
  ].join("|");
}

function doneMessage(state: string): string {
  switch (state) {
    case "provisioned":
      return "Project provisioned successfully.";
    case "rolled_back":
      return "Provisioning failed; all created resources were rolled back cleanly.";
    case "failed":
      return "Provisioning failed. Some resources may require manual cleanup.";
    default:
      return "Provisioning finished.";
  }
}

async function handleProvisioningEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = getCtx(req);

  const projectId = req.params.id;
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  const db = getDb();

  const [project] = await db
    .select({
      id: projects.id,
      provisioningState: projects.provisioningState,
    })
    .from(projects)
    .where(and(orgScopeFilter(projects, ctx), eq(projects.id, projectId)))
    .limit(1);

  if (!project) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }

  // Switch the response into SSE mode. no-transform + X-Accel-Buffering defeat
  // proxy response buffering (Cloudflare/Render/nginx).
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let closed = false;
  let lastWriteAt = Date.now();
  let quietTerminalPolls = 0;
  // id → last-emitted signature, so we only push a row when something changed.
  const emittedSignatures = new Map<string, string>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const write = (chunk: string): void => {
    if (closed) return;
    res.write(chunk);
    lastWriteAt = Date.now();
  };
  const writeEvent = (event: string, data: unknown): void => {
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
  };
  const endStream = (): void => {
    if (closed) return;
    cleanup();
    res.end();
  };

  // Client navigated away / closed the tab — stop polling, free the timers.
  req.on("close", cleanup);

  // Initial snapshot count for the connected event.
  let eventsSoFar = 0;
  try {
    const existing = await db
      .select({ id: projectProvisioningEvents.id })
      .from(projectProvisioningEvents)
      .where(eq(projectProvisioningEvents.projectId, projectId));
    eventsSoFar = existing.length;
  } catch {
    // best-effort; a failed count shouldn't abort the stream
  }
  writeEvent("connected", {
    projectId,
    provisioningState: project.provisioningState,
    eventsSoFar,
  });

  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const rows = (await db
        .select(provisioningEventProjection)
        .from(projectProvisioningEvents)
        .where(eq(projectProvisioningEvents.projectId, projectId))
        .orderBy(
          asc(projectProvisioningEvents.createdAt),
          asc(projectProvisioningEvents.id),
        )
        .limit(SSE_MAX_EVENTS)) as ProvisioningEventRow[];

      let emitted = 0;
      for (const row of rows) {
        const sig = eventSignature(row);
        if (emittedSignatures.get(row.id) === sig) continue;
        emittedSignatures.set(row.id, sig);
        writeEvent("provisioning_event", toEventResponse(row));
        emitted++;
      }

      const [current] = await db
        .select({ provisioningState: projects.provisioningState })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const state = current?.provisioningState ?? project.provisioningState;

      if (SSE_TERMINAL_STATES.has(state)) {
        quietTerminalPolls = emitted > 0 ? 0 : quietTerminalPolls + 1;
        if (quietTerminalPolls >= SSE_TERMINAL_QUIET_POLLS) {
          writeEvent("done", {
            projectId,
            finalState: state,
            message: doneMessage(state),
          });
          endStream();
          return;
        }
      } else {
        quietTerminalPolls = 0;
      }
    } catch {
      // Unexpected DB error mid-stream — tell the client and close so it can
      // re-subscribe rather than hang on a dead connection.
      writeEvent("error", { reason: "stream_error" });
      endStream();
      return;
    }
    if (!closed) pollTimer = setTimeout(() => void poll(), SSE_POLL_MS);
  };

  // Heartbeat comment defeats idle-connection killers (Cloudflare ~100s).
  heartbeatTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastWriteAt >= SSE_HEARTBEAT_MS) {
      write(": ping\n\n");
    }
  }, SSE_HEARTBEAT_MS);

  // Safety valve: a run that somehow outlives the window gets cut loose; the
  // client can re-subscribe and pick up where it left off (events replay).
  hardTimeoutTimer = setTimeout(() => {
    if (closed) return;
    writeEvent("timeout", {
      reason: "orchestrator exceeded 15 minute window",
    });
    endStream();
  }, SSE_HARD_TIMEOUT_MS);

  void poll();
}

export function registerProjectsRoutes(app: Express): void {
  app.post(
    "/api/projects",
    requireAuth,
    requireHydratedUser,
    handleCreateProject,
  );
  app.get(
    "/api/projects",
    requireAuth,
    requireHydratedUser,
    handleListProjects,
  );
  app.delete(
    "/api/projects/:id",
    requireAuth,
    requireHydratedUser,
    handleDeleteProject,
  );
  app.post(
    "/api/projects/:id/genesis",
    requireAuth,
    requireHydratedUser,
    handleStartGenesis,
  );
  app.get(
    "/api/projects/:id/provisioning-events",
    requireAuth,
    requireHydratedUser,
    handleProvisioningEvents,
  );
}
