// Choosing WHICH repository a Build Run may execute in.
//
// workspace.ts answers "is this path allowed?". This file answers the question
// before it: "which path does this run get?" — and the answer is never a path
// the caller supplied.
//
// A run names a workspace by KEY. The key is a short slug that the operator
// has either registered explicitly or that names a directory directly beneath
// the authorized root. Resolution happens once, at create time, and only the
// resolved absolute path is persisted. Nothing downstream — not the API body,
// not the worker, not a prompt — can name a filesystem location.
//
// Configuration (all optional, all operator-side):
//
//   AICONNECT_RUNNER_WORKSPACE_ROOT   the authorized tree. Required.
//   AICONNECT_RUNNER_WORKSPACES       a JSON allow-list. When set, ONLY the
//                                     keys it declares are selectable.
//
// The registry accepts a shorthand and a long form:
//
//   {"devos": "DevOS"}
//   {"devos": {"path": "DevOS", "projects": ["<project-uuid>"], "description": "DevOS docs"}}
//
// `path` is relative to the root (an absolute path is accepted but must still
// resolve inside it). `projects` binds a workspace to specific projects, so a
// run on one project cannot execute in another project's repository.

import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { resolveWorkspace, WorkspaceViolationError } from "./workspace.js";
import type { ResolvedWorkspace } from "./types.js";

/** Keys are slugs, not paths: no separators, no traversal, no leading dash. */
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface WorkspaceEntry {
  key: string;
  path: string;
  /** When present, only runs on these project ids may use this workspace. */
  projects?: string[];
  description?: string;
}

export function isValidWorkspaceKey(key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  if (key.includes("..")) return false;
  return true;
}

export class WorkspaceSelectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspaceSelectionError";
    this.code = code;
  }
}

/**
 * Parses AICONNECT_RUNNER_WORKSPACES. Returns null when unset — which means
 * "no allow-list", not "nothing allowed"; see resolveWorkspaceForRun.
 *
 * A malformed registry throws rather than being silently ignored: an operator
 * who meant to restrict workspaces must not end up with them unrestricted
 * because of a typo.
 */
export function parseWorkspaceRegistry(raw: string | undefined): WorkspaceEntry[] | null {
  if (raw === undefined || raw.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceSelectionError(
      "invalid_workspace_registry",
      "AICONNECT_RUNNER_WORKSPACES is not valid JSON",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceSelectionError(
      "invalid_workspace_registry",
      "AICONNECT_RUNNER_WORKSPACES must be a JSON object of key -> path or key -> {path,...}",
    );
  }

  const entries: WorkspaceEntry[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidWorkspaceKey(key)) {
      throw new WorkspaceSelectionError(
        "invalid_workspace_registry",
        `workspace key '${key}' is not a usable slug`,
      );
    }
    if (typeof value === "string") {
      entries.push({ key, path: value });
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkspaceSelectionError(
        "invalid_workspace_registry",
        `workspace '${key}' must be a path string or an object with a path`,
      );
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.path !== "string" || obj.path.length === 0) {
      throw new WorkspaceSelectionError(
        "invalid_workspace_registry",
        `workspace '${key}' has no path`,
      );
    }
    const projects = Array.isArray(obj.projects)
      ? obj.projects.filter((p): p is string => typeof p === "string")
      : undefined;
    entries.push({
      key,
      path: obj.path,
      ...(projects && projects.length > 0 ? { projects } : {}),
      ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    });
  }
  return entries;
}

export interface WorkspaceCatalogEntry {
  key: string;
  /** Absolute resolved path, present only when it currently resolves. */
  path: string | null;
  available: boolean;
  reason?: string;
  description?: string;
  restricted: boolean;
}

export interface WorkspaceConfig {
  root: string | undefined;
  registryRaw: string | undefined;
}

/**
 * What an operator may choose from. Used by GET /api/build-runs/workspaces so
 * a run is created against something known to exist rather than a guess.
 *
 * Paths are reported because the operator configured them; they are not
 * secrets, and seeing them is how an operator confirms they picked the right
 * repository before starting a supervised run.
 */
export function listWorkspaces(config: WorkspaceConfig): WorkspaceCatalogEntry[] {
  const { root, registryRaw } = config;
  if (!root) return [];

  const registry = parseWorkspaceRegistry(registryRaw);

  const keys: WorkspaceEntry[] =
    registry ??
    // No allow-list: every git repository directly beneath the root is
    // selectable by its directory name.
    safeReaddir(root)
      .filter((name) => isValidWorkspaceKey(name.toLowerCase()))
      .map((name) => ({ key: name.toLowerCase(), path: name }))
      .filter((entry) => existsSync(resolve(root, entry.path, ".git")));

  return keys.map((entry) => {
    try {
      const ws = resolveWorkspace({
        allowedRoot: root,
        repoPath: entry.path,
        // Placeholder: listing only validates the path, not a real branch.
        branch: "main",
      });
      return {
        key: entry.key,
        path: ws.repoRoot,
        available: true,
        restricted: Boolean(entry.projects?.length),
        ...(entry.description ? { description: entry.description } : {}),
      };
    } catch (err) {
      return {
        key: entry.key,
        path: null,
        available: false,
        restricted: Boolean(entry.projects?.length),
        reason: err instanceof Error ? err.message : String(err),
        ...(entry.description ? { description: entry.description } : {}),
      };
    }
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export interface ResolveForRunInput extends WorkspaceConfig {
  /** The key the caller asked for. */
  workspaceKey: string;
  /** The project the run belongs to, for binding checks. */
  projectId: string;
  branch: string;
}

/**
 * Resolves a run's workspace from a key. Throws WorkspaceSelectionError for a
 * bad request and WorkspaceViolationError when the resolved path fails
 * containment — the caller maps the first to a 400 and the second to a refusal.
 *
 * Every containment guarantee still comes from resolveWorkspace(): realpath,
 * path.relative containment, symlink-escape rejection and the .git check. This
 * function only decides which path is offered up for those checks.
 */
export function resolveWorkspaceForRun(input: ResolveForRunInput): ResolvedWorkspace {
  const { root, registryRaw, workspaceKey, projectId, branch } = input;

  if (!root) {
    throw new WorkspaceSelectionError(
      "runner_not_configured",
      "no authorized workspace root is configured — set AICONNECT_RUNNER_WORKSPACE_ROOT",
    );
  }
  if (!isValidWorkspaceKey(workspaceKey)) {
    throw new WorkspaceSelectionError(
      "invalid_workspace",
      `'${workspaceKey}' is not a usable workspace key`,
    );
  }

  const registry = parseWorkspaceRegistry(registryRaw);

  let repoPath: string;
  if (registry) {
    // A configured registry is an ALLOW-LIST. An unknown key is refused rather
    // than falling back to the directory convention, so adding a repository
    // under the root does not silently make it dispatchable.
    const entry = registry.find((e) => e.key === workspaceKey);
    if (!entry) {
      throw new WorkspaceSelectionError(
        "unknown_workspace",
        `workspace '${workspaceKey}' is not registered`,
      );
    }
    if (entry.projects && !entry.projects.includes(projectId)) {
      throw new WorkspaceSelectionError(
        "workspace_not_permitted",
        `workspace '${workspaceKey}' is not available to this project`,
      );
    }
    repoPath = entry.path;
  } else {
    // No allow-list: the key names a directory directly beneath the root. It
    // is still a key, not a path — separators and traversal were rejected above.
    repoPath = workspaceKey;
  }

  try {
    return resolveWorkspace({ allowedRoot: root, repoPath, branch });
  } catch (err) {
    if (err instanceof WorkspaceViolationError) throw err;
    throw new WorkspaceSelectionError(
      "workspace_unresolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}
