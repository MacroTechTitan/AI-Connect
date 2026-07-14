import "./HelpApp.css";
import { useEffect, useState } from "react";

import { ARTICLES, getArticleById } from "./articles/index.js";
import { HelpArticleRenderer } from "./HelpArticleRenderer.js";
import { HelpSidebar } from "./HelpSidebar.js";

export function HelpApp() {
  const [activeArticleId, setActiveArticleId] = useState<string | null>(() => {
    // Deep link: /help#wordpress selects that article on load.
    const hash = window.location.hash.slice(1);
    if (hash && getArticleById(hash)) return hash;
    return ARTICLES[0]?.id ?? null;
  });

  // Keep the URL hash in sync so links are shareable / bookmarkable.
  useEffect(() => {
    if (activeArticleId) {
      window.history.replaceState(null, "", `#${activeArticleId}`);
    }
  }, [activeArticleId]);

  // React to hash changes (back button / cross-tab deep links).
  useEffect(() => {
    const handler = () => {
      const hash = window.location.hash.slice(1);
      if (hash && getArticleById(hash)) {
        setActiveArticleId(hash);
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const activeArticle = activeArticleId
    ? getArticleById(activeArticleId)
    : null;

  return (
    <div className="help-app">
      <HelpSidebar
        activeArticleId={activeArticleId}
        onArticleSelect={setActiveArticleId}
      />
      <main className="help-main">
        {activeArticle ? (
          <HelpArticleRenderer article={activeArticle} />
        ) : (
          <div className="help-empty">
            <p>Select an article from the sidebar.</p>
          </div>
        )}
      </main>
    </div>
  );
}
