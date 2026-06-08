export type {
  Platform,
  PlatformCreateResourceRequest,
  PlatformCreateResourceResponse,
  PlatformActionError,
  PlatformActionResult,
  PlatformValidationResult,
  PlatformDeleteResult,
  ValidatedIdentity,
} from "./types.js";
export { getPlatformClient } from "./interface.js";
export type { PlatformClient } from "./interface.js";

// Sprint 5: create-from-template (GitHub) and the env-level Cloudflare DNS
// client. Both sit alongside the Sprint 4 platform abstraction rather than
// inside the Platform union / PlatformClient interface.
export { createRepoFromTemplate } from "./github.js";
export {
  waitUntilReady as supabaseWaitUntilReady,
  buildConnectionString as supabaseBuildConnectionString,
} from "./supabase.js";
export {
  getServiceEnvVars,
  putServiceEnvVars,
} from "./render.js";
export type { RenderEnvVar } from "./render.js";
export { getCloudflareClient } from "./cloudflare.js";
export type {
  CloudflareClient,
  CloudflareValidationResult,
  CloudflareCnameResult,
  CloudflareDeleteResult,
} from "./cloudflare.js";
