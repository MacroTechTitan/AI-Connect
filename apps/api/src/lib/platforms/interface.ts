import { githubClient } from "./github.js";
import { renderClient } from "./render.js";
import { supabaseClient } from "./supabase.js";
import type {
  Platform,
  PlatformActionResult,
  PlatformCreateResourceRequest,
  PlatformDeleteResult,
  PlatformValidationResult,
} from "./types.js";
import { vercelClient } from "./vercel.js";

export interface PlatformClient {
  validate(credential: string): Promise<PlatformValidationResult>;
  createResource(
    req: PlatformCreateResourceRequest,
  ): Promise<PlatformActionResult>;
  deleteResource(
    credential: string,
    resourceId: string,
  ): Promise<PlatformDeleteResult>;
}

export function getPlatformClient(platform: Platform): PlatformClient {
  switch (platform) {
    case "github":
      return githubClient;
    case "vercel":
      return vercelClient;
    case "render":
      return renderClient;
    case "supabase":
      return supabaseClient;
  }
}
