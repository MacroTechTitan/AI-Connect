import { useAuth0 } from "@auth0/auth0-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { OpenClawWizard } from "./components/OpenClawWizard";
import { SessionExpiredNotice } from "./components/SessionExpiredNotice";
import { WordPressModuleManager } from "./components/WordPressModuleManager";
import { WordPressWizard } from "./components/WordPressWizard";
import {
  API_BASE,
  authedFetch,
  isSessionExpired,
  type GetAccessToken,
} from "./lib/api";

type HealthStatus = "pending" | "ok" | "down";
type Provider = "anthropic" | "openai" | "ollama";
type Platform = "vercel" | "render" | "github" | "supabase";

const HEALTH_URL = "https://api.aiconnect.macrotechtitan.com/health";
const CHANGELOG_URL =
  "https://github.com/MacroTechTitan/AI-Connect/blob/master/CHANGELOG.md";

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  ollama: "Ollama",
};

const KEY_PLACEHOLDER: Record<Provider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  ollama: "http://localhost:11434",
};

const PLATFORM_LABEL: Record<Platform, string> = {
  vercel: "Vercel",
  render: "Render",
  github: "GitHub",
  supabase: "Supabase",
};

const PLATFORM_LABEL_PLACEHOLDER: Record<Platform, string> = {
  vercel: "e.g. Personal Vercel",
  render: "e.g. Personal Render",
  github: "e.g. Personal GitHub",
  supabase: "e.g. Personal Supabase",
};

const PLATFORM_TOKEN_PLACEHOLDER: Record<Platform, string> = {
  vercel: "Personal access token from vercel.com/account/tokens",
  github:
    "Personal access token (classic) with repo + delete_repo + admin:repo_hook scopes",
  render: "API key from render.com/u/settings#api-keys",
  supabase:
    "Personal access token from supabase.com/dashboard/account/tokens",
};

// The native EventSource API can't send an Authorization header, so we can't
// use it without leaking the JWT into the URL (and server access logs). Instead
// we open the SSE endpoint with authedFetch, read the response body as a
// stream, and parse the wire format by hand — preserving the Sprint 1
// bearer-token model. onEvent fires once per complete `event:/data:` block;
// `: ping` heartbeat comment lines are ignored. Resolves when the stream ends
// or the AbortSignal fires.
async function streamSse(
  path: string,
  getAccessTokenSilently: GetAccessToken,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await authedFetch(
    path,
    { headers: { Accept: "text/event-stream" }, signal },
    getAccessTokenSilently,
  );
  if (!res.ok || !res.body) {
    throw new Error(`sse_failed_${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushBlock = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue; // blank / heartbeat
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length > 0) onEvent(event, dataLines.join("\n"));
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalize CRLF so the \n\n block split works regardless of proxy.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        flushBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return "—";
  return `$${cost.toFixed(4)}`;
}

interface CredentialIdentity {
  name?: string;
  email?: string;
}

interface PlatformCredentialRow {
  id: string;
  platform: Platform;
  label: string;
  created_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
}

// Friendly relative-time formatter for "Last validated: 5 minutes ago".
// Keeps the UI text-driven without pulling in a date library.
function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

function describeIdentity(
  identity: CredentialIdentity | undefined,
): string | null {
  if (!identity) return null;
  const { name, email } = identity;
  if (name && email) return `as ${name} (${email})`;
  if (name) return `as ${name}`;
  if (email) return `as ${email}`;
  return null;
}

function PlatformCredentialsPanel({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [credentials, setCredentials] = useState<
    PlatformCredentialRow[] | null
  >(null);
  // Identity is returned by POST but not by GET (Sprint 4 only persists the
  // metadata; identity may move to the DB in a later sprint). We keep a
  // per-session map keyed by credential id so freshly-added rows show
  // identity confirmation until reload.
  const [identities, setIdentities] = useState<
    Record<string, CredentialIdentity>
  >({});
  const [listError, setListError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [addPlatform, setAddPlatform] = useState<Platform>("github");
  const [addLabel, setAddLabel] = useState("");
  const [addCredential, setAddCredential] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    setCredentials(null);
    try {
      const res = await authedFetch(
        "/api/platform-credentials",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't load connections.",
        );
        setCredentials([]);
        return;
      }
      const body = (await res.json()) as {
        credentials?: PlatformCredentialRow[];
      };
      setCredentials(body.credentials ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setCredentials([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      const res = await authedFetch(
        "/api/platform-credentials",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: addPlatform,
            label: addLabel,
            credential: addCredential,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg =
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Please check your input.";
        try {
          const body = (await res.json()) as {
            error?: string;
            reason?: string;
          };
          if (body?.error === "credential_invalid") {
            // Surface the platform's own error message — the whole point of
            // server-side validation at registration time.
            msg =
              body.reason ??
              `${PLATFORM_LABEL[addPlatform]} rejected the token.`;
          } else if (body?.reason) {
            msg = body.reason;
          } else if (body?.error) {
            msg = body.error;
          }
        } catch {
          // body wasn't JSON; keep the status-derived message
        }
        setAddError(msg);
        return;
      }
      const body = (await res.json()) as PlatformCredentialRow & {
        identity?: CredentialIdentity;
      };
      if (body.identity) {
        const newIdentity = body.identity;
        setIdentities((prev) => ({ ...prev, [body.id]: newIdentity }));
      }
      setAddLabel("");
      setAddCredential("");
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAddError("Couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await authedFetch(
        `/api/platform-credentials/${id}`,
        { method: "DELETE" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't remove that connection.",
        );
        return;
      }
      setIdentities((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Hosting connections</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Hosting connections</h3>
      <p className="muted">
        Connect your hosting platforms so AI Connect can provision new
        projects on your behalf.
      </p>
      {credentials === null && !listError ? (
        <p className="muted">Loading…</p>
      ) : null}
      {listError ? <p className="error">{listError}</p> : null}
      {credentials && credentials.length === 0 && !listError ? (
        <p className="muted">No hosting connections yet. Add one below.</p>
      ) : null}
      {credentials && credentials.length > 0 ? (
        <ul className="credentials-list">
          {credentials.map((c) => {
            const identity = describeIdentity(identities[c.id]);
            return (
              <li key={c.id} className="credential-row">
                <div className="credential-info">
                  <div className="credential-main">
                    <span className="credential-platform">
                      {PLATFORM_LABEL[c.platform]}
                    </span>
                    <span className="credential-label">{c.label}</span>
                    {identity ? (
                      <span className="credential-identity">{identity}</span>
                    ) : null}
                  </div>
                  <div className="credential-meta">
                    Last validated: {formatRelativeTime(c.last_validated_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void handleDelete(c.id)}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <form
        className="add-credential-form"
        onSubmit={(e) => void handleAdd(e)}
      >
        <div className="row">
          <select
            value={addPlatform}
            onChange={(e) => setAddPlatform(e.target.value as Platform)}
          >
            <option value="vercel">Vercel</option>
            <option value="render">Render</option>
            <option value="github">GitHub</option>
            <option value="supabase">Supabase</option>
          </select>
          <input
            className="label-input"
            type="text"
            placeholder={PLATFORM_LABEL_PLACEHOLDER[addPlatform]}
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            maxLength={100}
            required
          />
        </div>
        <input
          className="credential-input"
          type="password"
          placeholder={PLATFORM_TOKEN_PLACEHOLDER[addPlatform]}
          value={addCredential}
          onChange={(e) => setAddCredential(e.target.value)}
          maxLength={1000}
          required
        />
        <button type="submit" className="btn-primary" disabled={adding}>
          {adding ? "Adding…" : "Add connection"}
        </button>
        {addError ? <p className="error">{addError}</p> : null}
      </form>
    </div>
  );
}

interface KeyRow {
  id: string;
  provider: Provider;
  label: string;
  is_default: boolean;
  created_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
}

function KeysPanel({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [addProvider, setAddProvider] = useState<Provider>("anthropic");
  const [addLabel, setAddLabel] = useState("");
  const [addKey, setAddKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    setKeys(null);
    try {
      const res = await authedFetch(
        "/api/keys",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't load keys.",
        );
        setKeys([]);
        return;
      }
      const body = (await res.json()) as { keys?: KeyRow[] };
      setKeys(body.keys ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setKeys([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      const res = await authedFetch(
        "/api/keys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: addProvider,
            label: addLabel,
            key: addKey,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg =
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Please check your input.";
        try {
          const body = (await res.json()) as {
            reason?: string;
            error?: string;
          };
          if (body?.reason) msg = body.reason;
          else if (body?.error) msg = body.error;
        } catch {
          // body wasn't JSON; keep the status-derived message
        }
        setAddError(msg);
        return;
      }
      setAddLabel("");
      setAddKey("");
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAddError("Couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await authedFetch(
        `/api/keys/${id}`,
        { method: "DELETE" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't delete that key.",
        );
        return;
      }
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Provider keys</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Provider keys</h3>
      {keys === null && !listError ? (
        <p className="muted">Loading…</p>
      ) : null}
      {listError ? <p className="error">{listError}</p> : null}
      {keys && keys.length === 0 && !listError ? (
        <p className="muted">No keys yet. Add one below.</p>
      ) : null}
      {keys && keys.length > 0 ? (
        <ul className="keys-list">
          {keys.map((k) => (
            <li key={k.id} className="key-row">
              <span className="key-meta">
                <span className="key-provider">
                  {PROVIDER_LABEL[k.provider]}
                </span>
                <span className="key-label">{k.label}</span>
                {k.is_default ? (
                  <span className="default-badge">default</span>
                ) : null}
              </span>
              <button
                type="button"
                className="btn-danger"
                onClick={() => void handleDelete(k.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="add-key-form" onSubmit={(e) => void handleAdd(e)}>
        <div className="row">
          <select
            value={addProvider}
            onChange={(e) => setAddProvider(e.target.value as Provider)}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama</option>
          </select>
          <input
            className="label-input"
            type="text"
            placeholder="e.g. My personal Claude key"
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
            maxLength={100}
            required
          />
          <input
            className="key-input"
            type="password"
            placeholder={KEY_PLACEHOLDER[addProvider]}
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn-primary" disabled={adding}>
          {adding ? "Adding…" : "Add key"}
        </button>
        {addError ? <p className="error">{addError}</p> : null}
      </form>
    </div>
  );
}

type IntegrationType =
  | "sendgrid"
  | "openai"
  | "anthropic"
  | "wordpress"
  | "openclaw";

const INTEGRATION_LABEL: Record<IntegrationType, string> = {
  sendgrid: "SendGrid",
  openai: "OpenAI",
  anthropic: "Anthropic",
  wordpress: "WordPress",
  openclaw: "OpenClaw",
};

interface Integration {
  id: string;
  integration_type: IntegrationType;
  config: Record<string, unknown>;
  include_in_projects: boolean;
  status: "pending" | "validated" | "failed";
  last_validated_at: string | null;
  validation_error: string | null;
  identity?: Record<string, unknown>;
  created_at: string;
}

// Human-readable identity line per type. openai/anthropic resolve the linked
// provider_keys label (config.provider_key_id → keysById); freshly-added rows
// fall back to the identity the POST returned. wordpress shows its site_url
// (in config); sendgrid shows the account type the validator surfaced (POST
// only — GET doesn't re-ping SendGrid).
function describeIntegrationIdentity(
  c: Integration,
  keysById: Record<string, KeyRow>,
  sessionIdentity: Record<string, unknown> | undefined,
): string | null {
  switch (c.integration_type) {
    case "openai":
    case "anthropic": {
      const pkId =
        typeof c.config.provider_key_id === "string"
          ? c.config.provider_key_id
          : null;
      const fromKeys = pkId ? keysById[pkId]?.label : undefined;
      const fromSession =
        sessionIdentity && typeof sessionIdentity.label === "string"
          ? sessionIdentity.label
          : undefined;
      const shown = fromKeys ?? fromSession;
      if (shown) return `${INTEGRATION_LABEL[c.integration_type]} key: ${shown}`;
      if (pkId) return `${INTEGRATION_LABEL[c.integration_type]} key (unavailable)`;
      return null;
    }
    case "sendgrid": {
      const type =
        sessionIdentity && typeof sessionIdentity.type === "string"
          ? sessionIdentity.type
          : undefined;
      return type ? `Account: ${type}` : null;
    }
    case "wordpress": {
      const url =
        typeof c.config.site_url === "string" ? c.config.site_url : null;
      return url ? `Site: ${url}` : null;
    }
    case "openclaw": {
      const agent =
        typeof c.config.default_agent === "string"
          ? c.config.default_agent
          : null;
      return agent ? `Default agent: ${agent}` : null;
    }
  }
}

function IntegrationsPanel({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  // Provider keys, loaded for the openai/anthropic dropdowns and to resolve
  // linked-key labels in the list.
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  // Identity is returned by POST but not by GET (SendGrid's account type in
  // particular). Keep a per-session map keyed by integration id so freshly
  // added rows show identity confirmation until reload.
  const [identities, setIdentities] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [listError, setListError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [addType, setAddType] = useState<IntegrationType>("sendgrid");
  const [addSendgridKey, setAddSendgridKey] = useState("");
  const [addProviderKeyId, setAddProviderKeyId] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // WordPress uses a guided wizard for first connection and a separate module
  // manager afterward, rather than the inline credential form the other types
  // use.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [moduleManager, setModuleManager] = useState<{
    integrationId: string;
    siteUrl: string;
  } | null>(null);

  // OpenClaw also uses a guided wizard. It's local-only: the OpenClaw option is
  // disabled when the API reports cloud mode. null = not yet known.
  const [openclawWizardOpen, setOpenclawWizardOpen] = useState(false);
  const [localMode, setLocalMode] = useState<boolean | null>(null);

  // /health is auth-free and DB-free; read local_mode from the same API the
  // rest of the panel talks to (API_BASE), not the hardcoded prod health URL.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/health`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("no"))))
      .then((body: { local_mode?: boolean }) => {
        if (!cancelled) setLocalMode(Boolean(body.local_mode));
      })
      .catch(() => {
        // Assume cloud mode if we can't tell — fail safe toward "disabled".
        if (!cancelled) setLocalMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setListError(null);
    setIntegrations(null);
    try {
      const [intRes, keysRes] = await Promise.all([
        authedFetch("/api/integrations", {}, getAccessTokenSilently),
        authedFetch("/api/keys", {}, getAccessTokenSilently),
      ]);
      if (!intRes.ok) {
        setListError(
          intRes.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't load integrations.",
        );
        setIntegrations([]);
        return;
      }
      const body = (await intRes.json()) as { integrations?: Integration[] };
      setIntegrations(body.integrations ?? []);
      // Keys are best-effort — the dropdowns degrade to "add a key first"
      // guidance if this fails, so don't block the integrations list on it.
      if (keysRes.ok) {
        const keysBody = (await keysRes.json()) as { keys?: KeyRow[] };
        setKeys(keysBody.keys ?? []);
      } else {
        setKeys([]);
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setIntegrations([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const keysById = useMemo(() => {
    const map: Record<string, KeyRow> = {};
    for (const k of keys ?? []) map[k.id] = k;
    return map;
  }, [keys]);

  // Provider keys matching the selected integration type (openai/anthropic).
  const matchingKeys = useMemo(() => {
    if (addType !== "openai" && addType !== "anthropic") return [];
    return (keys ?? []).filter((k) => k.provider === addType);
  }, [keys, addType]);

  // Keep the selected provider key valid as the type (and thus the matching
  // set) changes — default to the first match, or clear if none.
  useEffect(() => {
    if (addType !== "openai" && addType !== "anthropic") return;
    setAddProviderKeyId((cur) =>
      matchingKeys.some((k) => k.id === cur)
        ? cur
        : (matchingKeys[0]?.id ?? ""),
    );
  }, [addType, matchingKeys]);

  const needsProviderKey = addType === "openai" || addType === "anthropic";
  const noMatchingKey = needsProviderKey && matchingKeys.length === 0;

  // WordPress is excluded — it connects through the wizard, not this form.
  let canSubmit = false;
  if (addType === "sendgrid") canSubmit = addSendgridKey.length > 0;
  else if (needsProviderKey) canSubmit = addProviderKeyId.length > 0;

  function resetForm() {
    setAddSendgridKey("");
    // addProviderKeyId is managed by the matchingKeys effect.
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      let payload: Record<string, unknown>;
      if (addType === "sendgrid") {
        payload = {
          integration_type: "sendgrid",
          credential: addSendgridKey,
          config: {},
        };
      } else {
        // needsProviderKey (openai/anthropic) — wordpress never reaches here.
        payload = {
          integration_type: addType,
          config: { provider_key_id: addProviderKeyId },
        };
      }

      const res = await authedFetch(
        "/api/integrations",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        getAccessTokenSilently,
      );

      if (res.status === 409) {
        setAddError(
          `You already have a ${INTEGRATION_LABEL[addType]} integration. Remove it first to add another.`,
        );
        return;
      }

      if (!res.ok) {
        let msg =
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Please check your input.";
        try {
          const body = (await res.json()) as {
            error?: string;
            reason?: string;
          };
          // Surface the validator's own message verbatim (e.g. the SendGrid
          // 401/403 copy) — that's the point of validating at add time.
          if (body?.reason) msg = body.reason;
          else if (body?.error) msg = body.error;
        } catch {
          // body wasn't JSON; keep the status-derived message
        }
        setAddError(msg);
        return;
      }

      const body = (await res.json()) as Integration & {
        identity?: Record<string, unknown>;
      };
      if (body.identity) {
        const newIdentity = body.identity;
        setIdentities((prev) => ({ ...prev, [body.id]: newIdentity }));
      }
      resetForm();
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAddError("Couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(c: Integration) {
    const previous = c.include_in_projects;
    const next = !previous;
    setListError(null);
    // Optimistic — flip immediately, roll back if the PATCH fails.
    setIntegrations((prev) =>
      prev
        ? prev.map((i) =>
            i.id === c.id ? { ...i, include_in_projects: next } : i,
          )
        : prev,
    );
    const rollback = () =>
      setIntegrations((prev) =>
        prev
          ? prev.map((i) =>
              i.id === c.id ? { ...i, include_in_projects: previous } : i,
            )
          : prev,
      );
    try {
      const res = await authedFetch(
        `/api/integrations/${c.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ include_in_projects: next }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        rollback();
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't update that integration.",
        );
      }
    } catch (err) {
      rollback();
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  async function handleDelete(c: Integration) {
    if (
      !window.confirm(
        `Remove the ${INTEGRATION_LABEL[c.integration_type]} integration?`,
      )
    ) {
      return;
    }
    try {
      const res = await authedFetch(
        `/api/integrations/${c.id}`,
        { method: "DELETE" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't remove that integration.",
        );
        return;
      }
      setIdentities((prev) => {
        const copy = { ...prev };
        delete copy[c.id];
        return copy;
      });
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Integrations</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Integrations</h3>
      <p className="muted">
        Connect external services (email, AI providers, WordPress) so AI
        Connect can wire them into projects it provisions for you.
      </p>
      {integrations === null && !listError ? (
        <p className="muted">Loading…</p>
      ) : null}
      {listError ? <p className="error">{listError}</p> : null}
      {integrations && integrations.length === 0 && !listError ? (
        <p className="muted">No integrations yet. Add one below.</p>
      ) : null}
      {integrations && integrations.length > 0 ? (
        <ul className="integrations-list">
          {integrations.map((c) => {
            const identity = describeIntegrationIdentity(
              c,
              keysById,
              identities[c.id],
            );
            return (
              <li key={c.id} className="integration-row">
                <div className="integration-info">
                  <div className="integration-main">
                    <span className="integration-type">
                      {INTEGRATION_LABEL[c.integration_type]}
                    </span>
                    {identity ? (
                      <span className="integration-identity">{identity}</span>
                    ) : null}
                    {c.status === "failed" ? (
                      <span className="badge-error">failed</span>
                    ) : null}
                  </div>
                  <div className="integration-meta">
                    Last validated: {formatRelativeTime(c.last_validated_at)}
                  </div>
                  {c.validation_error ? (
                    <div className="error">{c.validation_error}</div>
                  ) : null}
                </div>
                <div className="integration-actions">
                  <label className="integration-toggle">
                    <input
                      type="checkbox"
                      checked={c.include_in_projects}
                      onChange={() => void handleToggle(c)}
                    />
                    <span>Include in new projects</span>
                  </label>
                  {c.integration_type === "wordpress" &&
                  typeof c.config.site_url === "string" ? (
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() =>
                        setModuleManager({
                          integrationId: c.id,
                          siteUrl: c.config.site_url as string,
                        })
                      }
                    >
                      Manage Modules
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void handleDelete(c)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <form
        className="add-integration-form"
        onSubmit={(e) => void handleAdd(e)}
      >
        <div className="row">
          <select
            value={addType}
            onChange={(e) => {
              setAddType(e.target.value as IntegrationType);
              setAddError(null);
            }}
          >
            <option value="sendgrid">SendGrid</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="wordpress">WordPress</option>
            <option
              value="openclaw"
              disabled={localMode === false}
              title={
                localMode === false
                  ? "OpenClaw integrations require AI Connect running locally. See LOCAL_MODE.md."
                  : undefined
              }
            >
              OpenClaw{localMode === false ? " (local only)" : ""}
            </option>
          </select>
        </div>

        {addType === "sendgrid" ? (
          <input
            className="credential-input"
            type="password"
            placeholder="SendGrid API key (SG.…)"
            value={addSendgridKey}
            onChange={(e) => setAddSendgridKey(e.target.value)}
            maxLength={1000}
            required
          />
        ) : null}

        {needsProviderKey ? (
          noMatchingKey ? (
            <p className="muted">
              Add an {INTEGRATION_LABEL[addType]} key in “Provider keys” first.
            </p>
          ) : (
            <select
              value={addProviderKeyId}
              onChange={(e) => setAddProviderKeyId(e.target.value)}
            >
              {matchingKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                  {k.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          )
        ) : null}

        {addType === "wordpress" ? (
          <>
            <p className="muted">
              Connecting WordPress installs a plugin on your site. The wizard
              walks you through it — about 2 minutes.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setWizardOpen(true)}
            >
              Connect WordPress Site
            </button>
          </>
        ) : addType === "openclaw" ? (
          <>
            <p className="muted">
              Connecting OpenClaw lets AI Connect talk to a local agent through
              the maximus-bridge. The wizard walks you through it — local mode
              only.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => setOpenclawWizardOpen(true)}
            >
              Connect OpenClaw
            </button>
          </>
        ) : (
          <button
            type="submit"
            className="btn-primary"
            disabled={adding || !canSubmit}
          >
            {adding ? "Adding…" : "Add integration"}
          </button>
        )}
        {addError ? <p className="error">{addError}</p> : null}
      </form>

      {wizardOpen ? (
        <WordPressWizard
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setWizardOpen(false)}
          onConnected={() => void refresh()}
          onManageModules={(integrationId, siteUrl) => {
            setWizardOpen(false);
            setModuleManager({ integrationId, siteUrl });
          }}
        />
      ) : null}

      {openclawWizardOpen ? (
        <OpenClawWizard
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setOpenclawWizardOpen(false)}
          onConnected={() => void refresh()}
          onManageAgents={() => {
            // The agent manager arrives in Sprint 7 Commit 7. Until then,
            // "Manage Agents" just closes the wizard and refreshes the list.
            setOpenclawWizardOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {moduleManager ? (
        <WordPressModuleManager
          getAccessTokenSilently={getAccessTokenSilently}
          integrationId={moduleManager.integrationId}
          siteUrl={moduleManager.siteUrl}
          onClose={() => setModuleManager(null)}
        />
      ) : null}
    </div>
  );
}

type ProvisioningState =
  | "not_started"
  | "provisioning"
  | "provisioned"
  | "failed"
  | "rolled_back";

const PROVISIONING_BADGE: Record<
  ProvisioningState,
  { label: string; cls: string }
> = {
  not_started: { label: "Not provisioned", cls: "badge-muted" },
  provisioning: { label: "Provisioning…", cls: "badge-active" },
  provisioned: { label: "Provisioned", cls: "badge-success" },
  failed: { label: "Failed", cls: "badge-error" },
  rolled_back: { label: "Rolled back", cls: "badge-muted" },
};

// Provision is offered only from terminal-but-retryable states.
const PROVISIONABLE = new Set<string>(["not_started", "failed", "rolled_back"]);

function badgeFor(state: string): { label: string; cls: string } {
  return (
    PROVISIONING_BADGE[state as ProvisioningState] ?? {
      label: state,
      cls: "badge-muted",
    }
  );
}

interface ProvisioningEvent {
  id: string;
  project_id: string;
  step_name: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  details: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
}

const STEP_LABEL: Record<string, string> = {
  create_github_repo: "Create GitHub repo",
  create_supabase_project: "Create Supabase project",
  create_vercel_project: "Create Vercel project",
  create_render_service: "Create Render service",
  wire_github_to_render: "Wire GitHub to Render",
  inject_env_vars: "Inject env vars",
  verify_deployment: "Verify deployment",
  validate_credentials: "Validate credentials",
  rollback_summary: "Rollback summary",
  orchestrator: "Orchestrator",
};

function humanizeStep(stepName: string): string {
  if (stepName.startsWith("rollback:")) {
    return `Roll back: ${humanizeStep(stepName.slice("rollback:".length))}`;
  }
  const known = STEP_LABEL[stepName];
  if (known) return known;
  return (
    stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ")
  );
}

const STATUS_ICON: Record<
  string,
  { icon: string; cls: string; spin?: boolean }
> = {
  pending: { icon: "○", cls: "step-pending" },
  in_progress: { icon: "◐", cls: "step-active", spin: true },
  succeeded: { icon: "●", cls: "step-success" },
  failed: { icon: "●", cls: "step-error" },
  failed_to_rollback: { icon: "●", cls: "step-warn" },
  rolled_back: { icon: "●", cls: "step-muted" },
};

function formatElapsed(
  startedAt: string | null,
  completedAt: string | null,
  nowTs: number,
): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = completedAt ? new Date(completedAt).getTime() : nowTs;
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Pick the human-useful bits out of an event's details jsonb: links to created
// resources, the manual-cleanup link on a failed rollback, and free-text notes.
function detailItems(
  details: Record<string, unknown> | null,
): Array<{ key: string; text: string; href?: string }> {
  if (!details) return [];
  const items: Array<{ key: string; text: string; href?: string }> = [];
  const urlKeys: Array<[string, string]> = [
    ["url", "URL"],
    ["production_url", "Production"],
    ["html_url", "Repo"],
    ["dashboard_url", "Dashboard"],
    ["api_url", "API"],
    ["manual_cleanup_url", "Manual cleanup"],
  ];
  for (const [key, label] of urlKeys) {
    const value = details[key];
    if (typeof value === "string" && value.startsWith("http")) {
      items.push({ key, text: label, href: value });
    }
  }
  if (typeof details.note === "string") {
    items.push({ key: "note", text: details.note });
  }
  if (typeof details.message === "string") {
    items.push({ key: "message", text: details.message });
  }
  return items;
}

// Subscribes to the genesis SSE stream and renders each step as it lands.
// Mounts when the user provisions a project (or re-opens an in-flight run).
function GenesisProgress({
  projectId,
  getAccessTokenSilently,
  onComplete,
}: {
  projectId: string;
  getAccessTokenSilently: GetAccessToken;
  onComplete: (finalState: string) => void;
}) {
  const [events, setEvents] = useState<Map<string, ProvisioningEvent>>(
    () => new Map(),
  );
  const [streamError, setStreamError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [finalState, setFinalState] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Keep the latest onComplete without making it an effect dependency (which
  // would tear down and re-open the stream on every parent render).
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const controller = new AbortController();
    let done = false;
    void (async () => {
      try {
        await streamSse(
          `/api/projects/${projectId}/provisioning-events`,
          getAccessTokenSilently,
          (event, data) => {
            if (event === "provisioning_event") {
              let parsed: ProvisioningEvent;
              try {
                parsed = JSON.parse(data) as ProvisioningEvent;
              } catch {
                return;
              }
              setEvents((prev) => {
                const next = new Map(prev);
                next.set(parsed.id, parsed);
                return next;
              });
            } else if (event === "done") {
              done = true;
              let fs = "";
              try {
                fs = (JSON.parse(data) as { finalState?: string }).finalState ??
                  "";
              } catch {
                // keep fs empty
              }
              if (fs) {
                setFinalState(fs);
                onCompleteRef.current(fs);
              }
              controller.abort();
            } else if (event === "timeout") {
              setStreamError(
                "Provisioning is taking longer than expected. Refresh to re-check status.",
              );
            } else if (event === "error") {
              setStreamError("Lost the progress stream. Refresh to reconnect.");
            }
            // "connected" — nothing to render
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) return; // unmounted or done
        if (isSessionExpired(err)) {
          setSessionExpired(true);
          return;
        }
        if (!done) {
          setStreamError("Couldn't open the progress stream. Refresh to retry.");
        }
      }
    })();
    return () => controller.abort();
  }, [projectId, getAccessTokenSilently]);

  // Live elapsed ticker — only runs while a step is actively in progress.
  const hasActive = useMemo(() => {
    if (finalState) return false;
    for (const e of events.values()) {
      if (e.status === "in_progress") return true;
    }
    return false;
  }, [events, finalState]);
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasActive]);

  const ordered = useMemo(
    () =>
      [...events.values()].sort((a, b) => {
        const byTime = a.created_at.localeCompare(b.created_at);
        return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
      }),
    [events],
  );

  if (sessionExpired) {
    return (
      <div className="genesis-progress">
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="genesis-progress">
      {ordered.length === 0 && !streamError ? (
        <p className="muted">Starting provisioning…</p>
      ) : null}
      {ordered.length > 0 ? (
        <ul className="genesis-steps">
          {ordered.map((e) => {
            const icon: { icon: string; cls: string; spin?: boolean } =
              STATUS_ICON[e.status] ?? { icon: "○", cls: "step-pending" };
            const elapsed = formatElapsed(e.started_at, e.completed_at, nowTs);
            const items = detailItems(e.details);
            return (
              <li key={e.id} className="genesis-step">
                <span
                  className={`step-icon ${icon.cls}${
                    icon.spin ? " step-spin" : ""
                  }`}
                  aria-hidden="true"
                >
                  {icon.icon}
                </span>
                <div className="step-body">
                  <div className="step-head">
                    <span className="step-name">
                      {humanizeStep(e.step_name)}
                    </span>
                    {elapsed ? (
                      <span className="step-elapsed">{elapsed}</span>
                    ) : null}
                  </div>
                  {items.length > 0 ? (
                    <div className="step-details">
                      {items.map((it) =>
                        it.href ? (
                          <a
                            key={it.key}
                            href={it.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {it.text} ↗
                          </a>
                        ) : (
                          <span key={it.key}>{it.text}</span>
                        ),
                      )}
                    </div>
                  ) : null}
                  {e.error_message ? (
                    <div className="step-error">{e.error_message}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {streamError ? <p className="error">{streamError}</p> : null}
    </div>
  );
}

type TemplateChoice = "html-js" | "sveltekit" | "nextjs";

const TEMPLATE_LABEL: Record<TemplateChoice, string> = {
  "html-js": "HTML + JavaScript",
  sveltekit: "SvelteKit",
  nextjs: "Next.js",
};

function templateLabelFor(value: string): string {
  return TEMPLATE_LABEL[value as TemplateChoice] ?? value;
}

// Add-project selector: order + helper text. html-js first (the default and
// simplest "click button, get a working project" path).
const TEMPLATE_OPTIONS: Array<{
  value: TemplateChoice;
  label: string;
  helper: string;
}> = [
  {
    value: "html-js",
    label: "HTML + JavaScript",
    helper: "Minimal Express server, no framework",
  },
  {
    value: "nextjs",
    label: "Next.js",
    helper: "React-based with App Router",
  },
  {
    value: "sveltekit",
    label: "SvelteKit",
    helper: "Lightweight, fast, modern",
  },
];

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  provisioning_state: ProvisioningState;
  template_choice: TemplateChoice;
  subdomain: string | null;
  deployed_url: string | null;
  organization_id: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

function ProjectsPanel({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [addName, setAddName] = useState("");
  const [addDescription, setAddDescription] = useState("");
  const [addTemplate, setAddTemplate] = useState<TemplateChoice>("html-js");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Per-project genesis UI state, keyed by project id.
  const [progressOpen, setProgressOpen] = useState<Record<string, boolean>>({});
  const [provisionError, setProvisionError] = useState<
    Record<string, string>
  >({});
  const [provisioningBusy, setProvisioningBusy] = useState<
    Record<string, boolean>
  >({});

  const setProjectState = useCallback(
    (id: string, state: ProvisioningState) => {
      setProjects((prev) =>
        prev
          ? prev.map((p) =>
              p.id === id ? { ...p, provisioning_state: state } : p,
            )
          : prev,
      );
    },
    [],
  );

  const refresh = useCallback(async () => {
    setListError(null);
    setProjects(null);
    try {
      const res = await authedFetch(
        "/api/projects",
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't load projects.",
        );
        setProjects([]);
        return;
      }
      const body = (await res.json()) as { projects?: ProjectRow[] };
      setProjects(body.projects ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setProjects([]);
    }
  }, [getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      const res = await authedFetch(
        "/api/projects",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: addName,
            ...(addDescription ? { description: addDescription } : {}),
            template_choice: addTemplate,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg =
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't create project — try a different name?";
        try {
          const body = (await res.json()) as {
            error?: string;
            reason?: string;
          };
          if (body?.error === "slug_unavailable") {
            msg =
              "A project with that name already exists in your organization. Try a different name.";
          } else if (body?.error === "no_organization") {
            msg = "Your account isn't attached to an organization yet.";
          } else if (body?.reason) {
            msg = body.reason;
          } else if (body?.error) {
            msg = body.error;
          }
        } catch {
          // body wasn't JSON; keep the status-derived message
        }
        setAddError(msg);
        return;
      }
      setAddName("");
      setAddDescription("");
      setAddTemplate("html-js");
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setAddError("Couldn't reach the server. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await authedFetch(
        `/api/projects/${id}`,
        { method: "DELETE" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError(
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't delete that project.",
        );
        return;
      }
      await refresh();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  function setProvisionErr(id: string, msg: string) {
    setProvisionError((prev) => ({ ...prev, [id]: msg }));
  }
  function openProgress(id: string) {
    setProgressOpen((prev) => ({ ...prev, [id]: true }));
  }

  async function handleProvision(id: string) {
    setProvisionError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setProvisioningBusy((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await authedFetch(
        `/api/projects/${id}/genesis`,
        { method: "POST" },
        getAccessTokenSilently,
      );

      if (res.status === 202) {
        setProjectState(id, "provisioning");
        openProgress(id);
        return;
      }

      let body: { error?: string; missing?: string[] } = {};
      try {
        body = (await res.json()) as { error?: string; missing?: string[] };
      } catch {
        // non-JSON; fall through to status-based handling
      }

      if (res.status === 409) {
        if (body.error === "already_provisioning") {
          // Likely a refresh of an in-flight run — just attach the stream.
          setProjectState(id, "provisioning");
          openProgress(id);
          return;
        }
        setProvisionErr(
          id,
          body.error === "already_provisioned"
            ? "This project is already provisioned."
            : "This project needs manual cleanup before it can be provisioned again.",
        );
        return;
      }

      if (res.status === 400 && body.error === "missing_platform_credentials") {
        const missing = (body.missing ?? [])
          .map((p) => PLATFORM_LABEL[p as Platform] ?? p)
          .join(", ");
        setProvisionErr(
          id,
          `Add hosting connections first — missing: ${missing || "credentials"}. See "Hosting connections" below.`,
        );
        return;
      }

      setProvisionErr(
        id,
        res.status >= 500
          ? "Something went wrong on our end. Try again in a moment."
          : (body.error ?? "Couldn't start provisioning."),
      );
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setProvisionErr(id, "Couldn't reach the server. Try again.");
    } finally {
      setProvisioningBusy((prev) => ({ ...prev, [id]: false }));
    }
  }

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Projects</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Projects</h3>
      {projects === null && !listError ? (
        <p className="muted">Loading projects…</p>
      ) : null}
      {listError ? <p className="error">{listError}</p> : null}
      {projects && projects.length === 0 && !listError ? (
        <p className="muted">No projects yet. Create one below.</p>
      ) : null}
      {projects && projects.length > 0 ? (
        <ul className="projects-list">
          {projects.map((p) => {
            const badge = badgeFor(p.provisioning_state);
            const canProvision =
              PROVISIONABLE.has(p.provisioning_state) &&
              !provisioningBusy[p.id];
            return (
              <li key={p.id} className="project-row">
                <div className="project-info">
                  <div className="project-name">
                    {p.name}
                    <span className={`genesis-badge ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="project-slug">{p.slug}</div>
                  {p.description ? (
                    <div className="project-description">{p.description}</div>
                  ) : null}
                  <div className="project-meta">
                    <span className="project-template-badge">
                      Template: {templateLabelFor(p.template_choice)}
                    </span>
                    {p.deployed_url ? (
                      <a
                        className={`project-subdomain-link${
                          p.provisioning_state === "provisioned"
                            ? ""
                            : " muted"
                        }`}
                        href={p.deployed_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        URL: {p.deployed_url}
                      </a>
                    ) : null}
                  </div>
                  {provisionError[p.id] ? (
                    <div className="error">{provisionError[p.id]}</div>
                  ) : null}
                  {progressOpen[p.id] ? (
                    <GenesisProgress
                      projectId={p.id}
                      getAccessTokenSilently={getAccessTokenSilently}
                      onComplete={(fs) =>
                        setProjectState(p.id, fs as ProvisioningState)
                      }
                    />
                  ) : null}
                </div>
                <div className="project-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!canProvision}
                    onClick={() => void handleProvision(p.id)}
                  >
                    {provisioningBusy[p.id] ? "Starting…" : "Provision"}
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void handleDelete(p.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <form className="add-project-form" onSubmit={(e) => void handleAdd(e)}>
        <input
          type="text"
          placeholder="e.g. My SaaS project"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          maxLength={100}
          required
        />
        <textarea
          placeholder="Optional. What is this project?"
          value={addDescription}
          onChange={(e) => setAddDescription(e.target.value)}
          maxLength={5000}
        />
        <fieldset className="template-selector">
          <legend>Template</legend>
          {TEMPLATE_OPTIONS.map((opt) => (
            <label key={opt.value} className="template-option">
              <input
                type="radio"
                name="template_choice"
                value={opt.value}
                checked={addTemplate === opt.value}
                onChange={() => setAddTemplate(opt.value)}
              />
              <span className="template-option-label">{opt.label}</span>
              <span className="template-option-helper">{opt.helper}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn-primary" disabled={adding}>
          {adding ? "Adding…" : "Add project"}
        </button>
        {addError ? <p className="error">{addError}</p> : null}
      </form>
    </div>
  );
}

interface PromptSuccess {
  response: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
}

interface PromptErrorBlock {
  message: string;
  errorCode: string | null;
  latencyMs: number | null;
}

function PromptTester({
  getAccessTokenSilently,
}: {
  getAccessTokenSilently: GetAccessToken;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PromptSuccess | null>(null);
  const [errorBlock, setErrorBlock] = useState<PromptErrorBlock | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    setResult(null);
    setErrorBlock(null);
    setSending(true);
    try {
      const res = await authedFetch(
        "/api/prompt",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
        getAccessTokenSilently,
      );
      const body = (await res.json().catch(() => null)) as
        | (Partial<PromptSuccess> & {
            error?: string;
            providerErrorCode?: string;
            providerErrorMessage?: string;
            reason?: string;
            latencyMs?: number;
          })
        | null;

      if (res.ok && body && typeof body.response === "string") {
        setResult({
          response: body.response,
          model: body.model ?? "",
          inputTokens: body.inputTokens ?? null,
          outputTokens: body.outputTokens ?? null,
          estimatedCostUsd: body.estimatedCostUsd ?? null,
          latencyMs: body.latencyMs ?? 0,
        });
        return;
      }

      if (res.status === 400 && body?.error === "no_provider_key") {
        setErrorBlock({
          message: "Add a provider key first.",
          errorCode: null,
          latencyMs: null,
        });
        return;
      }

      if (res.status === 502 && body?.error === "provider_error") {
        setErrorBlock({
          message:
            body.providerErrorMessage ??
            body.providerErrorCode ??
            "Provider error.",
          errorCode: body.providerErrorCode ?? null,
          latencyMs: body.latencyMs ?? null,
        });
        return;
      }

      if (res.status >= 500) {
        setErrorBlock({
          message: "Something went wrong on our end. Try again in a moment.",
          errorCode: null,
          latencyMs: null,
        });
        return;
      }

      setErrorBlock({
        message:
          body?.reason ?? body?.error ?? "Please check your input.",
        errorCode: null,
        latencyMs: null,
      });
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setErrorBlock({
        message: "Couldn't reach the server. Try again.",
        errorCode: null,
        latencyMs: null,
      });
    } finally {
      setSending(false);
    }
  }

  if (sessionExpired) {
    return (
      <div className="settings-subsection">
        <h3>Test a prompt</h3>
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="settings-subsection">
      <h3>Test a prompt</h3>
      <form className="test-prompt-form" onSubmit={(e) => void handleSend(e)}>
        <textarea
          placeholder="Type a prompt and we'll route it to your default provider key."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          maxLength={100_000}
        />
        <button type="submit" className="btn-primary" disabled={sending}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {result ? (
        <div>
          <div className="prompt-result">{result.response}</div>
          <div className="prompt-meta">
            <span>model: {result.model || "—"}</span>
            <span>
              tokens: {result.inputTokens ?? "—"} in /{" "}
              {result.outputTokens ?? "—"} out
            </span>
            <span>cost: {formatCost(result.estimatedCostUsd)}</span>
            <span>latency: {result.latencyMs} ms</span>
          </div>
        </div>
      ) : null}
      {errorBlock ? (
        <div>
          <p className="error">{errorBlock.message}</p>
          <div className="prompt-meta">
            {errorBlock.errorCode ? (
              <span>code: {errorBlock.errorCode}</span>
            ) : null}
            {errorBlock.latencyMs !== null ? (
              <span>latency: {errorBlock.latencyMs} ms</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface MeShape {
  role: string;
  organization: { id: string; name: string; slug: string } | null;
}

export function App() {
  const [health, setHealth] = useState<HealthStatus>("pending");
  const [me, setMe] = useState<MeShape | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const {
    isAuthenticated,
    isLoading,
    user,
    getAccessTokenSilently,
    loginWithRedirect,
    logout,
  } = useAuth0();

  useEffect(() => {
    let cancelled = false;
    fetch(HEALTH_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error("not ok");
        const body = (await res.json()) as { status?: unknown };
        if (cancelled) return;
        setHealth(body.status === "ok" ? "ok" : "down");
      })
      .catch(() => {
        if (!cancelled) setHealth("down");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setMe(null);
      setShowSettings(false);
      setSessionExpired(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(
          "/api/me",
          {},
          getAccessTokenSilently,
        );
        if (!res.ok) throw new Error(`/api/me responded ${res.status}`);
        const body = (await res.json()) as Partial<MeShape>;
        if (!cancelled && typeof body.role === "string") {
          setMe({
            role: body.role,
            organization: body.organization ?? null,
          });
        }
      } catch (err) {
        if (isSessionExpired(err)) {
          if (!cancelled) setSessionExpired(true);
          return;
        }
        // Per Sprint 1 scope: log only; don't surface to user.
        console.error("[api/me] fetch failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, getAccessTokenSilently]);

  return (
    <main className="page">
      <div className="content">
        <header className="hero">
          <h1>AI Connect</h1>
          <p className="tagline">
            The methodology layer for AI-assisted development.
          </p>
        </header>

        <section className="description">
          <p>
            AI Connect routes prompts to the right AI tool for the job — Claude,
            Claude Code, Cursor, Perplexity, Ollama, and whatever&apos;s next —
            while enforcing the MTTBuild methodology as platform behavior. It also
            handles the operational layer around AI-assisted dev: deploy
            infrastructure (Render, Vercel, Supabase), auth and billing (Auth0,
            Stripe), DNS and edge (Cloudflare), IDE integration (Cursor, VS Code),
            shell automation, container workflows (Docker), repo plumbing
            (GitHub), secret handling, and audit trails — so methodology
            discipline holds across the whole loop, not just the chat.
          </p>
        </section>

        <section className="audience">
          <p>
            Designed for teams that use AI assistants heavily and need conflict
            prevention, reproducible workflows, and honest accountability —
            whether you&apos;re one developer or fifty — without bolting on more
            SaaS. Open-core (MIT framework), self-hostable, and dogfooded on this
            very project.
          </p>
        </section>

        <section className="status-block">
          <p className="status-line">
            <span
              className={`dot dot-${health}`}
              aria-label={`API status: ${health}`}
              role="status"
            />
            <span>Pre-launch &middot; Sprint 0 shipped May 24, 2026</span>
          </p>
          <p>
            Phase 0 infrastructure live in production: API, web, schema, logging,
            admin tooling, secret handling.
          </p>
          <p>
            Next: Sprint 1 — Auth0 wiring + first authenticated routes (June
            2026).
          </p>
          <p>
            <a href={CHANGELOG_URL}>Read the full changelog →</a>
          </p>
          {!isLoading && isAuthenticated && sessionExpired ? (
            <SessionExpiredNotice />
          ) : null}
          {!isLoading && !(isAuthenticated && sessionExpired) && (
            <p className="auth-line">
              {isAuthenticated ? (
                <>
                  Signed in as {user?.email}
                  {me?.role ? ` (role: ${me.role})` : ""}
                  {me?.organization ? ` · ${me.organization.name}` : ""}
                  {" · "}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setShowSettings((v) => !v)}
                  >
                    {showSettings ? "Hide settings" : "Manage settings"}
                  </button>
                  {" · "}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() =>
                      logout({
                        logoutParams: { returnTo: window.location.origin },
                      })
                    }
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="linklike"
                  onClick={() => loginWithRedirect()}
                >
                  Sign in
                </button>
              )}
            </p>
          )}
        </section>

        {isAuthenticated && showSettings ? (
          <section className="settings-block">
            <h2>Settings</h2>
            <ProjectsPanel
              getAccessTokenSilently={getAccessTokenSilently}
            />
            <PlatformCredentialsPanel
              getAccessTokenSilently={getAccessTokenSilently}
            />
            <KeysPanel getAccessTokenSilently={getAccessTokenSilently} />
            <IntegrationsPanel
              getAccessTokenSilently={getAccessTokenSilently}
            />
            <PromptTester
              getAccessTokenSilently={getAccessTokenSilently}
            />
          </section>
        ) : null}

        <section className="devs">
          <h2>For developers — what AI Connect actually does</h2>
          <p>
            Most AI-assisted dev today is a chat window. You ask Claude or Cursor
            for help, paste output around, commit, hope the methodology you meant
            to follow actually got followed. AI Connect makes the methodology the
            platform.
          </p>
          <p>
            <strong>Routing.</strong> A single chat surface routes each prompt to
            the best AI for the task — planning to Claude, implementation to
            Claude Code, refactoring to Cursor, research to Perplexity, local-only
            work to Ollama. State and context persist across handoffs.
          </p>
          <p>
            <strong>Methodology enforcement.</strong> Every sprint follows
            MTTBuild — Phase 0 infrastructure checklists, conflict prevention
            rules, branch-from-master, revert-first on production breaks, schema
            migrations never auto-apply. The platform won&apos;t let you skip
            steps that should not be skipped.
          </p>
          <p>
            <strong>Operational layer.</strong> AI Connect speaks to the
            infrastructure around your code: triggers Render and Vercel deploys,
            manages Supabase migrations safely, configures Auth0 tenants, handles
            Stripe customers, edits Cloudflare DNS, runs commands in your IDE and
            shell, sets and rotates secrets without exposing them in chat
            history. The boundary between code and
            infrastructure-that-hosts-the-code disappears.
          </p>
          <p>
            <strong>Audit trails.</strong> Every prompt, every AI response, every
            executed action is logged structurally — to logging tables in your
            DB, to git history, to system audit logs. When something breaks at
            2am you can trace exactly what was decided, by which AI, with what
            context. The same audit data is designed to support SOC 2 / ISO 27001
            evidence collection later — change management and developer-activity
            logs without bolt-on tooling.
          </p>
          <p>
            <strong>Open core.</strong> The MIT framework runs on your hardware
            or any cloud. The hosted version at aiconnect.macrotechtitan.com is a
            managed convenience layer — you can switch any time. No lock-in by
            design.
          </p>
        </section>

        <section className="vision">
          <h2>Where this is going</h2>
          <p>
            AI Connect&apos;s connector layer will eventually bridge AI agents to
            any external system — WordPress, IoT devices, telecom APIs, email
            infrastructure, mainframe gateways, Oracle ERPs, custom enterprise
            systems. We&apos;ll integrate with existing connector frameworks
            where they fit and build custom MCP servers where they don&apos;t.
            The methodology and core platform ship first; connectors follow real
            user demand.
          </p>
        </section>

        <section className="links">
          <a href="https://github.com/MacroTechTitan/AI-Connect">GitHub</a>
          <a href="https://github.com/MacroTechTitan/AI-Connect#readme">
            README / Docs
          </a>
          <a href="https://macrotechtitan.com">Macro Tech Titan</a>
          <a href={CHANGELOG_URL}>Changelog</a>
        </section>

        <section className="logo-block">
          <img
            src="https://blog.macrotechtitan.com/wp-content/uploads/2026/05/MTT-AI-Connect-1-300x300.png"
            alt="AI Connect logo"
            className="logo"
          />
        </section>

        <footer className="footer">
          <p>
            Built by{" "}
            <a href="https://macrotechtitan.com">Macro Tech Titan</a>.
            Open-source under MIT.
          </p>
          <p>Hosted on Render + Vercel + Supabase.</p>
          <p>
            For full legal disclaimers and disclosures, see{" "}
            <a href="https://legal.macrotechtitan.com">
              legal.macrotechtitan.com
            </a>
            .
          </p>
          <p>
            All third-party product names mentioned are trademarks of their
            respective owners.
          </p>
        </footer>
      </div>
    </main>
  );
}
