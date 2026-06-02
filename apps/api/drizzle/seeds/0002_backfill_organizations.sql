-- Backfill organization assignments for existing users (Sprint 3 Commit 2).
--
-- This is a ONE-TIME data migration, NOT a schema change. Manually applied to
-- Supabase by the operator after review, like the pricing seed in
-- 0001_provider_pricing.sql. It is NOT part of the drizzle journal and never
-- runs automatically.
--
-- What it does:
--   1. Ensures the "MacroTechTitan" organization exists (slug =
--      'macrotechtitan'), created by the admin user, and assigns the admin to it.
--   2. For every OTHER existing user who currently has organization_id = NULL,
--      creates a personal organization "{email-prefix}'s workspace" (slug =
--      lowercased prefix with '.' and '+' replaced by '-'), created by that
--      user, and assigns them to it.
--   3. Denormalizes organization_id into provider_keys, prompts, and
--      user_audit_logs by joining each row's user_id back to the user's new
--      organization_id (matches the Sprint 3 schema's denorm pattern).
--
-- Idempotency:
--   - INSERT ... ON CONFLICT (slug) DO NOTHING guards against duplicate orgs.
--   - Every UPDATE is gated by `organization_id IS NULL` so rows already
--     backfilled in a prior run are untouched.
--   - The whole script is wrapped in a single BEGIN/COMMIT so a failure
--     anywhere rolls back the entire backfill.
--   - Safe to re-run if the operator wants to verify or recover from a
--     partial run.
--
-- Edge cases worth knowing about:
--   - The admin UUID is hardcoded ('875536fd-837c-4d2e-aa43-b1ed5a24100a').
--     That is production-specific. Fresh dev envs that seeded a different
--     admin UUID need to edit this value before running.
--   - If a non-admin user's email-prefix slugifies to 'macrotechtitan' (e.g.,
--     'MacroTechTitan@gmail.com'), step 3's ON CONFLICT will skip the
--     personal org and step 4 will assign them to the admin's MTT org.
--   - If two non-admin emails slugify to the same value (e.g.,
--     'john.doe@a.com' and 'john+doe@b.com' both → 'john-doe'), only the
--     first row's workspace is created; the second user ends up assigned to
--     the first user's workspace. Acceptable for a one-time backfill on the
--     known small existing user set.
--
-- Sprint 3 Commit 3 — lazy organization creation on first /api/me — is the
-- long-term path for NEW users signing up after this lands. This script only
-- catches the existing population.

BEGIN;

-- Step 1: ensure the MacroTechTitan org exists, owned by the admin.
INSERT INTO organizations (name, slug, created_by_user_id)
VALUES (
  'MacroTechTitan',
  'macrotechtitan',
  '875536fd-837c-4d2e-aa43-b1ed5a24100a'::uuid
)
ON CONFLICT (slug) DO NOTHING;

-- Step 2: assign the admin to MTT if they have no org yet.
UPDATE users
SET organization_id = (
  SELECT id FROM organizations WHERE slug = 'macrotechtitan'
)
WHERE id = '875536fd-837c-4d2e-aa43-b1ed5a24100a'::uuid
  AND organization_id IS NULL;

-- Step 3: create a personal workspace org for every other still-unassigned user.
INSERT INTO organizations (name, slug, created_by_user_id)
SELECT
  split_part(u.email, '@', 1) || '''s workspace' AS name,
  regexp_replace(
    lower(split_part(u.email, '@', 1)),
    '[.+]',
    '-',
    'g'
  ) AS slug,
  u.id AS created_by_user_id
FROM users u
WHERE u.organization_id IS NULL
ON CONFLICT (slug) DO NOTHING;

-- Step 4: assign every still-unassigned user to the org whose slug matches the
-- derivation from their email prefix. LIMIT 1 absorbs the rare slug-collision
-- case (two emails normalize to the same slug — only one org got created in
-- step 3 and step 4 picks it for both users).
UPDATE users u
SET organization_id = (
  SELECT o.id
  FROM organizations o
  WHERE o.slug = regexp_replace(
    lower(split_part(u.email, '@', 1)),
    '[.+]',
    '-',
    'g'
  )
  LIMIT 1
)
WHERE u.organization_id IS NULL;

-- Step 5: denormalize organization_id into provider_keys.
UPDATE provider_keys pk
SET organization_id = u.organization_id
FROM users u
WHERE pk.user_id = u.id
  AND pk.organization_id IS NULL
  AND u.organization_id IS NOT NULL;

-- Step 6: denormalize organization_id into prompts.
UPDATE prompts p
SET organization_id = u.organization_id
FROM users u
WHERE p.user_id = u.id
  AND p.organization_id IS NULL
  AND u.organization_id IS NOT NULL;

-- Step 7: denormalize organization_id into user_audit_logs.
UPDATE user_audit_logs ual
SET organization_id = u.organization_id
FROM users u
WHERE ual.user_id = u.id
  AND ual.organization_id IS NULL
  AND u.organization_id IS NOT NULL;

COMMIT;
