import { useAuth0 } from "@auth0/auth0-react";

import type { GetAccessToken } from "../lib/api";
import { AdminApp } from "./AdminApp";

// Auth gate for the /admin route. Rendered inside the Auth0Provider (see
// main.tsx). Handles the loading / signed-out states, then hands the token
// function to AdminApp. The real authorization gate is the backend requireAdmin
// middleware — this only ensures the user is signed in so requests carry a token.
export function AdminEntry() {
  const {
    isLoading,
    isAuthenticated,
    loginWithRedirect,
    getAccessTokenSilently,
  } = useAuth0();

  if (isLoading) {
    return (
      <div className="admin-gate">
        <p>Loading…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="admin-gate">
        <h1>AI Connect Admin</h1>
        <p>You need to sign in to access the admin panel.</p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => loginWithRedirect()}
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <AdminApp
      getAccessTokenSilently={getAccessTokenSilently as GetAccessToken}
    />
  );
}
