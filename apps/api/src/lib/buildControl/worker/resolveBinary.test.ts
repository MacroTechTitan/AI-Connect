import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveWorkerBinary } from "./resolveBinary.js";

// Resolution is tested against a real directory tree because the whole point
// is what the filesystem actually contains. It is also the difference between
// a runner that works on Windows and one that dies with a bare ENOENT — the
// exact failure this file was written in response to.

const isWindows = process.platform === "win32";

let base: string;
let binDir: string;
let emptyDir: string;

function touch(path: string, content = ""): void {
  writeFileSync(path, content);
}

beforeAll(() => {
  base = mkdtempSync(resolve(tmpdir(), "aic-bin-"));
  binDir = resolve(base, "bin");
  emptyDir = resolve(base, "empty");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("an explicitly configured binary", () => {
  it("is trusted as given", () => {
    const result = resolveWorkerBinary("/opt/claude/claude", "");
    expect(result).toEqual({
      ok: true,
      command: "/opt/claude/claude",
      prefixArgs: [],
      source: "CLAUDE_CODE_BIN",
    });
  });

  it("runs a .js entry point with this process's node, not a shell", () => {
    const js = resolve(binDir, "cli.js");
    touch(js, "// cli");
    const result = resolveWorkerBinary(js, "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe(process.execPath);
    expect(result.prefixArgs).toEqual([js]);
  });

  it("rejects a .js path that does not exist rather than failing at spawn", () => {
    const result = resolveWorkerBinary(resolve(binDir, "missing.js"), "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing file/);
  });
});

describe("searching PATH", () => {
  it("explains itself when Claude Code is nowhere on PATH", () => {
    const result = resolveWorkerBinary(undefined, emptyDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not found on PATH/);
    expect(result.reason).toMatch(/CLAUDE_CODE_BIN/);
  });

  it("ignores an empty PATH", () => {
    expect(resolveWorkerBinary(undefined, "").ok).toBe(false);
    expect(resolveWorkerBinary(undefined, undefined).ok !== undefined).toBe(true);
  });

  it.skipIf(isWindows)("finds an executable on POSIX", () => {
    const bin = resolve(binDir, "claude");
    touch(bin, "#!/bin/sh\n");
    rmSync(bin);
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    const result = resolveWorkerBinary(undefined, binDir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command).toBe(bin);
  });

  it.skipIf(!isWindows)("prefers a real .exe over the shims beside it", () => {
    const dir = resolve(base, "win-exe");
    mkdirSync(dir, { recursive: true });
    touch(resolve(dir, "claude"), "#!/bin/sh\n");
    touch(resolve(dir, "claude.cmd"), "@echo off\n");
    touch(resolve(dir, "claude.exe"), "MZ");

    const result = resolveWorkerBinary(undefined, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe(resolve(dir, "claude.exe"));
    expect(result.source).toBe("PATH");
  });

  it.skipIf(!isWindows)(
    "never picks the extension-less npm script, which Windows cannot spawn",
    () => {
      // This is the bug the live smoke test hit: the file exists and is
      // readable, but CreateProcess cannot run a shell script, so spawn fails
      // with a bare ENOENT well after the operator has started a run.
      const dir = resolve(base, "win-script-only");
      mkdirSync(dir, { recursive: true });
      touch(resolve(dir, "claude"), "#!/bin/sh\n");

      const result = resolveWorkerBinary(undefined, dir);
      expect(result.ok).toBe(false);
    },
  );

  it.skipIf(!isWindows)("follows a .cmd shim to the real npm-installed binary", () => {
    const dir = resolve(base, "win-shim");
    const real = resolve(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(real, { recursive: true });
    touch(resolve(dir, "claude.cmd"), "@echo off\n");
    touch(resolve(real, "claude.exe"), "MZ");

    const result = resolveWorkerBinary(undefined, dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toBe(resolve(real, "claude.exe"));
    expect(result.source).toMatch(/npm layout/);
  });

  it.skipIf(!isWindows)("says why a lone shim is unusable instead of failing later", () => {
    const dir = resolve(base, "win-lonely-shim");
    mkdirSync(dir, { recursive: true });
    touch(resolve(dir, "claude.cmd"), "@echo off\n");

    const result = resolveWorkerBinary(undefined, dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/shim/);
    expect(result.reason).toMatch(/CLAUDE_CODE_BIN/);
  });

  it("searches every PATH entry, not just the first", () => {
    const dir = resolve(base, "second-entry");
    mkdirSync(dir, { recursive: true });
    const name = isWindows ? "claude.exe" : "claude";
    const bin = resolve(dir, name);
    writeFileSync(bin, "MZ", { mode: 0o755 });

    const result = resolveWorkerBinary(undefined, [emptyDir, dir].join(delimiter));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command).toBe(bin);
  });
});
