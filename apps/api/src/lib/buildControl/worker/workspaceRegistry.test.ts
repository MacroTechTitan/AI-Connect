import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isInsideRoot, WorkspaceViolationError } from "./workspace.js";
import {
  isValidWorkspaceKey,
  listWorkspaces,
  parseWorkspaceRegistry,
  resolveWorkspaceForRun,
  WorkspaceSelectionError,
} from "./workspaceRegistry.js";

// Workspace selection decides where code execution is allowed to happen, so it
// is tested against a real directory tree. The property under test throughout
// is that a CALLER names a key and never a path — and that a key cannot be
// turned into a path that escapes the root.

const PROJECT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let base: string;
let root: string;
let outside: string;

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-q"], { windowsHide: true });
  writeFileSync(resolve(path, "README.md"), "x\n");
}

beforeAll(() => {
  base = mkdtempSync(resolve(tmpdir(), "aic-wsreg-"));
  root = resolve(base, "root");
  outside = resolve(base, "outside");
  mkdirSync(root, { recursive: true });

  makeRepo(resolve(root, "devos"));
  makeRepo(resolve(root, "other"));
  makeRepo(outside);
  // A directory under the root that is not a repository at all.
  mkdirSync(resolve(root, "notarepo"), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

const resolveFor = (
  workspaceKey: string,
  opts: { registryRaw?: string; projectId?: string; root?: string } = {},
) =>
  resolveWorkspaceForRun({
    // `in` rather than a ?? default: passing root explicitly as undefined is
    // the "no root configured" case under test, and must not fall back.
    root: "root" in opts ? opts.root : root,
    registryRaw: opts.registryRaw,
    workspaceKey,
    projectId: opts.projectId ?? PROJECT_A,
    branch: "build/test",
  });

describe("workspace keys", () => {
  it("accepts ordinary slugs", () => {
    for (const key of ["devos", "ai-connect", "repo_1", "a.b", "x"]) {
      expect(isValidWorkspaceKey(key), key).toBe(true);
    }
  });

  it("rejects anything that could become a path", () => {
    for (const key of [
      "../outside",
      "..",
      "a/b",
      "a\\b",
      "/etc",
      "C:\\Dev",
      "-flag",
      "a b",
      "",
      "a".repeat(65),
    ]) {
      expect(isValidWorkspaceKey(key), key).toBe(false);
    }
  });
});

describe("resolving a valid repository", () => {
  it("resolves a key to a repository beneath the root", () => {
    const ws = resolveFor("devos");
    expect(ws.repoRoot.toLowerCase()).toContain("devos");
    expect(ws.branch).toBe("build/test");
    expect(isInsideRoot(ws.allowedRoot, ws.repoRoot)).toBe(true);
  });

  it("resolves through a registry entry whose path differs from the key", () => {
    const ws = resolveFor("docs", { registryRaw: JSON.stringify({ docs: "devos" }) });
    expect(ws.repoRoot.toLowerCase()).toContain("devos");
  });

  it("supports the object form with a description", () => {
    const registryRaw = JSON.stringify({
      docs: { path: "devos", description: "DevOS documentation" },
    });
    expect(resolveFor("docs", { registryRaw }).repoRoot.toLowerCase()).toContain("devos");
  });
});

describe("paths outside the root", () => {
  it("refuses a key that traverses out of the root", () => {
    // Rejected as a key before it can ever become a path.
    expect(() => resolveFor("../outside")).toThrow(WorkspaceSelectionError);
  });

  it("refuses a registry entry pointing outside the root", () => {
    expect(() =>
      resolveFor("escape", { registryRaw: JSON.stringify({ escape: outside }) }),
    ).toThrow(WorkspaceViolationError);
  });

  it("refuses a registry entry using traversal to leave the root", () => {
    expect(() =>
      resolveFor("escape", { registryRaw: JSON.stringify({ escape: "../outside" }) }),
    ).toThrow(WorkspaceViolationError);
  });

  it("refuses everything when no root is configured", () => {
    expect(() => resolveFor("devos", { root: undefined })).toThrow(
      /AICONNECT_RUNNER_WORKSPACE_ROOT/,
    );
  });
});

describe("symlink escape", () => {
  it("refuses a symlink under the root that points outside it", () => {
    const link = resolve(root, "linked");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // symlink creation needs privileges on some Windows setups
    }
    // The link is a valid key and sits under the root; only realpath reveals
    // that following it leaves the authorized tree.
    expect(() => resolveFor("linked")).toThrow(/outside the authorized root/);
  });
});

describe("missing or unusable repositories", () => {
  it("refuses a key that names nothing", () => {
    expect(() => resolveFor("nosuchrepo")).toThrow(/does not exist/);
  });

  it("refuses a directory that is not a git repository", () => {
    expect(() => resolveFor("notarepo")).toThrow(/not a git repository/);
  });

  it("refuses a key absent from a configured allow-list", () => {
    // The directory exists and is a repo, but the operator did not register
    // it — dropping a repository under the root must not make it dispatchable.
    expect(() =>
      resolveFor("other", { registryRaw: JSON.stringify({ devos: "devos" }) }),
    ).toThrow(/not registered/);
  });
});

describe("cross-project misuse", () => {
  const registryRaw = JSON.stringify({
    devos: { path: "devos", projects: [PROJECT_A] },
    other: { path: "other" },
  });

  it("allows the project a workspace is bound to", () => {
    expect(resolveFor("devos", { registryRaw, projectId: PROJECT_A }).repoRoot).toBeTruthy();
  });

  it("refuses a different project", () => {
    expect(() => resolveFor("devos", { registryRaw, projectId: PROJECT_B })).toThrow(
      /not available to this project/,
    );
  });

  it("reports the refusal as a permission problem, not a missing workspace", () => {
    try {
      resolveFor("devos", { registryRaw, projectId: PROJECT_B });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceSelectionError);
      expect((err as WorkspaceSelectionError).code).toBe("workspace_not_permitted");
    }
  });

  it("leaves an unbound workspace available to any project", () => {
    expect(resolveFor("other", { registryRaw, projectId: PROJECT_B }).repoRoot).toBeTruthy();
  });
});

describe("registry parsing", () => {
  it("treats an unset registry as no allow-list", () => {
    expect(parseWorkspaceRegistry(undefined)).toBeNull();
    expect(parseWorkspaceRegistry("")).toBeNull();
  });

  it("accepts the shorthand and the long form together", () => {
    const entries = parseWorkspaceRegistry(
      JSON.stringify({ a: "repo-a", b: { path: "repo-b", projects: ["p"] } }),
    );
    expect(entries).toEqual([
      { key: "a", path: "repo-a" },
      { key: "b", path: "repo-b", projects: ["p"] },
    ]);
  });

  it("throws on malformed JSON rather than silently allowing everything", () => {
    // An operator who meant to restrict workspaces must not end up
    // unrestricted because of a typo.
    expect(() => parseWorkspaceRegistry("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a registry that is not an object of entries", () => {
    expect(() => parseWorkspaceRegistry('["a"]')).toThrow(/must be a JSON object/);
  });

  it("rejects an entry with an unusable key or no path", () => {
    expect(() => parseWorkspaceRegistry('{"../x":"y"}')).toThrow(/not a usable slug/);
    expect(() => parseWorkspaceRegistry('{"a":{"projects":[]}}')).toThrow(/has no path/);
  });
});

describe("listWorkspaces", () => {
  it("discovers git repositories beneath the root when no allow-list is set", () => {
    const listed = listWorkspaces({ root, registryRaw: undefined });
    const keys = listed.map((w) => w.key);
    expect(keys).toContain("devos");
    expect(keys).toContain("other");
    // Not a repository, so not offered.
    expect(keys).not.toContain("notarepo");
  });

  it("lists exactly the allow-list when one is set", () => {
    const listed = listWorkspaces({
      root,
      registryRaw: JSON.stringify({ devos: "devos" }),
    });
    expect(listed.map((w) => w.key)).toEqual(["devos"]);
    expect(listed[0].available).toBe(true);
    expect(listed[0].path).toBeTruthy();
  });

  it("reports an unusable entry as unavailable with a reason, not by omitting it", () => {
    const listed = listWorkspaces({
      root,
      registryRaw: JSON.stringify({ broken: "nosuchrepo" }),
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].available).toBe(false);
    expect(listed[0].reason).toMatch(/does not exist/);
    expect(listed[0].path).toBeNull();
  });

  it("marks project-bound workspaces as restricted", () => {
    const listed = listWorkspaces({
      root,
      registryRaw: JSON.stringify({ devos: { path: "devos", projects: [PROJECT_A] } }),
    });
    expect(listed[0].restricted).toBe(true);
  });

  it("returns nothing when no root is configured", () => {
    expect(listWorkspaces({ root: undefined, registryRaw: undefined })).toEqual([]);
  });
});
