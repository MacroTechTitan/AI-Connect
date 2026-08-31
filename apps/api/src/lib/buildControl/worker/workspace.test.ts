import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  branchNameForRun,
  diffStats,
  ensureBranch,
  headCommit,
  isInsideRoot,
  isValidBranchName,
  resolveWorkspace,
  WorkspaceViolationError,
} from "./workspace.js";

// A real git repository on disk. The workspace boundary is the security
// perimeter for code execution, so it is tested against a real filesystem —
// a mocked fs cannot tell us whether a symlink escapes a root.

let root: string;
let repo: string;
let outside: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

beforeAll(() => {
  const base = mkdtempSync(resolve(tmpdir(), "aic-ws-"));
  root = resolve(base, "root");
  repo = resolve(root, "project");
  outside = resolve(base, "outside");
  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(resolve(repo, "README.md"), "one\ntwo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  execFileSync("git", ["init", "-q", outside], { windowsHide: true });
});

afterAll(() => {
  try {
    rmSync(resolve(root, ".."), { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe("isInsideRoot", () => {
  it("accepts a path inside the root", () => {
    expect(isInsideRoot("/srv/repos", "/srv/repos/a/b")).toBe(true);
  });

  it("accepts the root itself", () => {
    expect(isInsideRoot("/srv/repos", "/srv/repos")).toBe(true);
  });

  it("rejects a sibling whose name merely starts with the root", () => {
    // The bug a naive startsWith() check would have.
    expect(isInsideRoot("/srv/repos", "/srv/repos-evil")).toBe(false);
  });

  it("rejects traversal out of the root", () => {
    expect(isInsideRoot("/srv/repos", "/srv/other")).toBe(false);
    expect(isInsideRoot("/srv/repos", "/")).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  it("resolves a repository inside the authorized root", () => {
    const ws = resolveWorkspace({ allowedRoot: root, repoPath: repo, branch: "build/x" });
    expect(ws.branch).toBe("build/x");
    expect(isInsideRoot(ws.allowedRoot, ws.repoRoot)).toBe(true);
  });

  it("accepts a path relative to the root, not to the process cwd", () => {
    const ws = resolveWorkspace({ allowedRoot: root, repoPath: "project", branch: "main" });
    expect(ws.repoRoot).toBe(
      resolveWorkspace({ allowedRoot: root, repoPath: repo, branch: "main" }).repoRoot,
    );
  });

  it("refuses to run at all when no root is configured", () => {
    expect(() =>
      resolveWorkspace({ allowedRoot: undefined, repoPath: repo, branch: "main" }),
    ).toThrow(WorkspaceViolationError);
  });

  it("refuses a repository outside the authorized root", () => {
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: outside, branch: "main" }),
    ).toThrow(/outside the authorized root/);
  });

  it("refuses a traversal path", () => {
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: "../outside", branch: "main" }),
    ).toThrow(WorkspaceViolationError);
  });

  it("refuses a symlink that points out of the root", () => {
    const link = resolve(root, "escape");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation needs privileges on some Windows setups
    }
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: link, branch: "main" }),
    ).toThrow(/outside the authorized root/);
  });

  it("refuses a directory that is not a git repository", () => {
    const plain = resolve(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: plain, branch: "main" }),
    ).toThrow(/not a git repository/);
  });

  it("refuses a path that does not exist", () => {
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: resolve(root, "nope"), branch: "main" }),
    ).toThrow(/does not exist/);
  });

  it("refuses an unusable branch name", () => {
    expect(() =>
      resolveWorkspace({ allowedRoot: root, repoPath: repo, branch: "--upload-pack=evil" }),
    ).toThrow(/unusable branch name/);
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary branch names", () => {
    expect(isValidBranchName("build/abc123-my-task")).toBe(true);
    expect(isValidBranchName("main")).toBe(true);
  });

  it("rejects anything that could be read as a flag or a traversal", () => {
    for (const bad of [
      "--upload-pack=x",
      "-x",
      "../evil",
      "a..b",
      "branch;rm -rf /",
      "with space",
      "trailing/",
      "x.lock",
      "",
    ]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});

describe("branchNameForRun", () => {
  it("derives a safe branch from the run id and title", () => {
    const branch = branchNameForRun("2f1c9e40-0000-0000-0000-000000000000", "Add the Run Inspector");
    expect(branch).toBe("build/2f1c9e40-add-the-run-inspector");
    expect(isValidBranchName(branch)).toBe(true);
  });

  it("produces a valid branch from a title made entirely of punctuation", () => {
    const branch = branchNameForRun("2f1c9e40-0000-0000-0000-000000000000", "!!! ??? ***");
    expect(branch).toBe("build/2f1c9e40");
    expect(isValidBranchName(branch)).toBe(true);
  });

  it("never lets a title inject a ref", () => {
    const branch = branchNameForRun("2f1c9e40-0000-0000-0000-000000000000", "../../etc/passwd");
    expect(isValidBranchName(branch)).toBe(true);
    expect(branch).not.toContain("..");
  });
});

describe("ensureBranch", () => {
  it("creates and checks out a new branch", async () => {
    const result = await ensureBranch(repo, "build/first");
    expect(result.created).toBe(true);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("build/first");
  });

  it("is a no-op when already on the branch", async () => {
    const result = await ensureBranch(repo, "build/first");
    expect(result.created).toBe(false);
  });

  it("refuses to switch away from uncommitted work", async () => {
    writeFileSync(resolve(repo, "dirty.txt"), "uncommitted\n");
    await expect(ensureBranch(repo, "build/second")).rejects.toThrow(
      /uncommitted changes/,
    );
    rmSync(resolve(repo, "dirty.txt"));
  });

  it("refuses an unusable branch name before touching git", async () => {
    await expect(ensureBranch(repo, "--exec=evil")).rejects.toThrow(
      WorkspaceViolationError,
    );
  });
});

describe("diffStats", () => {
  it("reports nothing changed on a clean tree", async () => {
    const base = await headCommit(repo);
    const stats = await diffStats(repo, base);
    expect(stats).toMatchObject({ filesChanged: [], additions: 0, deletions: 0, partial: false });
  });

  it("counts modifications to tracked files", async () => {
    const base = await headCommit(repo);
    writeFileSync(resolve(repo, "README.md"), "one\ntwo\nthree\n");
    const stats = await diffStats(repo, base);
    expect(stats.filesChanged).toContain("README.md");
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(0);
    git(repo, "checkout", "--", "README.md");
  });

  it("counts untracked files, which a plain git diff does not see", async () => {
    const base = await headCommit(repo);
    writeFileSync(resolve(repo, "NEW.md"), "a\nb\nc\n");
    const stats = await diffStats(repo, base);
    expect(stats.filesChanged).toContain("NEW.md");
    expect(stats.additions).toBe(3);
    rmSync(resolve(repo, "NEW.md"));
  });

  it("reports a binary file as unmeasured rather than counting it as zero", async () => {
    const base = await headCommit(repo);
    writeFileSync(resolve(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    const stats = await diffStats(repo, base);
    expect(stats.filesChanged).toContain("blob.bin");
    expect(stats.unmeasured).toContain("blob.bin");
    expect(stats.partial).toBe(true);
    rmSync(resolve(repo, "blob.bin"));
  });
});
