import "./HelpApp.css";
import { useMemo } from "react";

import type { Article } from "./articles/types.js";
import { formatMarkdown } from "./shared/formatMarkdown.js";

export function HelpArticleRenderer({ article }: { article: Article }) {
  const html = useMemo(
    () => formatMarkdown(article.content),
    [article.content],
  );

  return (
    <article className="help-article">
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
