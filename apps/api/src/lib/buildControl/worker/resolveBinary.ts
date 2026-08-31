// Finding the Claude Code executable.
//
// `spawn("claude", args)` is not portable. On Windows the npm-installed
// `claude` on PATH is a `.cmd` shim, and Node has refused to spawn `.cmd`
// files without a shell since the CVE-2024-27980 fix. Turning on `shell: true`
// would fix the spawn and reintroduce shell interpretation of every argument —
// including the operator-supplied prompt — which is exactly what passing an
// argv array is for. So instead we resolve to a real executable and keep
// `shell: false`.
//
// Resolution order:
//   1. CLAUDE_CODE_BIN, if set. A `.js` path is run with the current node.
//   2. A real executable named `claude` on PATH (`claude.exe` on Windows).
//   3. The npm layout the Windows shim points at:
//      <npm-prefix>/node_modules/@anthropic-ai/claude-code/bin/claude.exe

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export type BinaryResolution =
  | { ok: true; command: string; prefixArgs: string[]; source: string }
  | { ok: false; reason: string };

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate filenames for `name` on this platform, most preferred first. */
function candidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  // .exe/.com first: directly spawnable. .cmd/.bat are recognized only so we
  // can follow them to a real binary or explain the problem.
  //
  // The extension-less file is deliberately NOT a candidate on Windows: npm
  // installs one next to the shims, but it is a shell script for Git Bash and
  // CreateProcess cannot run it. Accepting it produces a confusing ENOENT at
  // spawn time instead of a useful message here.
  return [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.bat`];
}

interface PathHit {
  path: string;
  directlySpawnable: boolean;
  dir: string;
}

function searchPath(name: string, pathEnv: string | undefined): PathHit[] {
  const dirs = (pathEnv ?? "").split(delimiter).filter(Boolean);
  const hits: PathHit[] = [];
  for (const dir of dirs) {
    for (const candidate of candidateNames(name)) {
      const full = resolve(dir, candidate);
      if (!isExecutableFile(full)) continue;
      const lower = full.toLowerCase();
      const isShim =
        process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
      hits.push({ path: full, directlySpawnable: !isShim, dir });
    }
  }
  return hits;
}

/** Where an npm-installed claude-code keeps its real executable. */
function npmLayoutExecutable(dir: string): string | null {
  const bin = process.platform === "win32" ? "claude.exe" : "claude";
  const candidate = resolve(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", bin);
  return existsSync(candidate) && isExecutableFile(candidate) ? candidate : null;
}

export function resolveWorkerBinary(
  configured: string | undefined,
  pathEnv: string | undefined = process.env.PATH,
): BinaryResolution {
  if (configured) {
    if (configured.toLowerCase().endsWith(".js")) {
      if (!existsSync(configured)) {
        return { ok: false, reason: `CLAUDE_CODE_BIN points at a missing file: ${configured}` };
      }
      // Run the CLI's JS entry point with this process's node, so there is
      // still no shell in the picture.
      return {
        ok: true,
        command: process.execPath,
        prefixArgs: [configured],
        source: "CLAUDE_CODE_BIN (js)",
      };
    }
    // An explicitly configured path is trusted as given — an operator who
    // names a binary has made a deliberate choice.
    return { ok: true, command: configured, prefixArgs: [], source: "CLAUDE_CODE_BIN" };
  }

  const hits = searchPath("claude", pathEnv);
  if (hits.length === 0) {
    return {
      ok: false,
      reason:
        "Claude Code was not found on PATH. Install it, or set CLAUDE_CODE_BIN to its executable.",
    };
  }

  const direct = hits.find((h) => h.directlySpawnable);
  if (direct) {
    return { ok: true, command: direct.path, prefixArgs: [], source: "PATH" };
  }

  // Only a shim was found. Follow the npm layout it points at rather than
  // enabling a shell to run it.
  for (const hit of hits) {
    const real = npmLayoutExecutable(hit.dir);
    if (real) {
      return { ok: true, command: real, prefixArgs: [], source: "npm layout behind PATH shim" };
    }
  }

  return {
    ok: false,
    reason:
      `only a script shim for Claude Code was found (${hits.map((h) => h.path).join(", ")}), ` +
      "which cannot be spawned without a shell. Set CLAUDE_CODE_BIN to the real executable.",
  };
}
