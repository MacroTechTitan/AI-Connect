import "./HelpLink.css";

type HelpLinkProps = {
  articleId: string;
  label?: string; // optional tooltip / aria-label
};

// Small "?" affordance rendered next to panel/wizard titles. Deep-links into
// the Help Center at /help#<articleId> (article IDs from the Commit 13
// registry). Opens in a new tab so the user's in-app context is preserved.
export function HelpLink({ articleId, label }: HelpLinkProps) {
  const href = `/help#${articleId}`;
  const ariaLabel = label ?? `Help — ${articleId.replace(/-/g, " ")}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="help-link"
      title={ariaLabel}
      aria-label={ariaLabel}
    >
      <span className="help-link-icon" aria-hidden="true">
        ?
      </span>
    </a>
  );
}
