import { Auth0Provider } from "@auth0/auth0-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isUiDemo ? (
      <UiDemoPage />
    ) : (
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
        <App />
      </Auth0Provider>
    )}
  </React.StrictMode>,
);
