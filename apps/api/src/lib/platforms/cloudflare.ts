import { env } from "../env.js";

// Cloudflare is architecturally distinct from the user-supplied platforms
// (Vercel/Render/GitHub/Supabase): AI Connect owns the domain, so the
// credentials live in environment variables rather than platform_credentials
// rows. This client therefore reads CLOUDFLARE_* from the validated env object
// instead of taking a credential per call, and it does NOT implement the
// PlatformClient interface or appear in the Platform union type.

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 30_000;

export interface CloudflareValidationResult {
  valid: boolean;
  errorMessage?: string;
  zoneName?: string;
}

export interface CloudflareCnameResult {
  success: boolean;
  recordId?: string;
  errorMessage?: string;
  isRetryable?: boolean;
}

export interface CloudflareDeleteResult {
  deleted: boolean;
  errorMessage?: string;
}

export interface CloudflareClient {
  validate(): Promise<CloudflareValidationResult>;
  createSubdomainCname(
    subdomain: string,
    targetHostname: string,
  ): Promise<CloudflareCnameResult>;
  deleteSubdomainCname(recordId: string): Promise<CloudflareDeleteResult>;
}

interface CloudflareError {
  code?: number;
  message?: string;
}

interface CloudflareResponse<T> {
  success?: boolean;
  errors?: CloudflareError[];
  result?: T;
}

interface CloudflareZone {
  id: string;
  name: string;
}

interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return `Cloudflare request exceeded ${TIMEOUT_MS}ms.`;
    }
    return `Network error contacting Cloudflare: ${err.message}`;
  }
  return "Unknown network error contacting Cloudflare.";
}

function firstCloudflareError(body: CloudflareResponse<unknown>): string | undefined {
  return body.errors?.[0]?.message ?? undefined;
}

async function validate(): Promise<CloudflareValidationResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) {
    return { valid: false, errorMessage: "Cloudflare env vars not configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        valid: false,
        errorMessage:
          "Cloudflare rejected the API token — verify it at dash.cloudflare.com/profile/api-tokens",
      };
    }
    if (res.status === 404) {
      return {
        valid: false,
        errorMessage:
          "Cloudflare zone not found — check CLOUDFLARE_ZONE_ID env var",
      };
    }
    if (!res.ok) {
      const body = (await res
        .json()
        .catch(() => ({}))) as CloudflareResponse<CloudflareZone>;
      return {
        valid: false,
        errorMessage:
          firstCloudflareError(body) ??
          `Cloudflare validation failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json()) as CloudflareResponse<CloudflareZone>;
    return { valid: true, zoneName: body.result?.name };
  } catch (err) {
    return { valid: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function createSubdomainCname(
  subdomain: string,
  targetHostname: string,
): Promise<CloudflareCnameResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const baseDomain = env.CLOUDFLARE_BASE_DOMAIN;
  if (!token || !zoneId || !baseDomain) {
    return {
      success: false,
      errorMessage: "Cloudflare env vars not configured",
      isRetryable: false,
    };
  }

  const recordName = `${subdomain}.${baseDomain}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOUDFLARE_API}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "CNAME",
        name: recordName,
        content: targetHostname,
        ttl: 3600,
        proxied: false,
        // Stamped on every record so the Cloudflare DNS dashboard shows where
        // these came from — accountability + easy debugging.
        comment: "Provisioned by AI Connect Project Genesis",
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      const body = (await res.json()) as CloudflareResponse<CloudflareDnsRecord>;
      return { success: true, recordId: body.result?.id };
    }

    const body = (await res
      .json()
      .catch(() => ({}))) as CloudflareResponse<CloudflareDnsRecord>;
    const providerMsg = firstCloudflareError(body);

    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        errorMessage: "Cloudflare auth failed",
        isRetryable: false,
      };
    }
    if (
      res.status === 400 &&
      providerMsg &&
      /already exists/i.test(providerMsg)
    ) {
      return {
        success: false,
        errorMessage: "Subdomain already in use",
        isRetryable: true,
      };
    }
    return {
      success: false,
      errorMessage: providerMsg ?? `Cloudflare returned HTTP ${res.status}.`,
      isRetryable: false,
    };
  } catch (err) {
    return {
      success: false,
      errorMessage: networkErrorMessage(err),
      isRetryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteSubdomainCname(
  recordId: string,
): Promise<CloudflareDeleteResult> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) {
    return {
      deleted: false,
      errorMessage: "Cloudflare env vars not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${CLOUDFLARE_API}/zones/${zoneId}/dns_records/${recordId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    // 200 = deleted, 404 = already gone (idempotent — fine for rollback).
    if (res.status === 200 || res.status === 404) {
      return { deleted: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { deleted: false, errorMessage: "Cloudflare auth failed" };
    }
    const body = (await res
      .json()
      .catch(() => ({}))) as CloudflareResponse<unknown>;
    return {
      deleted: false,
      errorMessage:
        firstCloudflareError(body) ??
        `Cloudflare returned HTTP ${res.status} on delete.`,
    };
  } catch (err) {
    return { deleted: false, errorMessage: networkErrorMessage(err) };
  } finally {
    clearTimeout(timeout);
  }
}

const cloudflareClient: CloudflareClient = {
  validate,
  createSubdomainCname,
  deleteSubdomainCname,
};

// Singleton — Cloudflare holds no per-user state, so one instance serves every
// genesis run.
export function getCloudflareClient(): CloudflareClient {
  return cloudflareClient;
}
