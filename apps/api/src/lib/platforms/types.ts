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
  // Per-template build/start commands (Sprint 5.5). Omitted → Sprint 4 defaults.
  buildCommand?: string;
  startCommand?: string;

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

// The account identity behind a validated credential. `name`/`email` are
// human-facing (shown in the settings UI). `ownerId`/`organizationId` are the
// resource-parent IDs the orchestrator needs to create resources under:
//   - Render services are created under an account owner (`ownerId`)
//   - Supabase projects are created under an organization (`organizationId`)
// The validate() call for those two platforms already fetches the owner/org
// list, so it exposes the first entry's id here rather than forcing the
// orchestrator to re-fetch it.
export interface ValidatedIdentity {
  name?: string;
  email?: string;
  ownerId?: string;
  organizationId?: string;
}

export interface PlatformValidationResult {
  valid: boolean;
  errorMessage?: string;
  identity?: ValidatedIdentity;
}

export interface PlatformDeleteResult {
  deleted: boolean;
  errorMessage?: string;
}
