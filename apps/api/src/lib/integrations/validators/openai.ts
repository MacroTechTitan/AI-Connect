import { and, eq } from "drizzle-orm";

import { getDb } from "../../../db/client.js";
import { providerKeys } from "../../../db/schema.js";
import type {
  IntegrationValidator,
  OpenAiConfig,
} from "../types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Factory function. Returns an IntegrationValidator bound to a userId so it
 * can check provider_key ownership. The route layer calls this factory with
 * the authenticated user's id before invoking the validator.
 *
 * Why a factory: IntegrationValidator's signature doesn't take a userId
 * (it's a pure (input) => Promise<Result>), but provider_key ownership is
 * a per-user check. The factory pattern closes over userId without
 * polluting the shared validator signature.
 */
export function makeOpenAiValidator(userId: string): IntegrationValidator {
  return async ({ config }) => {
    const c = config as OpenAiConfig;

    if (
      typeof c.provider_key_id !== "string" ||
      !UUID_RE.test(c.provider_key_id)
    ) {
      return {
        valid: false,
        errorMessage:
          "OpenAI integration requires config.provider_key_id (must be a UUID referencing an OpenAI provider key).",
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

    if (row.provider !== "openai") {
      return {
        valid: false,
        errorMessage: `The referenced provider key is for ${row.provider}, not openai. Pick an OpenAI provider key in /api/keys.`,
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
