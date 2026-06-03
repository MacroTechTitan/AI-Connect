import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import { projects } from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import { deriveSlugFromText } from "../lib/slug.js";
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

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
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

  return { name, description, slug };
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

  await logUserAction(ctx.userId, "create_project", "project", inserted.id, {
    slug: inserted.slug,
  });

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

  await logUserAction(ctx.userId, "delete_project", "project", removed.id, {
    slug: removed.slug,
  });

  res.status(200).json({ id: removed.id, deleted: true });
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
}
