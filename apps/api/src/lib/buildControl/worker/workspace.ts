// Workspace resolution and the execution boundary.
//
// A worker executes commands and edits files. The single most important thing
// Build Control does before dispatching one is decide WHERE that is allowed to
// happen, and refuse everything else. That decision lives here, not in the
// adapter, so a second worker cannot accidentally get a weaker boundary.
//
// The boundary is an operator-configured root directory. Every workspace must
// resolve — after following symlinks — to a path inside it. A run cannot name
// its own path: workspaces are derived from configuration and the project, so
// a compromised or confused run body cannot point execution somewhere else.

import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ResolvedWorkspace } from "./types.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
/** Enough for a large refactor; a diff longer than this is summarized, not truncated silently. */
const MAX_CHANGED_FILES = 500;

export class WorkspaceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolationError";
  }
}

/**
 * True when `candidate` is inside `root` after both are fully resolved.
 * Uses path.relative rather than startsWith, which would accept `/srv/repos-evil`
 * as being inside `/srv/repos`.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Resolves symlinks when the path exists, so a link cannot escape the root. */
function realOrThrow(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new WorkspaceViolationError(`${label} does not exist: ${path}`);
  }
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new WorkspaceViolationError(`${label} is not a directory: ${path}`);
  }
  return real;
}

export interface ResolveWorkspaceInput {
  /** The operator-configured root. Nothing outside it is ever dispatched into. */
  allowedRoot: string | undefined;
  /** Absolute or root-relative path of the repository to work in. */
  repoPath: string;
  branch: string;
}

/**
 * Validates a repository path against the configured root and returns a
 * workspace a worker may be dispatched into. Throws WorkspaceViolationError
 * for anything it cannot prove is inside the boundary.
 */
export function resolveWorkspace(input: ResolveWorkspaceInput): ResolvedWorkspace {
  const { allowedRoot, repoPath, branch } = input;

  if (!allowedRoot) {
    throw new WorkspaceViolationError(
      "no workspace root is configured — set AICONNECT_RUNNER_WORKSPACE_ROOT",
    );
  }
  const root = realOrThrow(resolve(allowedRoot), "workspace root");

  // A relative repoPath is interpreted against the root, never against the
  // API process's cwd — which on a server is somewhere entirely unrelated.
  const requested = isAbsolute(repoPath) ? repoPath : resolve(root, repoPath);
  const repoRoot = realOrThrow(requested, "workspace");

  if (!isInsideRoot(root, repoRoot)) {
    throw new WorkspaceViolationError(
      `workspace ${repoRoot} is outside the authorized root ${root}`,
    );
  }

  if (!existsSync(resolve(repoRoot, ".git"))) {
    throw new WorkspaceViolationError(
      `workspace is not a git repository (no .git): ${repoRoot}`,
    );
  }

  if (!isValidBranchName(branch)) {
    throw new WorkspaceViolationError(`unusable branch name: ${branch}`);
  }

  return { repoRoot, branch, allowedRoot: root };
}

// Deliberately strict. These names reach `git checkout`, so anything that could
// be read as an option or a path traversal is rejected rather than escaped.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/;

export function isValidBranchName(branch: string): boolean {
  if (!BRANCH_RE.test(branch)) return false;
  if (branch.includes("..")) return false;
  if (branch.endsWith("/") || branch.endsWith(".lock")) return false;
  return true;
}

/**
 * Branch name for a run. Derived, not caller-supplied, so a run title cannot
 * inject a ref. Truncated because git refs have practical length limits.
 */
export function branchNameForRun(runId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const short = runId.slice(0, 8);
  return slug ? `build/${short}-${slug}` : `build/${short}`;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  // execFile, never exec: no shell, so nothing in args can be interpreted.
  return execFileAsync("git", ["-C", repoRoot, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

export async function headCommit(repoRoot: string): Promise<string> {
  const { stdout } = await git(repoRoot, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Puts the workspace on `branch`, creating it from the current HEAD if needed.
 * Refuses to touch a workspace with staged or unstaged changes — starting a
 * supervised run on top of someone else's uncommitted work would make the
 * resulting diff statistics a lie.
 */
export async function ensureBranch(
  repoRoot: string,
  branch: string,
): Promise<{ created: boolean; previousBranch: string }> {
  if (!isValidBranchName(branch)) {
    throw new WorkspaceViolationError(`unusable branch name: ${branch}`);
  }

  const previousBranch = await currentBranch(repoRoot);
  if (previousBranch === branch) return { created: false, previousBranch };

  const dirty = await isDirty(repoRoot);
  if (dirty) {
    throw new WorkspaceViolationError(
      `workspace has uncommitted changes; refusing to switch to ${branch}`,
    );
  }

  const exists = await branchExists(repoRoot, branch);
  await git(repoRoot, exists ? ["checkout", branch] : ["checkout", "-b", branch]);
  return { created: !exists, previousBranch };
}

export async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(repoRoot: string): Promise<boolean> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

export interface DiffStats {
  filesChanged: string[];
  additions: number;
  deletions: number;
  /** True when some part of the diff could not be measured (binary files). */
  partial: boolean;
  /** Files whose line counts are genuinely unknown, e.g. binaries. */
  unmeasured: string[];
}

/**
 * Diff statistics for the work a run produced, relative to `baseCommit`.
 *
 * Tracked changes come from `git diff --numstat`. Untracked files are counted
 * separately with `--no-index` against an empty tree, because a plain
 * `git diff` does not see them and `git add -N` would mutate the operator's
 * index to find out.
 *
 * Binary files report "-" in numstat. They are listed in `unmeasured` and NOT
 * counted as zero: an unmeasurable line count is reported as unknown, never
 * fabricated as 0.
 */
export async function diffStats(
  repoRoot: string,
  baseCommit: string,
): Promise<DiffStats> {
  const filesChanged: string[] = [];
  const unmeasured: string[] = [];
  let additions = 0;
  let deletions = 0;

  const { stdout: tracked } = await git(repoRoot, [
    "diff",
    "--numstat",
    baseCommit,
    "--",
  ]);
  for (const line of tracked.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    filesChanged.push(path);
    if (add === "-" || del === "-") {
      unmeasured.push(path);
      continue;
    }
    additions += Number.parseInt(add ?? "0", 10) || 0;
    deletions += Number.parseInt(del ?? "0", 10) || 0;
  }

  const { stdout: untrackedOut } = await git(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const untracked = untrackedOut.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const path of untracked) {
    filesChanged.push(path);
    const lines = await countAddedLines(repoRoot, path);
    if (lines === null) unmeasured.push(path);
    else additions += lines;
  }

  return {
    filesChanged: filesChanged.slice(0, MAX_CHANGED_FILES),
    additions,
    deletions,
    partial: unmeasured.length > 0 || filesChanged.length > MAX_CHANGED_FILES,
    unmeasured,
  };
}

/** Lines in a new file, or null when git considers it binary. */
async function countAddedLines(repoRoot: string, path: string): Promise<number | null> {
  try {
    const { stdout } = await git(repoRoot, [
      "diff",
      "--numstat",
      "--no-index",
      "--",
      process.platform === "win32" ? "NUL" : "/dev/null",
      path,
    ]);
    const first = stdout.split("\n").find((l) => l.trim());
    if (!first) return 0;
    const add = first.split("\t")[0];
    if (add === "-" || add === undefined) return null;
    return Number.parseInt(add, 10) || 0;
  } catch (err) {
    // `git diff --no-index` exits 1 when files differ, which is the normal
    // case here — the numbers are still on stdout.
    const out = (err as { stdout?: string }).stdout;
    if (typeof out === "string") {
      const first = out.split("\n").find((l) => l.trim());
      const add = first?.split("\t")[0];
      if (add === "-") return null;
      if (add !== undefined) return Number.parseInt(add, 10) || 0;
    }
    return null;
  }
}
