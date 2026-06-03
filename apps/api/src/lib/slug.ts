// Derive a URL-safe slug from an email's local part.
// "Jane.Doe+test@example.com" → "jane-doe-test"
//
// Replaces '.' and '+' with '-'. Other characters (digits, letters, hyphens,
// underscores) pass through. Callers handle slug uniqueness with their own
// collision-retry strategy — this function only produces the natural slug.
export function deriveSlugFromEmail(email: string): string {
  const prefix = email.split("@")[0] ?? email;
  return prefix.toLowerCase().replace(/[.+]/g, "-");
}

// Derive a URL-safe slug from arbitrary text. Lowercases, replaces runs of
// non-alphanumeric characters with a single hyphen, trims leading/trailing
// hyphens. Returns "" when nothing usable remains — the caller decides
// whether that's an error.
//
//   "My Cool Project!"     → "my-cool-project"
//   "  Client X Dashboard" → "client-x-dashboard"
//   "----"                 → ""
export function deriveSlugFromText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
