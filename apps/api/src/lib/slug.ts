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
