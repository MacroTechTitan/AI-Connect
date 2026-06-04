export type Platform = "vercel" | "render" | "github" | "supabase";

// Universal create-resource input. credential + name are always present;
// platform-specific fields are optional and each client reads only the
// ones it needs. The orchestrator (Sprint 4 Commit 5) is responsible for
// passing the right shape per platform.
export interface PlatformCreateResourceRequest {
  credential: string;
  name: string;

  // GitHub
  description?: string;
  private?: boolean;
  autoInit?: boolean;

  // Vercel
  gitRepository?: { type: "github"; repo: string };

  // Render
  repo?: string;
  branch?: string;
  ownerId?: string;

  // Supabase
  region?: string;
  organizationId?: string;
  dbPass?: string;
}

export interface PlatformCreateResourceResponse {
  status: "success";
  resourceId: string;
  urls: Record<string, string>;
  details: Record<string, unknown>;
}

export interface PlatformActionError {
  status: "error";
  errorCode: string;
  errorMessage: string;
  isRetryable: boolean;
}

export type PlatformActionResult =
  | PlatformCreateResourceResponse
  | PlatformActionError;

export interface PlatformValidationResult {
  valid: boolean;
  errorMessage?: string;
  identity?: { name?: string; email?: string };
}

export interface PlatformDeleteResult {
  deleted: boolean;
  errorMessage?: string;
}
