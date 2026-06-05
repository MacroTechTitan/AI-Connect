import type { Platform, ValidatedIdentity } from "../platforms/index.js";

// The seven provisioning steps the orchestrator walks in order. The order in
// this union is declaration order only — the executed order lives in
// GENESIS_STEPS (steps.ts). New steps slot in here and there together.
export type GenesisStepName =
  | "create_github_repo"
  | "create_vercel_project"
  | "create_render_service"
  | "create_supabase_project"
  | "wire_github_to_render"
  | "inject_env_vars"
  | "verify_deployment";

// The outcome a step hands back to the orchestrator. Steps never touch the DB
// or the events table — they return this, and the orchestrator translates it
// into a project_provisioning_events row. `details` is persisted as the event
// row's jsonb; `resourceId` (the created platform resource's id) is folded into
// that jsonb because the events table has no dedicated column for it.
//
// `platform` + `rollbackable` drive 5b rollback: when a later step fails, the
// orchestrator walks successful steps in reverse and deletes each one's
// `resourceId` via that `platform`'s client. `rollbackable` is false for steps
// that created nothing to undo (the wire/inject no-ops, the read-only verify).
export interface GenesisStepResult {
  status: "succeeded" | "failed";
  details?: Record<string, unknown>;
  errorMessage?: string;
  resourceId?: string;
  platform?: Platform;
  rollbackable?: boolean;
}

export interface GenesisStep {
  name: GenesisStepName;
  run: (ctx: GenesisContext) => Promise<GenesisStepResult>;
  resourceId?: string;
}

// Everything a step needs to do its work, assembled once at orchestrator start.
// `credentials` are the decrypted platform tokens — they live in this in-memory
// object only for the duration of the run and are never logged or persisted.
// `validated` carries the per-platform identity captured at the validation
// boundary (Render's ownerId, Supabase's organizationId). `results` accumulates
// each completed step's result so later steps can read earlier outputs (e.g.
// the Vercel/Render steps read the GitHub repo from create_github_repo).
export interface GenesisContext {
  projectId: string;
  userId: string;
  organizationId: string;
  name: string;
  slug: string;
  templateRepoUrl: string;
  credentials: {
    vercel: string;
    render: string;
    github: string;
    supabase: string;
  };
  validated: Record<Platform, ValidatedIdentity>;
  results: Partial<Record<GenesisStepName, GenesisStepResult>>;
}
