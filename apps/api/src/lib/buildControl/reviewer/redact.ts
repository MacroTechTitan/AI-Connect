// Redaction for anything leaving Build Control in a review payload.
//
// The payload carries a repository diff and policy files. Either can contain a
// credential — a .env the worker touched, a test fixture, a pasted token in a
// comment. The reviewer is a separate process and, for a hosted provider, a
// separate network, so this is the last point at which we control what is
// disclosed.
//
// This is defence in depth, not a guarantee. It cannot recognize every secret,
// and it is not a reason to relax the rule that secrets do not belong in a
// repository. What it does do is stop the obvious, high-frequency shapes —
// provider keys, assignments to secret-named variables, PEM blocks and JWTs —
// from being forwarded verbatim.

export const REDACTED = "[REDACTED]";

interface Rule {
  name: string;
  pattern: RegExp;
  /** Rebuilds the line so surrounding context survives the redaction. */
  replace: (match: string, ...groups: string[]) => string;
}

const RULES: Rule[] = [
  // Known provider key shapes. Matched first because they are unambiguous.
  {
    name: "anthropic_key",
    pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: () => REDACTED,
  },
  {
    name: "openai_key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: "stripe_key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replace: () => REDACTED,
  },
  {
    name: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: "aws_access_key_id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  {
    name: "postgres_url_password",
    // Keep the shape of a connection string so a reviewer can still see that
    // one exists; remove only the password.
    pattern: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:)([^\s@]+)(@)/gi,
    replace: (_m, prefix, _pw, at) => `${prefix}${REDACTED}${at}`,
  },
  {
    name: "secret_assignment",
    // KEY=value / "key": "value" / key: value, where the NAME says secret.
    // The name is preserved: a reviewer should be able to see that a run
    // touched a credential without seeing the credential.
    pattern:
      /("?[A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|MASTER_KEY|AUTH)[A-Za-z0-9_.-]*"?)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi,
    replace: (_m, key, sep, value) => {
      // An empty value or an obvious placeholder is not a secret and hiding it
      // makes a diff harder to review for no benefit.
      const bare = value.replace(/^['"]|['"]$/g, "");
      if (bare.length === 0) return `${key}${sep}${value}`;
      if (/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|x{3,}|\.{3,}|changeme|placeholder|example|null|true|false|\d+)$/i.test(bare)) {
        return `${key}${sep}${value}`;
      }
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    },
  },
];

export interface RedactionReport {
  text: string;
  /** Rule name -> number of redactions, for the timeline. Never the values. */
  counts: Record<string, number>;
  redacted: boolean;
}

/** Redacts known secret shapes, reporting what was hit but never what it was. */
export function redact(input: string): RedactionReport {
  let text = input;
  const counts: Record<string, number> = {};

  for (const rule of RULES) {
    let hits = 0;
    text = text.replace(rule.pattern, (...args) => {
      // String.replace passes (match, ...groups, offset, string); trailing
      // args are the offset and the subject, which the rules do not want.
      const groups = args.slice(0, -2).map((g) => (typeof g === "string" ? g : "")) as string[];
      const whole = groups[0] ?? "";
      const replaced = rule.replace(whole, ...groups.slice(1));
      if (replaced !== whole) hits += 1;
      return replaced;
    });
    if (hits > 0) counts[rule.name] = hits;
  }

  return { text, counts, redacted: Object.keys(counts).length > 0 };
}

/** Redacts every string in a structure, in place of the original. */
export function redactDeep<T>(value: T): { value: T; counts: Record<string, number> } {
  const counts: Record<string, number> = {};

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const report = redact(node);
      for (const [k, n] of Object.entries(report.counts)) {
        counts[k] = (counts[k] ?? 0) + n;
      }
      return report.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value) as T, counts };
}
