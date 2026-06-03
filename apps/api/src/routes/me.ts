import { eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { getDb } from "../db/client.js";
import { organizations, users } from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import { deriveSlugFromEmail } from "../lib/slug.js";
import { requireAuth } from "../middleware/requireAuth.js";

const MAX_SLUG_RETRIES = 5;
const USERS_EMAIL_UNIQUE = "users_email_unique";

interface UserRow {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

interface MeResult {
  user: UserRow;
  org: OrgRow | null;
}

function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === constraintName;
}

async function fetchUserWithOrg(email: string): Promise<MeResult | null> {
  const [row] = await getDb()
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
    })
    .from(users)
    .leftJoin(organizations, eq(users.organizationId, organizations.id))
    .where(eq(users.email, email))
    .limit(1);

  if (!row) return null;

  return {
    user: {
      id: row.id,
      email: row.email,
      role: row.role,
      organizationId: row.organizationId,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    },
    org:
      row.orgId && row.orgName && row.orgSlug
        ? { id: row.orgId, name: row.orgName, slug: row.orgSlug }
        : null,
  };
}

// First-login flow: insert user + insert org + patch user.organization_id in
// one transaction. Walks a list of slug candidates (base, base-2 … base-5,
// base-<userIdPrefix>) using ON CONFLICT DO NOTHING so concurrent inserts in
// another transaction don't crash us. If the email itself is taken by a
// concurrent transaction, this whole tx rolls back and the caller re-fetches.
async function createUserWithOrg(email: string): Promise<MeResult> {
  const baseSlug = deriveSlugFromEmail(email);
  const prefix = email.split("@")[0] ?? email;
  const orgName = `${prefix}'s workspace`;

  return getDb().transaction(async (tx) => {
    const now = new Date();

    const [userRow] = await tx
      .insert(users)
      .values({ email, role: "user", lastSeenAt: now })
      .returning({
        id: users.id,
        email: users.email,
        role: users.role,
        organizationId: users.organizationId,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
      });
    if (!userRow) {
      throw new Error("user insert returned no row");
    }

    const candidates: string[] = [baseSlug];
    for (let i = 2; i <= MAX_SLUG_RETRIES; i++) {
      candidates.push(`${baseSlug}-${i}`);
    }
    candidates.push(`${baseSlug}-${userRow.id.slice(0, 8)}`);

    let orgRow: OrgRow | undefined;
    for (const slug of candidates) {
      const [inserted] = await tx
        .insert(organizations)
        .values({
          name: orgName,
          slug,
          createdByUserId: userRow.id,
        })
        .onConflictDoNothing({ target: organizations.slug })
        .returning({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        });
      if (inserted) {
        orgRow = inserted;
        break;
      }
    }

    if (!orgRow) {
      throw new Error(
        `could not allocate a unique slug for organization from base '${baseSlug}'`,
      );
    }

    await tx
      .update(users)
      .set({ organizationId: orgRow.id })
      .where(eq(users.id, userRow.id));

    return {
      user: { ...userRow, organizationId: orgRow.id },
      org: orgRow,
    };
  });
}

async function handleMe(req: Request, res: Response): Promise<void> {
  // /api/me intentionally reads req.jwt (the raw JWT identity) rather than
  // req.user (the hydrated DB context). On a brand-new user's first sign-in
  // the DB row doesn't exist yet, so req.user is undefined — this handler
  // is the one that creates it. Every other protected route uses
  // requireHydratedUser and reads req.user directly.
  const jwt = req.jwt;
  if (!jwt) {
    res.status(401).json({ error: "unauthorized", reason: "no_user_context" });
    return;
  }
  if (!jwt.email) {
    res.status(400).json({ error: "email claim missing" });
    return;
  }

  const email = jwt.email;

  let result = await fetchUserWithOrg(email);
  let created = false;

  if (!result) {
    try {
      result = await createUserWithOrg(email);
      created = true;
    } catch (err) {
      // Parallel /api/me from the same fresh user landed first. Treat the
      // collision as "already created" and re-fetch the row they produced.
      if (isUniqueViolation(err, USERS_EMAIL_UNIQUE)) {
        result = await fetchUserWithOrg(email);
      } else {
        throw err;
      }
    }
  }

  if (!result) {
    res.status(500).json({
      error: "internal_error",
      reason: "user_lookup_failed",
    });
    return;
  }

  // Bump last_seen_at for returning users. New users already had it set
  // inside the creation transaction.
  if (!created) {
    const now = new Date();
    await getDb()
      .update(users)
      .set({ lastSeenAt: now })
      .where(eq(users.id, result.user.id));
    result.user.lastSeenAt = now;
  }

  if (created) {
    // logUserAction swallows its own errors and never throws — safe to await.
    // Runs outside the upsert transaction so a logging-table hiccup can't
    // roll back a successful user creation.
    // result.org is guaranteed non-null on the created path (createUserWithOrg
    // mints one in the same transaction). The ?? is for typing only.
    const newOrgId = result.org?.id ?? null;
    await logUserAction(
      result.user.id,
      "first_login_create_user",
      "user",
      result.user.id,
      newOrgId,
    );
    if (result.org) {
      await logUserAction(
        result.user.id,
        "first_login_create_organization",
        "organization",
        result.org.id,
        result.org.id,
      );
    }
  }

  res.status(200).json({
    id: result.user.id,
    email: result.user.email,
    role: result.user.role,
    organization: result.org
      ? {
          id: result.org.id,
          name: result.org.name,
          slug: result.org.slug,
        }
      : null,
    created_at: result.user.createdAt,
    last_seen_at: result.user.lastSeenAt,
  });
}

export function registerMeRoutes(app: Express): void {
  app.get("/api/me", requireAuth, handleMe);
}
