import { useAuth0 } from "@auth0/auth0-react";

// Inline recovery UI rendered by any component that catches a session_expired
// error. The button triggers loginWithRedirect — one click and the user is
// back through the Auth0 flow.
export function SessionExpiredNotice() {
  const { loginWithRedirect } = useAuth0();
  return (
    <div className="session-expired">
      <span>Your session expired.</span>
      <button
        type="button"
        className="btn-primary"
        onClick={() => void loginWithRedirect()}
      >
        Sign in again
      </button>
    </div>
  );
}
