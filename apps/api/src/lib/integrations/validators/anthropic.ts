import { and, eq } from "drizzle-orm";

import { getDb } from "../../../db/client.js";
import { providerKeys } from "../../../db/schema.js";
import type {
  AnthropicConfig,
  IntegrationValidator,
} from "../types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Factory function. Returns an IntegrationValidator bound to a userId so it
 * can check provider_key ownership. Mirror of makeOpenAiValidator (Commit 5)
 * — same shape, different provider value.
 */
export function makeAnthropicValidator(
  userId: string,
): IntegrationValidator {
  return async ({ config }) => {
    const c = config as AnthropicConfig;

    if (
      typeof c.provider_key_id !== "string" ||
      !UUID_RE.test(c.provider_key_id)
    ) {
      return {
        valid: false,
        errorMessage:
          "Anthropic integration requires config.provider_key_id (must be a UUID referencing an Anthropic provider key).",
      };
    }

    const [row] = await getDb()
      .select({
        id: providerKeys.id,
        provider: providerKeys.provider,
        label: providerKeys.label,
      })
      .from(providerKeys)
      .where(
        and(
          eq(providerKeys.id, c.provider_key_id),
          eq(providerKeys.userId, userId),
        ),
      )
      .limit(1);

    if (!row) {
      return {
        valid: false,
        errorMessage:
          "The referenced provider key was not found in your account.",
      };
    }

    if (row.provider !== "anthropic") {
      return {
        valid: false,
        errorMessage: `The referenced provider key is for ${row.provider}, not anthropic. Pick an Anthropic provider key in /api/keys.`,
      };
    }

    return {
      valid: true,
      identity: {
        provider_key_id: row.id,
        label: row.label,
      },
    };
  };
}
