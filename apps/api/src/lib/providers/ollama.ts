import { performance } from "node:perf_hooks";

import type { ProviderClient } from "./interface.js";
import type {
  ProviderInvocationRequest,
  ProviderInvocationResult,
} from "./types.js";

const TIMEOUT_MS = 60_000;

interface OllamaSuccess {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaError {
  error?: string;
}

function parseBaseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

async function invoke(
  req: ProviderInvocationRequest,
): Promise<ProviderInvocationResult> {
  const start = performance.now();
  const base = parseBaseUrl(req.apiKey);
  if (!base) {
    return {
      status: "error",
      errorCode: "invalid_endpoint",
      errorMessage: `Ollama endpoint is not a valid URL: "${req.apiKey}".`,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const endpoint = new URL("/api/generate", base).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        stream: false,
        options: { num_predict: req.maxTokens ?? 4096 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let providerMsg: string | undefined;
      try {
        const errBody = (await res.json()) as OllamaError;
        providerMsg = errBody.error;
      } catch {
        // response was not JSON
      }
      return {
        status: "error",
        errorCode: `http_${res.status}`,
        errorMessage:
          providerMsg ??
          `Ollama at ${endpoint} returned HTTP ${res.status}.`,
        latencyMs: Math.round(performance.now() - start),
      };
    }

    const body = (await res.json()) as OllamaSuccess;
    return {
      status: "success",
      responseText: body.response ?? "",
      inputTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "timeout",
        errorCode: "timeout",
        errorMessage: `Ollama request to ${endpoint} exceeded ${TIMEOUT_MS}ms.`,
        latencyMs,
      };
    }
    return {
      status: "error",
      errorCode: "network_error",
      errorMessage:
        err instanceof Error
          ? `Network error contacting Ollama at ${endpoint}: ${err.message}`
          : `Unknown network error contacting Ollama at ${endpoint}.`,
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const ollamaClient: ProviderClient = { invoke };
