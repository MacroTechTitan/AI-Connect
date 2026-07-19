// Authed fetch helpers for the /api/admin/* routes. Built on the app's
// authedFetch (bearer-token model + API_BASE prefix + 401 refresh retry) so the
// admin panel shares the same auth plumbing as the rest of the app, but returns
// parsed JSON and throws a typed AdminApiError carrying the HTTP status (needed
// to detect 403 admin_required at the section level).

import { authedFetch, type GetAccessToken } from "../../lib/api";

export type { GetAccessToken };

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export function isAdminForbidden(err: unknown): boolean {
  return err instanceof AdminApiError && err.status === 403;
}

export async function adminFetch<T>(
  path: string,
  getAccessTokenSilently: GetAccessToken,
  init: RequestInit = {},
): Promise<T> {
  const res = await authedFetch(path, init, getAccessTokenSilently);
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON body
    }
    throw new AdminApiError(
      res.status,
      body.error ?? "unknown",
      body.message ?? res.statusText,
    );
  }
  return (await res.json()) as T;
}

// Convenience for JSON-body mutations (POST/PATCH).
export async function adminMutate<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  getAccessTokenSilently: GetAccessToken,
  body?: unknown,
): Promise<T> {
  return adminFetch<T>(path, getAccessTokenSilently, {
    method,
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}
