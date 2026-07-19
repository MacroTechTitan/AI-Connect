import DOMPurify from "dompurify";
import { marked } from "marked";

// GitHub-flavored markdown, no auto <br> on single newlines.
marked.setOptions({ gfm: true, breaks: false });

// Renders markdown to sanitized HTML. Articles are bundled at build time (low
// risk), but we still sanitize so the output is safe to inject.
export function formatMarkdown(source: string): string {
  const rawHtml = marked.parse(source, { async: false });
  return DOMPurify.sanitize(rawHtml, {
    // Allow target/rel so external links can open in a new tab safely.
    ADD_ATTR: ["target", "rel"],
  });
}
