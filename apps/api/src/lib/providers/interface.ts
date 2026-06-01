import { anthropicClient } from "./anthropic.js";
import { ollamaClient } from "./ollama.js";
import { openaiClient } from "./openai.js";
import type {
  Provider,
  ProviderInvocationRequest,
  ProviderInvocationResult,
} from "./types.js";

export interface ProviderClient {
  invoke(req: ProviderInvocationRequest): Promise<ProviderInvocationResult>;
}

export function getProviderClient(provider: Provider): ProviderClient {
  switch (provider) {
    case "anthropic":
      return anthropicClient;
    case "openai":
      return openaiClient;
    case "ollama":
      return ollamaClient;
  }
}
