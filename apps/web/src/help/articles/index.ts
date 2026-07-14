import type { Article } from "./types.js";

// Content lives as .md files for editability; Vite's ?raw loads each as a
// string at build time. Commit 13 replaces Commit 12's single placeholder
// with the real 12-article set.
import auth0Content from "./auth0.md?raw";
import githubContent from "./github.md?raw";
import managingSubscriptionContent from "./managing-your-subscription.md?raw";
import openclawContent from "./openclaw.md?raw";
import openclawLocalModeContent from "./openclaw-local-mode.md?raw";
import projectGenesisContent from "./project-genesis-overview.md?raw";
import stripeContent from "./stripe.md?raw";
import understandingTiersContent from "./understanding-tiers.md?raw";
import upgradingToProContent from "./upgrading-to-pro.md?raw";
import whatIsContent from "./what-is-ai-connect.md?raw";
import wordpressContent from "./wordpress.md?raw";
import yourFirstProjectContent from "./your-first-project.md?raw";

export const ARTICLES: Article[] = [
  {
    id: "what-is-ai-connect",
    title: "What is AI Connect?",
    category: "getting-started",
    order: 1,
    content: whatIsContent,
  },
  {
    id: "your-first-project",
    title: "Your first project",
    category: "getting-started",
    order: 2,
    content: yourFirstProjectContent,
  },
  {
    id: "understanding-tiers",
    title: "Understanding tiers",
    category: "getting-started",
    order: 3,
    content: understandingTiersContent,
  },
  {
    id: "wordpress",
    title: "WordPress",
    category: "connectors",
    order: 1,
    content: wordpressContent,
  },
  {
    id: "auth0",
    title: "Auth0",
    category: "connectors",
    order: 2,
    content: auth0Content,
  },
  {
    id: "stripe",
    title: "Stripe",
    category: "connectors",
    order: 3,
    content: stripeContent,
  },
  {
    id: "github",
    title: "GitHub App",
    category: "connectors",
    order: 4,
    content: githubContent,
  },
  {
    id: "openclaw",
    title: "OpenClaw",
    category: "connectors",
    order: 5,
    content: openclawContent,
  },
  {
    id: "project-genesis-overview",
    title: "Project Genesis overview",
    category: "project-genesis",
    order: 1,
    content: projectGenesisContent,
  },
  {
    id: "upgrading-to-pro",
    title: "Upgrading to Pro",
    category: "billing",
    order: 1,
    content: upgradingToProContent,
  },
  {
    id: "managing-your-subscription",
    title: "Managing your subscription",
    category: "billing",
    order: 2,
    content: managingSubscriptionContent,
  },
  {
    id: "openclaw-local-mode",
    title: "OpenClaw local mode",
    category: "advanced",
    order: 1,
    content: openclawLocalModeContent,
  },
];

export function getArticleById(id: string): Article | undefined {
  return ARTICLES.find((a) => a.id === id);
}

export function getArticlesByCategory(category: string): Article[] {
  return ARTICLES.filter((a) => a.category === category).sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999),
  );
}
