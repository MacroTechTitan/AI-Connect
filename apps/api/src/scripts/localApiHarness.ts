// Boots the REAL AI Connect API (src/index.ts, unmodified) against a
// non-production database, with a throwaway local OIDC issuer in front of it.
//
// Nothing here stubs or bypasses application code: the Express app, the Auth0
// JWT middleware, the org-scoping, the Drizzle queries and the audit logging
// are all the production code paths. The only substitutions are the database
// (a local staging Postgres) and the identity provider (an ephemeral keypair
// on 127.0.0.1). Used by scripts/buildControlSmoke.ts and by the route
// integration tests.

import { createServer } from "node:http";

import { loadLocalEnv } from "../lib/loadLocalEnv.js";
import { requireNonProductionTarget, type DbTarget } from "./dbTarget.js";
import { startLocalIssuer, type LocalIssuer } from "./localIssuer.js";

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface LocalApi {
  baseUrl: string;
  target: DbTarget;
  issuer: LocalIssuer;
  /** Mint a bearer token for an email. */
  token(email: string): Promise<string>;
  /** Authenticated (or, with token=null, anonymous) JSON request. */
  request<T = unknown>(
    method: string,
    path: string,
    opts?: { token?: string | null; body?: unknown },
  ): Promise<ApiResponse<T>>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not allocate a port");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

export async function startLocalApi(): Promise<LocalApi> {
  loadLocalEnv();

  // Hard stop before anything boots if DATABASE_URL could be production.
  const target = requireNonProductionTarget(process.env.DATABASE_URL);

  const issuer = await startLocalIssuer();
  const port = await freePort();

  // Set BEFORE importing index.js — lib/env.ts parses process.env at import
  // time, so this must happen while the module graph is still unloaded.
  process.env.AUTH0_ISSUER_BASE_URL = issuer.issuer;
  process.env.AUTH0_AUDIENCE = issuer.audience;
  process.env.PORT = String(port);
  process.env.NODE_ENV ??= "development";

  const mod = (await import("../index.js")) as { server: import("node:http").Server };
  const server = mod.server;
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }

  // lib/env.ts parses process.env at import time. If something already pulled
  // it into the module graph before this function ran, the variables set above
  // were too late and the app is running with the wrong configuration —
  // listening on the default port, with no issuer, so every request 401s.
  // Fail here with the cause rather than leaving a confusing ECONNREFUSED or a
  // wall of "auth0_not_configured".
  const { env } = (await import("../lib/env.js")) as {
    env: { AUTH0_ISSUER_BASE_URL?: string };
  };
  if (env.AUTH0_ISSUER_BASE_URL !== issuer.issuer) {
    await new Promise<void>((r) => server.close(() => r()));
    await issuer.close();
    throw new Error(
      "lib/env.ts was imported before startLocalApi() could configure it, so the " +
        "API is running with the wrong settings. Import this harness before any " +
        "module that reaches lib/env.ts, or import those modules dynamically " +
        "after startLocalApi() resolves.",
    );
  }

  // The server's real address, not the port we asked for — they differ if the
  // requested port was already taken.
  const address = server.address();
  const boundPort =
    address !== null && typeof address !== "string" ? address.port : port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;
  const tokens = new Map<string, string>();

  async function token(email: string): Promise<string> {
    const cached = tokens.get(email);
    if (cached) return cached;
    const minted = await issuer.mint(email);
    tokens.set(email, minted);
    return minted;
  }

  return {
    baseUrl,
    target,
    issuer,
    token,
    async request<T>(
      method: string,
      path: string,
      opts: { token?: string | null; body?: unknown } = {},
    ): Promise<ApiResponse<T>> {
      const headers: Record<string, string> = {};
      if (opts.token !== null && opts.token !== undefined) {
        headers.authorization = `Bearer ${opts.token}`;
      }
      if (opts.body !== undefined) headers["content-type"] = "application/json";

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        /* leave as text — the assertion will show what came back */
      }
      return { status: res.status, body: body as T };
    },
    async stop(): Promise<void> {
      // Undici keeps sockets alive; without this close() never resolves.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await issuer.close();
    },
  };
}
