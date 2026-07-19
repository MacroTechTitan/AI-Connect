import { getArticlesByCategory } from "./articles/index.js";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "./articles/types.js";

export function HelpSidebar({
  activeArticleId,
  onArticleSelect,
}: {
  activeArticleId: string | null;
  onArticleSelect: (articleId: string) => void;
}) {
  return (
    <nav className="help-sidebar">
      <h2 className="help-sidebar-title">Help Center</h2>
      {CATEGORY_ORDER.map((category) => {
        const articles = getArticlesByCategory(category);
        if (articles.length === 0) return null;

        return (
          <div key={category} className="help-sidebar-category">
            <h3 className="help-sidebar-category-label">
              {CATEGORY_LABELS[category]}
            </h3>
            <ul className="help-sidebar-links">
              {articles.map((article) => (
                <li key={article.id}>
                  <button
                    type="button"
                    className={
                      article.id === activeArticleId
                        ? "help-sidebar-link help-sidebar-link-active"
                        : "help-sidebar-link"
                    }
                    onClick={() => onArticleSelect(article.id)}
                  >
                    {article.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
