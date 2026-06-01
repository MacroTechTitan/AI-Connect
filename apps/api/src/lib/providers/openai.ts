import { performance } from "node:perf_hooks";

import type { ProviderClient } from "./interface.js";
import type {
  ProviderInvocationError,
  ProviderInvocationRequest,
  ProviderInvocationResult,
} from "./types.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 30_000;

interface OpenAISuccess {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIError {
  error?: { type?: string; code?: string; message?: string };
}

function friendlyMessage(status: number, providerMsg: string | undefined): string {
  if (status === 401) {
    return "OpenAI rejected the API key — verify it at https://platform.openai.com/api-keys";
  }
  if (status === 429) {
    return providerMsg
      ? `OpenAI rate limit hit: ${providerMsg}`
      : "OpenAI rate limit hit — slow down requests or check your usage tier.";
  }
  if (status >= 500) {
    return providerMsg
      ? `OpenAI server error: ${providerMsg}`
      : "OpenAI returned a server error — try again shortly.";
  }
  return providerMsg ?? `OpenAI request failed with HTTP ${status}.`;
}

async function invoke(
  req: ProviderInvocationRequest,
): Promise<ProviderInvocationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();

  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        max_completion_tokens: req.maxTokens ?? 4096,
        messages: [{ role: "user", content: req.prompt }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let providerMsg: string | undefined;
      try {
        const errBody = (await res.json()) as OpenAIError;
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

    const body = (await res.json()) as OpenAISuccess;
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      status: "success",
      responseText: text,
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `OpenAI request exceeded ${TIMEOUT_MS}ms.`,
        latencyMs,
      };
    }
    return {
      status: "error",
      errorCode: "network_error",
      errorMessage:
        err instanceof Error
          ? `Network error contacting OpenAI: ${err.message}`
          : "Unknown network error contacting OpenAI.",
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const openaiClient: ProviderClient = { invoke };
