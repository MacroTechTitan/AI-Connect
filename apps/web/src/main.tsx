import { Auth0Provider } from "@auth0/auth0-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { AdminEntry } from "./admin/AdminEntry.js";
import { App } from "./App.js";
import { HelpApp } from "./help/HelpApp.js";
import "./index.css";
import { injectTokens } from "./ui/tokens.js";
import { UiDemoPage } from "./ui/__demos__/UiDemoPage.js";

// Inject design tokens as --ai-* CSS custom properties at the document root
// before any component renders, so token-driven styles resolve on first paint.
injectTokens();

// The design-system demo page is gated at the render root (the app has no
// router): visit /ui or append ?ui=demo. It renders without the Auth0 wrapper
// so the primitives can be inspected without signing in.
const isUiDemo =
  window.location.pathname === "/ui" ||
  window.location.search.includes("ui=demo");

// The admin panel is gated the same way: /admin (or /admin/*). It renders
// inside the Auth0 wrapper (it needs a token), and the backend requireAdmin
// middleware is the real authorization gate.
const isAdmin =
  window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/");

// The Help Center is public — no auth. Gated at the render root like /ui, and
// rendered OUTSIDE the Auth0 wrapper.
const isHelp =
  window.location.pathname === "/help" ||
  window.location.pathname.startsWith("/help/");

// Shared Auth0 wrapper for the authenticated surfaces (app + admin).
function withAuth0(children: React.ReactNode) {
  return (
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
        scope: "openid profile email",
      }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      {children}
    </Auth0Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isUiDemo ? (
      <UiDemoPage />
    ) : isHelp ? (
      <HelpApp />
    ) : isAdmin ? (
      withAuth0(<AdminEntry />)
    ) : (
      withAuth0(<App />)
    )}
  </React.StrictMode>,
);
