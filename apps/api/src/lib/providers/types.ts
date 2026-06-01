export type Provider = "anthropic" | "openai" | "ollama";

export interface ProviderInvocationRequest {
  provider: Provider;
  model: string;
  apiKey: string;
  prompt: string;
  maxTokens?: number;
}

export interface ProviderInvocationResponse {
  status: "success";
  responseText: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface ProviderInvocationError {
  status: "error" | "timeout";
  errorCode: string;
  errorMessage: string;
  latencyMs: number;
}

export type ProviderInvocationResult =
  | ProviderInvocationResponse
  | ProviderInvocationError;
