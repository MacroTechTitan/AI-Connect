export type ArticleCategory =
  | "getting-started"
  | "connectors"
  | "project-genesis"
  | "billing"
  | "advanced";

export type Article = {
  id: string; // URL slug, e.g. 'what-is-ai-connect'
  title: string;
  category: ArticleCategory;
  order?: number; // sort within category (default 999)
  content: string; // raw markdown
};

export const CATEGORY_LABELS: Record<ArticleCategory, string> = {
  "getting-started": "Getting Started",
  connectors: "Connectors",
  "project-genesis": "Project Genesis",
  billing: "Billing",
  advanced: "Advanced",
};

export const CATEGORY_ORDER: ArticleCategory[] = [
  "getting-started",
  "connectors",
  "project-genesis",
  "billing",
  "advanced",
];
