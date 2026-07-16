# AI Connect Help Center (Developer Guide)

The Help Center is an in-app content browser at `/help`. It is public — no auth required — and built from markdown files bundled at build time via Vite's `?raw` imports. There is no CMS and no runtime fetch: an article ships when the frontend ships.

This document is for developers adding or maintaining articles. For the articles themselves, see `apps/web/src/help/articles/`.

## Architecture

`apps/web/src/help/`:

- `HelpApp.tsx` — root; sidebar + article renderer (`HelpApp.css` alongside)
- `HelpSidebar.tsx` — category-grouped nav
- `HelpArticleRenderer.tsx` — renders markdown → HTML
- `articles/index.ts` — the article registry (`ARTICLES`)
- `articles/types.ts` — `Article` type, `ArticleCategory`, `CATEGORY_LABELS`, `CATEGORY_ORDER`
- `articles/*.md` — one file per article
- `articles/vite-md.d.ts` — the `*.md?raw` module declaration
- `shared/formatMarkdown.ts` — `marked` + `DOMPurify` wrapper

The route gate lives in `main.tsx`, which checks `window.location.pathname` for `/help` (or any `/help/*` path). It renders **outside** the Auth0 wrapper — this is what makes the Help Center public, and it's the difference from the `/admin` gate, which renders inside the wrapper because it needs a token.

Markdown is parsed by `marked` (GFM on, `breaks: false` — a single newline does not become a `<br>`) and sanitized through `DOMPurify` before injection. Articles are bundled at build time and therefore low-risk, but the sanitize step is not optional — it's what makes the rendered HTML safe to inject. `target` and `rel` are explicitly allowed so external links can open in a new tab safely.

## Article categories

In sidebar order, from `CATEGORY_ORDER` in `articles/types.ts`:

| `ArticleCategory` | Label |
|-------------------|-------|
| `getting-started` | Getting Started |
| `connectors` | Connectors |
| `project-genesis` | Project Genesis |
| `billing` | Billing |
| `advanced` | Advanced |

Adding a category means updating the union type, `CATEGORY_LABELS`, and `CATEGORY_ORDER` together — the type makes the first two enforceable, but a category missing from `CATEGORY_ORDER` will not render in the sidebar.

## Adding a new article

### Step 1 — create the .md file

`apps/web/src/help/articles/<slug>.md`

Convention: the filename slug matches the article `id`, kebab-case. `openclaw-local-mode.md` → `id: 'openclaw-local-mode'`. This is a convention, not something the code enforces — but the `id` is the URL hash, so breaking it makes deep links confusing rather than broken.

Content is standard GitHub-Flavored Markdown. Headings, code blocks, lists, and links all work.

### Step 2 — import and register

In `apps/web/src/help/articles/index.ts`:

```typescript
import connectingToOpenclawContent from "./connecting-to-openclaw.md?raw";

export const ARTICLES: Article[] = [
  // ...existing articles
  {
    id: "connecting-to-openclaw",
    title: "Connecting to OpenClaw",
    category: "connectors", // one of ArticleCategory
    order: 6,               // sort within category; optional, defaults to 999
    content: connectingToOpenclawContent,
  },
];
```

`order` is optional — omitting it sorts the article to the end of its category (default 999). Give it an explicit order if position matters.

### Step 3 — verify

```bash
pnpm --filter @ai-connect/web build
```

The `.md?raw` import is handled by Vite; the module declaration in `articles/vite-md.d.ts` is what keeps `tsc` happy:

```typescript
declare module "*.md?raw" {
  const content: string;
  export default content;
}
```

### Step 4 (optional) — add a `?` deep link

If the article is contextually relevant to a panel, add a `HelpLink` from that panel:

```typescript
import { HelpLink } from "../components/HelpLink.js";

<h2>
  OpenClaw <HelpLink articleId="connecting-to-openclaw" />
</h2>
```

`label` is optional — it sets the tooltip / `aria-label`, defaulting to `Help — <articleId with dashes as spaces>`. Pass it when the derived text would read badly:

```typescript
<HelpLink articleId="openclaw-local-mode" label="Help — Running OpenClaw locally" />
```

## Deep linking

Article IDs are addressable via the URL hash: `/help#connecting-to-openclaw`.

`HelpApp` reads `window.location.hash` on mount and listens for `hashchange` (so the back button and cross-tab deep links work). Selecting an article syncs the hash via `window.history.replaceState`, keeping URLs shareable and bookmarkable without stacking history entries.

An unknown hash never errors — `getArticleById` gates every read. On mount, `/help#nonexistent` falls back to `ARTICLES[0]` (first in *registry* order, which is not necessarily first in sidebar order); on a later `hashchange`, an unrecognized hash is ignored and the current article stays selected. Either way a typo'd deep link fails quietly, so check the ID against the registry when a link "does nothing."

External deep links use the same shape: `<a href="/help#stripe">Learn more</a>`.

## Content style

The current 12 articles are ported from the developer docs (`docs/*_CONNECTOR.md`, `docs/BILLING.md`). Tone is technical and direct, matching AI Connect's overall communication style. Iterating toward a non-developer audience is Sprint 10.5+ work.

Do:
- Use headings, lists, and code blocks for scanability
- Cross-reference other articles with hash links
- Explain the "why" behind a feature, not just the "how"

Don't:
- Add screenshots yet — deferred to Sprint 10.5+, needs image hosting
- Duplicate content across articles; link instead
- Reference external images — a broken link breaks the article

## Bundling considerations

`marked` + `dompurify` are currently in the main JS bundle. As of this commit the production build emits:

```
dist/assets/index-*.js   600.81 kB │ gzip: 179.36 kB
```

That is over Vite's 500 kB chunk-size warning, and the build prints the warning on every run. Dynamic `import()` for `/help` and `/admin` would code-split `marked`, `dompurify`, and the admin section code out of the main bundle — both surfaces are render-root gated, so neither is needed by the default app tree. Deferred to Sprint 10.5+ as a bundle optimization.

Treat the warning as expected build output for now, not as a regression signal — but if the number climbs materially past this baseline, the code-split is overdue.

## What's not in v1

Sprint 10.5+ / 11+:

- Search across articles (client-side full-text, or server-indexed)
- Article versioning / changelog
- Multi-language
- Screenshots and images
- A statically hosted docs site alongside the in-app browser
- Article analytics (which articles get read, which deep links get clicked)
- Rich embeds (video, interactive demos)
- Code-splitting `/help` and `/admin` out of the main bundle

## Source code reference

- `apps/web/src/help/HelpApp.tsx` — root, hash sync, article selection
- `apps/web/src/help/HelpSidebar.tsx` — category-grouped nav
- `apps/web/src/help/HelpArticleRenderer.tsx` — markdown → HTML
- `apps/web/src/help/articles/index.ts` — `ARTICLES` registry + `getArticleById`
- `apps/web/src/help/articles/types.ts` — `Article`, `ArticleCategory`, `CATEGORY_LABELS`, `CATEGORY_ORDER`
- `apps/web/src/help/articles/vite-md.d.ts` — `*.md?raw` declaration
- `apps/web/src/help/shared/formatMarkdown.ts` — `marked` + `DOMPurify`
- `apps/web/src/components/HelpLink.tsx` + `.css` — the `?` deep-link affordance
- `apps/web/src/main.tsx` — `/help` render-root gate (public, outside Auth0)
