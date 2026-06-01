import { performance } from "node:perf_hooks";

import type { ProviderClient } from "./interface.js";
import type {
  ProviderInvocationError,
  ProviderInvocationRequest,
  ProviderInvocationResult,
} from "./types.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 30_000;

interface AnthropicSuccess {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicError {
  error?: { type?: string; message?: string };
}

function friendlyMessage(status: number, providerMsg: string | undefined): string {
  if (status === 401) {
    return "Anthropic rejected the API key — verify it at https://console.anthropic.com/settings/keys";
  }
  if (status === 429) {
    return providerMsg
      ? `Anthropic rate limit hit: ${providerMsg}`
      : "Anthropic rate limit hit — slow down requests or upgrade your plan.";
  }
  if (status >= 500) {
    return providerMsg
      ? `Anthropic server error: ${providerMsg}`
      : "Anthropic returned a server error — try again shortly.";
  }
  return providerMsg ?? `Anthropic request failed with HTTP ${status}.`;
}

async function invoke(
  req: ProviderInvocationRequest,
): Promise<ProviderInvocationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": req.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        messages: [{ role: "user", content: req.prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let providerMsg: string | undefined;
      try {
        const errBody = (await res.json()) as AnthropicError;
        providerMsg = errBody.error?.message;
      } catch {
        // response was not JSON; fall back to status-derived message
      }
      const err: ProviderInvocationError = {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage: friendlyMessage(res.status, providerMsg),
        latencyMs: Math.round(performance.now() - start),
      };
      return err;
    }

    const body = (await res.json()) as AnthropicSuccess;
    const text =
      body.content?.find((c) => c.type === "text" && typeof c.text === "string")
        ?.text ?? "";
    return {
      status: "success",
      responseText: text,
      inputTokens: body.usage?.input_tokens ?? null,
      outputTokens: body.usage?.output_tokens ?? null,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Anthropic request exceeded ${TIMEOUT_MS}ms.`,
        latencyMs,
      };
    }
    return {
      status: "error",
      errorCode: "network_error",
      errorMessage:
        err instanceof Error
          ? `Network error contacting Anthropic: ${err.message}`
          : "Unknown network error contacting Anthropic.",
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const anthropicClient: ProviderClient = { invoke };
