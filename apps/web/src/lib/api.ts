// Shared API helpers used by App.tsx and the feature components. Extracted from
// App.tsx so component files can reuse the exact Sprint 1 bearer-token model
// (authedFetch + session_expired sentinel) without importing from App.tsx,
// which would create a circular dependency.

export type GetAccessToken = (opts?: { cacheMode?: "off" }) => Promise<string>;

export const API_BASE = import.meta.env.VITE_API_BASE_URL as string;

// Sentinel error message thrown by authedFetch when the Auth0 SDK fails to
// produce an access token — typically because the refresh token is missing,
// the user needs to re-auth, or consent expired. Components catch this and
// render <SessionExpiredNotice /> instead of the misleading "couldn't reach
// the server" copy.
export const SESSION_EXPIRED = "session_expired";

export function isSessionExpired(err: unknown): boolean {
  return err instanceof Error && err.message === SESSION_EXPIRED;
}

// Single retry on 401: forces a token refresh in case the cached access token
// has expired or its audience/scope drifted. If the SDK itself throws on the
// token call (Missing Refresh Token / Login Required / Consent Required),
// surface a structured session_expired error so the UI can show recovery.
export async function authedFetch(
  path: string,
  init: RequestInit,
  getAccessTokenSilently: GetAccessToken,
): Promise<Response> {
  const send = async (forceRefresh: boolean): Promise<Response> => {
    let token: string;
    try {
      token = await getAccessTokenSilently(
        forceRefresh ? { cacheMode: "off" } : undefined,
      );
    } catch (err) {
      const wrapped = new Error(SESSION_EXPIRED);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  };
  const res = await send(false);
  if (res.status === 401) return send(true);
  return res;
}
