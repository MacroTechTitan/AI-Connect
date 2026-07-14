import type { Article } from "./types.js";

// Commit 12 ships one placeholder to prove the plumbing works. Commit 13
// replaces this with the real article set.
const placeholderArticle: Article = {
  id: "placeholder",
  title: "Help Center under construction",
  category: "getting-started",
  order: 1,
  content: `# Help Center under construction

This is a placeholder. Real articles land in Commit 13.

## What's here

- **Sidebar navigation** — categorized on the left
- **Article rendering** — markdown → HTML
- **Deep links** — coming with content

## What's coming

Articles for WordPress, OpenClaw, Auth0, Stripe, GitHub connectors
plus Getting Started, Project Genesis, Billing, and Advanced sections.
`,
};

export const ARTICLES: Article[] = [placeholderArticle];

export function getArticleById(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}

export function getArticlesByCategory(category: string): Article[] {
  return ARTICLES.filter((a) => a.category === category).sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999),
  );
}
