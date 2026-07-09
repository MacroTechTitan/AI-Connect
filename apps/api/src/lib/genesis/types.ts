import type { Platform, ValidatedIdentity } from "../platforms/index.js";

// The provisioning steps the orchestrator walks in order. The order in this
// union is declaration order only — the executed order lives in GENESIS_STEPS
// (steps.ts). New steps slot in here and there together.
export type GenesisStepName =
  | "create_github_repo"
  | "create_vercel_project"
  | "create_render_service"
  | "create_supabase_project"
  | "wire_github_to_render"
  | "inject_env_vars"
  | "verify_deployment"
  | "wire_auth0"
  | "wire_stripe";

// The three templates Project Genesis can scaffold from. Mirrors the
// projects.template_choice CHECK constraint.
export type TemplateChoice = "html-js" | "sveltekit" | "nextjs";

// Static AI-Connect-owned template repos, keyed by template choice, with the
// Render build/start config each template needs. Single source of truth for
// per-template metadata: the GitHub step generates a repo from {owner, repo},
// and the Render step reads {render.buildCommand, render.startCommand}. Adding a
// 4th template means adding one entry here and nothing else.
//
// All three are web_service with env "node" (carried in render.ts), use npm
// (not pnpm — these are standalone projects whose lockfiles are npm), and keep
// Sprint 4's region/plan defaults (oregon, starter).
export const TEMPLATE_REPOS: Record<
  TemplateChoice,
  {
    owner: string;
    repo: string;
    render: { buildCommand: string; startCommand: string };
  }
> = {
  "html-js": {
    owner: "MacroTechTitan",
    repo: "template-html-js",
    render: {
      buildCommand: "npm install",
      startCommand: "node server.js",
    },
  },
  sveltekit: {
    owner: "MacroTechTitan",
    repo: "template-sveltekit",
    render: {
      buildCommand: "npm install && npm run build",
      startCommand: "node build/index.js",
    },
  },
  nextjs: {
    owner: "MacroTechTitan",
    repo: "template-nextjs",
    render: {
      buildCommand: "npm install && npm run build",
      startCommand: "npm start",
    },
  },
} as const;

// The outcome a step hands back to the orchestrator. Steps never touch the DB
// or the events table — they return this, and the orchestrator translates it
// into a project_provisioning_events row. `details` is persisted as the event
// row's jsonb; `resourceId` (the created platform resource's id) is folded into
// that jsonb because the events table has no dedicated column for it.
//
// `platform` + `rollbackable` drive 5b rollback: when a later step fails, the
// orchestrator walks successful steps in reverse and deletes each one's
// `resourceId` via that `platform`'s client. `rollbackable` is false for steps
// that created nothing to undo (the read-only verify step).
//
// `platform` accepts "cloudflare" in addition to the user-supplied Platform
// union: the Sprint 5 DNS step records "cloudflare" so the rollback dispatcher
// routes it to the env-level Cloudflare client (not a PlatformClient). It is a
// dispatch/audit tag, not a Platform union value.
export interface GenesisStepResult {
  status: "succeeded" | "failed";
  details?: Record<string, unknown>;
  errorMessage?: string;
  resourceId?: string;
  platform?: Platform | "cloudflare";
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
  // The project creator's email, loaded at context assembly. Stripe Connect
  // requires an email to create an Express account (wire_stripe step).
  userEmail: string;
  templateRepoUrl: string;
  credentials: {
    vercel: string;
    render: string;
    github: string;
    supabase: string;
  };
  validated: Record<Platform, ValidatedIdentity>;
  results: Partial<Record<GenesisStepName, GenesisStepResult>>;

  // --- Sprint 5: populated as steps run -------------------------------------
  // Set at orchestrator start from project.template_choice. Undefined falls
  // back to Sprint 4's empty auto_init repo (legacy projects).
  templateChoice?: TemplateChoice;
  // Set after wire_github_to_render provisions the Cloudflare CNAME. Unused as
  // of Sprint 5.7 (DNS automation deferred); the step is now a no-op.
  subdomain?: string;
  subdomainCnameRecordId?: string;
  // Sprint 5.7: the project's live onrender.com URL, set at
  // create_render_service time and persisted to projects.deployed_url.
  deployedUrl?: string;
  // The Supabase Postgres connection string. In-memory only for the duration of
  // the run — never logged, never persisted as plaintext (only the Vault id is).
  databaseConnectionString?: string;
  // Persisted to projects.database_connection_string_vault_id.
  databaseConnectionStringVaultId?: string;
  // Render env vars have no per-id delete; we track the keys we set so rollback
  // can fetch-filter-put them back out.
  renderEnvVarKeys?: string[];
}
