import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import type { Express, Request, Response } from "express";

import { getDb } from "../db/client.js";
import {
  prompts,
  providerKeys,
  providerPricing,
} from "../db/schema.js";
import { logUserAction } from "../lib/logging.js";
import {
  assertOrgAccess,
  orgScopeFilter,
  type AuthedUserContext,
} from "../lib/orgScope.js";
import {
  getProviderClient,
  type Provider,
  type ProviderInvocationResult,
} from "../lib/providers/index.js";
import * as vault from "../lib/vault.js";
import {
  requireAuth,
  requireHydratedUser,
} from "../middleware/requireAuth.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_PROMPT_CHARS = 100_000;
const MAX_MAX_TOKENS = 32_000;

function isProvider(value: string): value is Provider {
  return value === "anthropic" || value === "openai" || value === "ollama";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// req.user is guaranteed by requireHydratedUser; this just narrows the type.
function getCtx(req: Request): AuthedUserContext {
  return req.user!;
}

interface PromptBody {
  prompt: string;
  providerKeyId?: string;
  model?: string;
  maxTokens?: number;
}

function parseBody(req: Request, res: Response): PromptBody | null {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const prompt = body.prompt;
  if (
    typeof prompt !== "string" ||
    prompt.length < 1 ||
    prompt.length > MAX_PROMPT_CHARS
  ) {
    res.status(400).json({ error: "invalid_prompt" });
    return null;
  }

  let providerKeyId: string | undefined;
  if (body.providerKeyId !== undefined && body.providerKeyId !== null) {
    if (
      typeof body.providerKeyId !== "string" ||
      !UUID_RE.test(body.providerKeyId)
    ) {
      res.status(400).json({ error: "invalid_provider_key_id" });
      return null;
    }
    providerKeyId = body.providerKeyId;
  }

  let model: string | undefined;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== "string" || body.model.length === 0) {
      res.status(400).json({ error: "invalid_model" });
      return null;
    }
    model = body.model;
  }

  let maxTokens: number | undefined;
  if (body.maxTokens !== undefined && body.maxTokens !== null) {
    if (
      typeof body.maxTokens !== "number" ||
      !Number.isInteger(body.maxTokens) ||
      body.maxTokens < 1 ||
      body.maxTokens > MAX_MAX_TOKENS
    ) {
      res.status(400).json({ error: "invalid_max_tokens" });
      return null;
    }
    maxTokens = body.maxTokens;
  }

  return { prompt, providerKeyId, model, maxTokens };
}

interface ResolvedKey {
  id: string;
  provider: Provider;
  vaultSecretId: string;
}

async function resolveProviderKey(
  ctx: AuthedUserContext,
  providerKeyId: string | undefined,
  res: Response,
): Promise<ResolvedKey | null> {
  const db = getDb();
  const { userId } = ctx;

  if (providerKeyId) {
    const [row] = await db
      .select({
        id: providerKeys.id,
        provider: providerKeys.provider,
        organizationId: providerKeys.organizationId,
        vaultSecretId: providerKeys.vaultSecretId,
      })
      .from(providerKeys)
      .where(
        and(
          orgScopeFilter(providerKeys, ctx),
          eq(providerKeys.id, providerKeyId),
          eq(providerKeys.userId, userId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "key_not_found" });
      return null;
    }
    // Defense in depth — the SELECT above is already org-scoped, but this
    // catches the degenerate case where a future change drops the scope.
    assertOrgAccess(row.organizationId, ctx);
    if (!isProvider(row.provider)) {
      res.status(500).json({
        error: "internal_error",
        reason: "invalid_provider_in_db",
      });
      return null;
    }
    return {
      id: row.id,
      provider: row.provider,
      vaultSecretId: row.vaultSecretId,
    };
  }

  const [row] = await db
    .select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      organizationId: providerKeys.organizationId,
      vaultSecretId: providerKeys.vaultSecretId,
    })
    .from(providerKeys)
    .where(
      and(
        orgScopeFilter(providerKeys, ctx),
        eq(providerKeys.userId, userId),
        eq(providerKeys.isDefault, true),
      ),
    )
    .orderBy(desc(providerKeys.createdAt))
    .limit(1);
  if (!row) {
    res.status(400).json({
      error: "no_provider_key",
      reason: "User has no provider keys configured",
    });
    return null;
  }
  assertOrgAccess(row.organizationId, ctx);
  if (!isProvider(row.provider)) {
    res.status(500).json({
      error: "internal_error",
      reason: "invalid_provider_in_db",
    });
    return null;
  }
  return {
    id: row.id,
    provider: row.provider,
    vaultSecretId: row.vaultSecretId,
  };
}

async function resolveModel(
  provider: Provider,
  bodyModel: string | undefined,
): Promise<string | null> {
  if (bodyModel) return bodyModel;
  const [row] = await getDb()
    .select({ model: providerPricing.model })
    .from(providerPricing)
    .where(
      and(
        eq(providerPricing.provider, provider),
        eq(providerPricing.isDefault, true),
        eq(providerPricing.isActive, true),
      ),
    )
    .limit(1);
  return row?.model ?? null;
}

interface Pricing {
  inputPer1m: number;
  outputPer1m: number;
}

async function lookupPricing(
  provider: Provider,
  model: string,
): Promise<Pricing | null> {
  const [row] = await getDb()
    .select({
      input: providerPricing.inputPer1mTokensUsd,
      output: providerPricing.outputPer1mTokensUsd,
    })
    .from(providerPricing)
    .where(
      and(
        eq(providerPricing.provider, provider),
        eq(providerPricing.model, model),
        eq(providerPricing.isActive, true),
      ),
    )
    .orderBy(desc(providerPricing.effectiveFrom))
    .limit(1);
  if (!row) return null;
  return {
    inputPer1m: Number(row.input),
    outputPer1m: Number(row.output),
  };
}

// numeric(10,6) — return as a fixed-decimal string to avoid float drift.
function computeCost(
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Pricing | null,
): string | null {
  if (!pricing) return null;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return null;
  }
  const cost =
    (inputTokens / 1_000_000) * pricing.inputPer1m +
    (outputTokens / 1_000_000) * pricing.outputPer1m;
  return cost.toFixed(6);
}

async function recordSuccessAndUpdateKey(args: {
  ctx: AuthedUserContext;
  providerKeyId: string;
  provider: Provider;
  model: string;
  promptText: string;
  result: Extract<ProviderInvocationResult, { status: "success" }>;
  pricing: Pricing | null;
}): Promise<{ promptId: string; estimatedCostUsd: string | null }> {
  const {
    ctx,
    providerKeyId,
    provider,
    model,
    promptText,
    result,
    pricing,
  } = args;
  const { userId, organizationId } = ctx;

  const estimatedCostUsd = computeCost(
    result.inputTokens,
    result.outputTokens,
    pricing,
  );

  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(prompts)
      .values({
        userId,
        organizationId,
        providerKeyId,
        provider,
        model,
        promptTextFingerprint: sha256Hex(promptText),
        promptTextLength: promptText.length,
        responseTextFingerprint: sha256Hex(result.responseText),
        responseTextLength: result.responseText.length,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd,
        latencyMs: result.latencyMs,
        status: "success",
      })
      .returning({ id: prompts.id });
    if (!row) {
      throw new Error("prompts insert returned no row");
    }
    const now = new Date();
    await tx
      .update(providerKeys)
      .set({ lastUsedAt: now, lastValidatedAt: now })
      .where(
        and(
          orgScopeFilter(providerKeys, ctx),
          eq(providerKeys.id, providerKeyId),
        ),
      );
    return { promptId: row.id, estimatedCostUsd };
  });
}

async function recordErrorAndUpdateKey(args: {
  ctx: AuthedUserContext;
  providerKeyId: string;
  provider: Provider;
  model: string;
  promptText: string;
  result: Extract<ProviderInvocationResult, { status: "error" | "timeout" }>;
}): Promise<{ promptId: string }> {
  const { ctx, providerKeyId, provider, model, promptText, result } = args;
  const { userId, organizationId } = ctx;

  const db = getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(prompts)
      .values({
        userId,
        organizationId,
        providerKeyId,
        provider,
        model,
        promptTextFingerprint: sha256Hex(promptText),
        promptTextLength: promptText.length,
        latencyMs: result.latencyMs,
        status: result.status,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      })
      .returning({ id: prompts.id });
    if (!row) {
      throw new Error("prompts insert returned no row");
    }
    await tx
      .update(providerKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          orgScopeFilter(providerKeys, ctx),
          eq(providerKeys.id, providerKeyId),
        ),
      );
    return { promptId: row.id };
  });
}

async function handlePrompt(req: Request, res: Response): Promise<void> {
  const ctx = getCtx(req);
  const { userId } = ctx;

  const body = parseBody(req, res);
  if (!body) return;

  const providerKey = await resolveProviderKey(ctx, body.providerKeyId, res);
  if (!providerKey) return;

  const model = await resolveModel(providerKey.provider, body.model);
  if (!model) {
    res.status(500).json({
      error: "no_default_model",
      reason: `No default model configured for provider ${providerKey.provider}`,
    });
    return;
  }

  const pricing = await lookupPricing(providerKey.provider, model);
  const apiKey = await vault.getSecret(providerKey.vaultSecretId);

  const result = await getProviderClient(providerKey.provider).invoke({
    provider: providerKey.provider,
    model,
    apiKey,
    prompt: body.prompt,
    maxTokens: body.maxTokens,
  });

  if (result.status === "success") {
    const { promptId, estimatedCostUsd } = await recordSuccessAndUpdateKey({
      ctx,
      providerKeyId: providerKey.id,
      provider: providerKey.provider,
      model,
      promptText: body.prompt,
      result,
      pricing,
    });

    await logUserAction(userId, "invoke_prompt", "prompt", promptId, {
      provider: providerKey.provider,
      model,
      status: "success",
      cost: estimatedCostUsd,
    });

    res.status(200).json({
      response: result.responseText,
      provider: providerKey.provider,
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd:
        estimatedCostUsd === null ? null : Number(estimatedCostUsd),
      latencyMs: result.latencyMs,
      promptId,
    });
    return;
  }

  const { promptId } = await recordErrorAndUpdateKey({
    ctx,
    providerKeyId: providerKey.id,
    provider: providerKey.provider,
    model,
    promptText: body.prompt,
    result,
  });

  await logUserAction(userId, "invoke_prompt", "prompt", promptId, {
    provider: providerKey.provider,
    model,
    status: result.status,
    errorCode: result.errorCode,
  });

  res.status(502).json({
    error: "provider_error",
    providerErrorCode: result.errorCode,
    providerErrorMessage: result.errorMessage,
    latencyMs: result.latencyMs,
    promptId,
  });
}

export function registerPromptRoutes(app: Express): void {
  app.post("/api/prompt", requireAuth, requireHydratedUser, handlePrompt);
}
