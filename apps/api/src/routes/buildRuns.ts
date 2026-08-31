// DevOS Agentic Build Control — Build Run API (Issue #19).
//
// Build Control is the supervision layer ABOVE AI Connect execution. These
// routes own run lifecycle, the normalized event timeline, independent review
// verdicts, and the human approval gate. They do NOT execute anything: no
// worker is launched here. Dispatch lands in a later slice.
//
// Every route is Auth0-gated and organization-scoped. A run is addressed by id
// but never loaded without its org filter, so one organization can neither
// read nor drive another's runs.

import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { getDb } from "../db/client.js";
import {
  buildApprovals,
  buildEvents,
  buildReviews,
  buildRuns,
  projects,
} from "../db/schema.js";
import { logSystem, logUserAction } from "../lib/logging.js";
import { isUniqueViolation } from "../lib/pgErrors.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import {
  allowedActions,
  evaluateReleaseStatus,
  nextState,
  REVIEW_VERDICTS,
  type BuildRunAction,
  type BuildRunState,
  type CompletionGate,
  type ReviewVerdict,
} from "../lib/buildControl/stateMachine.js";
import { requireAuth, requireHydratedUser } from "../middleware/requireAuth.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one-active-run-per-project partial index is the authority on
// concurrency, so we surface its rejection as a 409 rather than racing a
// SELECT-then-INSERT check that two requests could both pass. Naming the index
// explicitly keeps an unrelated collision inside the same transaction from
// being reported as "you already have an active run".
const ONE_ACTIVE_RUN_INDEX = "build_runs_one_active_per_project_idx";

const MAX_TITLE = 200;
const MAX_TEXT = 5000;
const MAX_LIST_ITEMS = 50;
const MAX_EVENTS_LIMIT = 500;
const DEFAULT_EVENTS_LIMIT = 100;

// Express 4 does not catch rejections from async handlers, which would leave
// the request hanging and surface as an unhandled rejection. Every handler
// below is wrapped.
function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function getCtx(req: Request): AuthedUserContext {
  // Guaranteed by requireHydratedUser running before this handler.
  return req.user!;
}

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const stringList = (max: number) =>
  z.array(boundedString(max)).max(MAX_LIST_ITEMS).default([]);

const createRunSchema = z.object({
  project_id: z.string().regex(UUID_RE),
  title: boundedString(MAX_TITLE),
  goal: boundedString(MAX_TEXT),
  acceptance_criteria: stringList(MAX_TEXT),
  out_of_scope: stringList(MAX_TEXT),
  stop_and_ask: stringList(MAX_TEXT),
  worker_type: z.literal("claude_code").default("claude_code"),
  worker_version: boundedString(100).optional(),
  // Feature Registry preflight (docs/FEATURE_REGISTRY_INTEGRATION.md). The
  // registry does not exist yet, so the packet is accepted as opaque JSON and
  // feature_id is an external reference rather than a foreign key.
  feature_id: boundedString(200).optional(),
  feature_work_packet: z.record(z.unknown()).optional(),
});

const noteSchema = z.object({
  note: z.string().trim().max(MAX_TEXT).optional(),
});

const instructSchema = z.object({
  instruction: boundedString(MAX_TEXT),
});

const completionGateSchema = z.object({
  gate: boundedString(100),
  status: z.enum(["PASS", "FAIL"]),
  required: z.boolean().default(true),
  detail: z.string().trim().max(MAX_TEXT).optional(),
});

const reviewSchema = z.object({
  reviewer: boundedString(100),
  reviewer_version: boundedString(100).optional(),
  verdict: z.enum(REVIEW_VERDICTS),
  summary: z.string().trim().max(MAX_TEXT).optional(),
  findings: z
    .array(
      z.object({
        title: boundedString(200),
        detail: z.string().trim().max(MAX_TEXT).optional(),
        severity: z.enum(["info", "warn", "error", "critical"]).default("warn"),
        target: boundedString(500).optional(),
      }),
    )
    .max(MAX_LIST_ITEMS)
    .default([]),
  // Feature completion gates. A run can pass review and still be release
  // blocked; release status is derived from these, never from the verdict.
  completion_gates: z
    .array(completionGateSchema)
    .max(MAX_LIST_ITEMS)
    .default([]),
});

const eventsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EVENTS_LIMIT)
    .default(DEFAULT_EVENTS_LIMIT),
});

const runProjection = {
  id: buildRuns.id,
  organizationId: buildRuns.organizationId,
  projectId: buildRuns.projectId,
  createdByUserId: buildRuns.createdByUserId,
  title: buildRuns.title,
  goal: buildRuns.goal,
  acceptanceCriteria: buildRuns.acceptanceCriteria,
  outOfScope: buildRuns.outOfScope,
  stopAndAsk: buildRuns.stopAndAsk,
  workerType: buildRuns.workerType,
  workerVersion: buildRuns.workerVersion,
  state: buildRuns.state,
  currentActivity: buildRuns.currentActivity,
  branchName: buildRuns.branchName,
  worktreePath: buildRuns.worktreePath,
  filesChanged: buildRuns.filesChanged,
  additions: buildRuns.additions,
  deletions: buildRuns.deletions,
  validationSummary: buildRuns.validationSummary,
  costUsd: buildRuns.costUsd,
  featureId: buildRuns.featureId,
  featureWorkPacket: buildRuns.featureWorkPacket,
  completionGates: buildRuns.completionGates,
  releaseStatus: buildRuns.releaseStatus,
  stopReason: buildRuns.stopReason,
  startedAt: buildRuns.startedAt,
  completedAt: buildRuns.completedAt,
  createdAt: buildRuns.createdAt,
  updatedAt: buildRuns.updatedAt,
} as const;

export function toRunResponse(r: Record<string, unknown>) {
  const state = r.state as BuildRunState;
  return {
    id: r.id,
    organization_id: r.organizationId,
    project_id: r.projectId,
    created_by_user_id: r.createdByUserId,
    title: r.title,
    goal: r.goal,
    acceptance_criteria: r.acceptanceCriteria,
    out_of_scope: r.outOfScope,
    stop_and_ask: r.stopAndAsk,
    worker_type: r.workerType,
    worker_version: r.workerVersion,
    state,
    // Derived so a client never re-implements the transition table.
    allowed_actions: allowedActions(state),
    current_activity: r.currentActivity,
    branch_name: r.branchName,
    worktree_path: r.worktreePath,
    files_changed: r.filesChanged,
    additions: r.additions,
    deletions: r.deletions,
    validation_summary: r.validationSummary,
    cost_usd: r.costUsd,
    feature_id: r.featureId,
    feature_work_packet: r.featureWorkPacket,
    completion_gates: r.completionGates,
    release_status: r.releaseStatus,
    stop_reason: r.stopReason,
    started_at: r.startedAt,
    completed_at: r.completedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

function toEventResponse(e: Record<string, unknown>) {
  return {
    id: e.id,
    build_run_id: e.buildRunId,
    event_type: e.eventType,
    summary: e.summary,
    worker: e.worker,
    affected_target: e.affectedTarget,
    severity: e.severity,
    action_required: e.actionRequired,
    details: e.details,
    occurred_at: e.occurredAt,
  };
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "invalid_body",
    issues: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  });
}

function requireOrg(res: Response, ctx: AuthedUserContext): string | null {
  if (!ctx.organizationId) {
    res.status(400).json({
      error: "no_organization",
      reason: "build runs are organization-scoped; user has no organization",
    });
    return null;
  }
  return ctx.organizationId;
}

// Org-scoped run fetch. Never select from buildRuns without this.
async function loadRun(
  runId: string,
  ctx: AuthedUserContext,
): Promise<Record<string, unknown> | null> {
  const [row] = await getDb()
    .select(runProjection)
    .from(buildRuns)
    .where(and(orgScopeFilter(buildRuns, ctx), eq(buildRuns.id, runId)))
    .limit(1);
  if (!row) return null;
  // Belt-and-braces: the SELECT is already org-scoped; this catches a future
  // change that drops the filter.
  assertOrgAccess(row.organizationId, ctx);
  return row as unknown as Record<string, unknown>;
}

function readRunId(req: Request, res: Response): string | null {
  const id = req.params.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    res.status(404).json({ error: "build_run_not_found" });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function handleCreateRun(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);
  const orgId = requireOrg(res, ctx);
  if (!orgId) return;

  const parsed = createRunSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const body = parsed.data;

  // The project must exist inside the caller's organization. Without this an
  // authenticated user could open a run against another org's project id.
  const [project] = await getDb()
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(and(orgScopeFilter(projects, ctx), eq(projects.id, body.project_id)))
    .limit(1);
  if (!project) {
    res.status(404).json({ error: "project_not_found" });
    return;
  }
  assertOrgAccess(project.organizationId, ctx);

  let created: Record<string, unknown>;
  try {
    created = await getDb().transaction(async (tx) => {
      const [run] = await tx
        .insert(buildRuns)
        .values({
          organizationId: orgId,
          projectId: project.id,
          createdByUserId: ctx.userId,
          title: body.title,
          goal: body.goal,
          acceptanceCriteria: body.acceptance_criteria,
          outOfScope: body.out_of_scope,
          stopAndAsk: body.stop_and_ask,
          workerType: body.worker_type,
          workerVersion: body.worker_version ?? null,
          featureId: body.feature_id ?? null,
          featureWorkPacket: body.feature_work_packet ?? null,
          state: "QUEUED",
        })
        .returning(runProjection);
      if (!run) throw new Error("build run insert returned no row");

      await tx.insert(buildEvents).values({
        organizationId: orgId,
        projectId: project.id,
        buildRunId: run.id,
        eventType: "run.created",
        summary: `Build run created: ${body.title}`,
        severity: "info",
        details: {
          state: "QUEUED",
          feature_id: body.feature_id ?? null,
          has_work_packet: body.feature_work_packet !== undefined,
        },
      });

      return run as unknown as Record<string, unknown>;
    });
  } catch (err) {
    if (isUniqueViolation(err, ONE_ACTIVE_RUN_INDEX)) {
      res.status(409).json({
        error: "active_run_exists",
        reason: "this project already has an active supervised build run",
      });
      return;
    }
    throw err;
  }

  await logUserAction(
    ctx.userId,
    "create_build_run",
    "build_run",
    created.id as string,
    orgId,
    {
      project_id: project.id,
      title: body.title,
      feature_id: body.feature_id ?? null,
    },
  );

  res.status(201).json(toRunResponse(created));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

async function handleGetRun(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);
  const runId = readRunId(req, res);
  if (!runId) return;

  const run = await loadRun(runId, ctx);
  if (!run) {
    res.status(404).json({ error: "build_run_not_found" });
    return;
  }
  res.status(200).json(toRunResponse(run));
}

async function handleListRuns(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);

  const filters = [orgScopeFilter(buildRuns, ctx)];
  const projectId = req.query.project_id;
  if (typeof projectId === "string") {
    if (!UUID_RE.test(projectId)) {
      res.status(400).json({ error: "invalid_project_id" });
      return;
    }
    filters.push(eq(buildRuns.projectId, projectId));
  }

  const rows = await getDb()
    .select(runProjection)
    .from(buildRuns)
    .where(and(...filters))
    .orderBy(desc(buildRuns.createdAt));

  res.status(200).json({
    build_runs: rows.map((r) =>
      toRunResponse(r as unknown as Record<string, unknown>),
    ),
  });
}

async function handleListEvents(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);
  const runId = readRunId(req, res);
  if (!runId) return;

  // Load the run first so an out-of-org run id 404s before any event read.
  const run = await loadRun(runId, ctx);
  if (!run) {
    res.status(404).json({ error: "build_run_not_found" });
    return;
  }

  const parsed = eventsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }

  const rows = await getDb()
    .select({
      id: buildEvents.id,
      buildRunId: buildEvents.buildRunId,
      eventType: buildEvents.eventType,
      summary: buildEvents.summary,
      worker: buildEvents.worker,
      affectedTarget: buildEvents.affectedTarget,
      severity: buildEvents.severity,
      actionRequired: buildEvents.actionRequired,
      details: buildEvents.details,
      occurredAt: buildEvents.occurredAt,
    })
    .from(buildEvents)
    .where(
      and(orgScopeFilter(buildEvents, ctx), eq(buildEvents.buildRunId, runId)),
    )
    .orderBy(desc(buildEvents.occurredAt))
    .limit(parsed.data.limit);

  res.status(200).json({
    build_run_id: runId,
    events: rows.map((r) => toEventResponse(r as unknown as Record<string, unknown>)),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

interface ActionOutcome {
  eventType: string;
  summary: string;
  severity?: "info" | "warn" | "error";
  actionRequired?: boolean;
  details?: Record<string, unknown>;
  extraRunValues?: Record<string, unknown>;
}

type BuildResult =
  | { outcome: ActionOutcome; verdict?: ReviewVerdict }
  | { error: z.ZodError };

type SideEffect = (
  tx: Parameters<
    Parameters<ReturnType<typeof getDb>["transaction"]>[0]
  >[0],
  run: Record<string, unknown>,
  ctx: AuthedUserContext,
) => Promise<void>;

// Shared driver for every lifecycle action. Loads the run org-scoped, asks the
// state machine whether the action is legal, then applies the state change and
// its timeline event in ONE transaction, so a run can never move without the
// event that explains why.
async function applyAction(
  req: Request,
  res: Response,
  action: BuildRunAction,
  build: (run: Record<string, unknown>, ctx: AuthedUserContext) => BuildResult,
  sideEffect?: SideEffect,
): Promise<void> {
  const ctx = getCtx(req);
  const orgId = requireOrg(res, ctx);
  if (!orgId) return;

  const runId = readRunId(req, res);
  if (!runId) return;

  const run = await loadRun(runId, ctx);
  if (!run) {
    res.status(404).json({ error: "build_run_not_found" });
    return;
  }

  const built = build(run, ctx);
  if ("error" in built) {
    badRequest(res, built.error);
    return;
  }

  const currentState = run.state as BuildRunState;
  const transition = nextState({
    state: currentState,
    action,
    verdict: built.verdict,
  });
  if (!transition.ok) {
    res.status(409).json({
      error: "invalid_transition",
      reason: transition.reason,
      from: currentState,
      action,
      allowed_from: transition.allowedFrom,
      allowed_actions: allowedActions(currentState),
    });
    return;
  }

  const { outcome } = built;
  const now = new Date();
  const target = transition.nextState;
  const passedThrough = "passedThrough" in transition ? transition.passedThrough : undefined;

  const updated = await getDb().transaction(async (tx) => {
    // The UPDATE is predicated on the run still being in the state we
    // validated, so two concurrent actions cannot both win.
    const [row] = await tx
      .update(buildRuns)
      .set({
        state: target,
        updatedAt: now,
        ...(action === "start" ? { startedAt: now } : {}),
        ...(target === "COMPLETED" || target === "REJECTED" || target === "STOPPED"
          ? { completedAt: now }
          : {}),
        ...(outcome.extraRunValues ?? {}),
      })
      .where(
        and(
          orgScopeFilter(buildRuns, ctx),
          eq(buildRuns.id, runId),
          eq(buildRuns.state, currentState),
        ),
      )
      .returning(runProjection);

    if (!row) return null;

    // A review submitted from RUNNING passes through REVIEWING. Record that so
    // the timeline shows the state existed rather than implying a jump.
    if (passedThrough) {
      await tx.insert(buildEvents).values({
        organizationId: orgId,
        projectId: row.projectId,
        buildRunId: runId,
        eventType: "run.state_changed",
        summary: `State ${currentState} -> ${passedThrough}`,
        severity: "info",
        details: { from: currentState, to: passedThrough, action },
      });
    }

    await tx.insert(buildEvents).values({
      organizationId: orgId,
      projectId: row.projectId,
      buildRunId: runId,
      eventType: outcome.eventType,
      summary: outcome.summary,
      severity: outcome.severity ?? "info",
      actionRequired: outcome.actionRequired ?? false,
      details: {
        from: currentState,
        to: target,
        action,
        ...(outcome.details ?? {}),
      },
    });

    const typedRow = row as unknown as Record<string, unknown>;
    if (sideEffect) await sideEffect(tx, typedRow, ctx);

    return typedRow;
  });

  if (!updated) {
    // Lost the race: something else moved the run between our read and write.
    res.status(409).json({
      error: "state_changed",
      reason: "the run changed state concurrently; re-read and retry",
    });
    return;
  }

  await logUserAction(
    ctx.userId,
    `build_run_${action}`,
    "build_run",
    runId,
    orgId,
    { from: currentState, to: target },
  );

  res.status(200).json(toRunResponse(updated));
}

function simpleAction(
  action: BuildRunAction,
  eventType: string,
  verb: string,
): RequestHandler {
  return asyncRoute(async (req, res) => {
    await applyAction(req, res, action, () => {
      const parsed = noteSchema.safeParse(req.body ?? {});
      if (!parsed.success) return { error: parsed.error };
      const note = parsed.data.note;
      return {
        outcome: {
          eventType,
          summary: `${verb} by operator`,
          details: note ? { note } : {},
          ...(action === "stop" && note
            ? { extraRunValues: { stopReason: note } }
            : {}),
        },
      };
    });
  });
}

const handleStart = simpleAction("start", "run.started", "Run started");
const handlePause = simpleAction("pause", "run.paused", "Run paused");
const handleResume = simpleAction("resume", "run.resumed", "Run resumed");
const handleStop = simpleAction("stop", "run.stopped", "Run stopped");

const handleInstruct: RequestHandler = asyncRoute(async (req, res) => {
  await applyAction(req, res, "instruct", () => {
    const parsed = instructSchema.safeParse(req.body ?? {});
    if (!parsed.success) return { error: parsed.error };
    return {
      outcome: {
        eventType: "run.instruction",
        summary: "Operator instruction sent to worker",
        actionRequired: true,
        details: { instruction: parsed.data.instruction },
      },
    };
  });
});

const handleReview: RequestHandler = asyncRoute(async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body ?? {});

  await applyAction(
    req,
    res,
    "review",
    () => {
      if (!parsed.success) return { error: parsed.error };
      const b = parsed.data;
      const gates = b.completion_gates as CompletionGate[];
      const releaseStatus = evaluateReleaseStatus(gates);
      return {
        verdict: b.verdict,
        outcome: {
          eventType: "run.reviewed",
          summary: `Independent review: ${b.verdict}`,
          severity: b.verdict === "PASS" ? "info" : "warn",
          actionRequired: b.verdict !== "PASS",
          details: {
            reviewer: b.reviewer,
            verdict: b.verdict,
            finding_count: b.findings.length,
            release_status: releaseStatus,
          },
          extraRunValues: {
            completionGates: gates,
            releaseStatus,
          },
        },
      };
    },
    async (tx, run, ctx) => {
      if (!parsed.success) return;
      const b = parsed.data;
      await tx.insert(buildReviews).values({
        organizationId: ctx.organizationId as string,
        projectId: run.projectId as string,
        buildRunId: run.id as string,
        reviewer: b.reviewer,
        reviewerVersion: b.reviewer_version ?? null,
        verdict: b.verdict,
        findings: b.findings,
        summary: b.summary ?? null,
      });
    },
  );
});

// Event types are a consumer-facing vocabulary, so they are spelled out rather
// than derived from the action name — `run.${action}d` quietly produced
// "run.rejectd" and nothing filtering on "run.rejected" would ever have matched.
const DECISION_EVENT_TYPE = {
  approve: "run.approved",
  reject: "run.rejected",
} as const;

function decisionAction(action: "approve" | "reject"): RequestHandler {
  const decision = action === "approve" ? "APPROVE" : "REJECT";
  const eventType = DECISION_EVENT_TYPE[action];
  return asyncRoute(async (req, res) => {
    const parsed = noteSchema.safeParse(req.body ?? {});

    await applyAction(
      req,
      res,
      action,
      (run) => {
        if (!parsed.success) return { error: parsed.error };
        // Release eligibility is a product gate, not an approval side effect:
        // approving a run whose required gates fail does NOT make it
        // releasable. The recorded release_status is deliberately untouched.
        return {
          outcome: {
            eventType,
            summary: `Human ${decision} recorded`,
            details: {
              decision,
              release_status: run.releaseStatus,
              ...(parsed.data.note ? { note: parsed.data.note } : {}),
            },
          },
        };
      },
      async (tx, run, ctx) => {
        if (!parsed.success) return;
        await tx.insert(buildApprovals).values({
          organizationId: ctx.organizationId as string,
          projectId: run.projectId as string,
          buildRunId: run.id as string,
          decidedByUserId: ctx.userId,
          decision,
          note: parsed.data.note ?? null,
        });
      },
    );
  });
}

const handleApprove = decisionAction("approve");
const handleReject = decisionAction("reject");

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBuildRunRoutes(app: Express): void {
  app.post(
    "/api/build-runs",
    requireAuth,
    requireHydratedUser,
    asyncRoute(handleCreateRun),
  );
  app.get(
    "/api/build-runs",
    requireAuth,
    requireHydratedUser,
    asyncRoute(handleListRuns),
  );
  app.get(
    "/api/build-runs/:id",
    requireAuth,
    requireHydratedUser,
    asyncRoute(handleGetRun),
  );
  app.get(
    "/api/build-runs/:id/events",
    requireAuth,
    requireHydratedUser,
    asyncRoute(handleListEvents),
  );

  app.post("/api/build-runs/:id/start", requireAuth, requireHydratedUser, handleStart);
  app.post("/api/build-runs/:id/pause", requireAuth, requireHydratedUser, handlePause);
  app.post("/api/build-runs/:id/resume", requireAuth, requireHydratedUser, handleResume);
  app.post("/api/build-runs/:id/stop", requireAuth, requireHydratedUser, handleStop);
  app.post(
    "/api/build-runs/:id/instruct",
    requireAuth,
    requireHydratedUser,
    handleInstruct,
  );
  app.post("/api/build-runs/:id/review", requireAuth, requireHydratedUser, handleReview);
  app.post(
    "/api/build-runs/:id/approve",
    requireAuth,
    requireHydratedUser,
    handleApprove,
  );
  app.post("/api/build-runs/:id/reject", requireAuth, requireHydratedUser, handleReject);

  void logSystem("debug", "build_control", "build run routes registered");
}

export default registerBuildRunRoutes;
