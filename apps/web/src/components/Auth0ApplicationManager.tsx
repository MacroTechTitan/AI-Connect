import "./Auth0ApplicationManager.css";
import { useCallback, useEffect, useState } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { Badge, type BadgeVariant } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Pill } from "../ui/Pill";
import { HelpLink } from "./HelpLink";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

type Auth0AppType = "spa" | "native" | "regular_web" | "non_interactive";

interface Auth0Application {
  client_id: string;
  name: string;
  description?: string;
  app_type?: Auth0AppType;
  callbacks?: string[];
  allowed_logout_urls?: string[];
  allowed_origins?: string[];
  web_origins?: string[];
}

const APP_TYPE_OPTIONS: Array<{ value: Auth0AppType; label: string }> = [
  { value: "regular_web", label: "Regular Web (recommended)" },
  { value: "spa", label: "Single Page App (SPA)" },
  { value: "native", label: "Native" },
  { value: "non_interactive", label: "Machine to Machine" },
];

function appTypeBadge(type: string | undefined): {
  variant: BadgeVariant;
  label: string;
} {
  switch (type) {
    case "regular_web":
      return { variant: "success", label: "regular_web" };
    case "spa":
      return { variant: "info", label: "spa" };
    case "native":
      return { variant: "info", label: "native" };
    case "non_interactive":
      return { variant: "neutral", label: "non_interactive" };
    default:
      return { variant: "neutral", label: type ?? "unknown" };
  }
}

// One URL per line → trimmed, non-empty array.
function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function arrayToLines(arr: string[] | undefined): string {
  return (arr ?? []).join("\n");
}

// ── Create Application modal ────────────────────────────────────────────────

function describeCreateError(
  status: number,
  body: { error?: string; message?: string },
): string {
  if (body.error === "name_required") return "Application name is required.";
  if (body.error === "name_too_long") {
    return "Application name exceeds the 100 character limit.";
  }
  if (status === 409) {
    return "An application with this name already exists. Try a different name.";
  }
  if (status === 429) {
    return "Auth0 rate limit hit. Try again in a moment.";
  }
  return body.message ?? body.error ?? "Couldn't create the application.";
}

function CreateApplicationModal({
  base,
  getAccessTokenSilently,
  onClose,
  onCreated,
}: {
  base: string;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onCreated: (app: Auth0Application) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [appType, setAppType] = useState<Auth0AppType>("regular_web");
  const [callbacks, setCallbacks] = useState("");
  const [logoutUrls, setLogoutUrls] = useState("");
  const [webOrigins, setWebOrigins] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (name.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // The create form exposes one "web origins" field; it seeds both
      // allowed_origins (CORS) and web_origins (silent auth), which for a
      // provisioned app are the same. Split them out in Sprint 8.5+ if needed.
      const origins = linesToArray(webOrigins);
      const res = await authedFetch(
        `${base}/auth0/applications`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || undefined,
            app_type: appType,
            callbacks: linesToArray(callbacks),
            allowed_logout_urls: linesToArray(logoutUrls),
            allowed_origins: origins,
            web_origins: origins,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let body: { error?: string; message?: string } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          // keep empty
        }
        setError(describeCreateError(res.status, body));
        return;
      }
      const body = (await res.json()) as { application: Auth0Application };
      onCreated(body.application);
      onClose();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title="Create Auth0 Application">
      <div className="a0m-form">
        <Input
          label="Name"
          placeholder="My New App"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
        <label className="a0m-field">
          <span className="a0m-field-label">Description (optional)</span>
          <textarea
            className="a0m-textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="a0m-field">
          <span className="a0m-field-label">App type</span>
          <div className="a0m-radios">
            {APP_TYPE_OPTIONS.map((opt) => (
              <label key={opt.value} className="a0m-radio">
                <input
                  type="radio"
                  name="a0m-app-type"
                  value={opt.value}
                  checked={appType === opt.value}
                  onChange={() => setAppType(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="a0m-field">
          <span className="a0m-field-label">Callback URLs</span>
          <textarea
            className="a0m-textarea"
            rows={3}
            placeholder="https://myapp.com/callback"
            value={callbacks}
            onChange={(e) => setCallbacks(e.target.value)}
          />
          <span className="a0m-help">
            One URL per line. Example: https://myapp.com/callback
          </span>
        </label>
        <label className="a0m-field">
          <span className="a0m-field-label">Allowed logout URLs</span>
          <textarea
            className="a0m-textarea"
            rows={2}
            value={logoutUrls}
            onChange={(e) => setLogoutUrls(e.target.value)}
          />
        </label>
        <label className="a0m-field">
          <span className="a0m-field-label">Allowed web origins</span>
          <textarea
            className="a0m-textarea"
            rows={2}
            placeholder="https://myapp.com"
            value={webOrigins}
            onChange={(e) => setWebOrigins(e.target.value)}
          />
          <span className="a0m-help">
            One origin per line. Example: https://myapp.com
          </span>
        </label>
        {error ? <p className="a0m-error">{error}</p> : null}
        <div className="a0m-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={name.trim().length === 0 || submitting}
          >
            {submitting ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Edit Callback URLs modal ────────────────────────────────────────────────

function EditCallbacksModal({
  base,
  app,
  getAccessTokenSilently,
  onClose,
  onSaved,
}: {
  base: string;
  app: Auth0Application;
  getAccessTokenSilently: GetAccessToken;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [callbacks, setCallbacks] = useState(arrayToLines(app.callbacks));
  const [logoutUrls, setLogoutUrls] = useState(
    arrayToLines(app.allowed_logout_urls),
  );
  const [origins, setOrigins] = useState(
    arrayToLines(app.web_origins ?? app.allowed_origins),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const originArr = linesToArray(origins);
      const res = await authedFetch(
        `${base}/auth0/applications/${encodeURIComponent(app.client_id)}/callbacks`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callbacks: linesToArray(callbacks),
            allowed_logout_urls: linesToArray(logoutUrls),
            allowed_origins: originArr,
            web_origins: originArr,
          }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't update the callback URLs.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          if (res.status === 429) msg = "Auth0 rate limit hit. Try again.";
          else msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setError(msg);
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title={`Edit callback URLs — ${app.name}`}>
      <div className="a0m-form">
        <label className="a0m-field">
          <span className="a0m-field-label">Callback URLs</span>
          <textarea
            className="a0m-textarea"
            rows={3}
            value={callbacks}
            onChange={(e) => setCallbacks(e.target.value)}
          />
        </label>
        <label className="a0m-field">
          <span className="a0m-field-label">Allowed logout URLs</span>
          <textarea
            className="a0m-textarea"
            rows={2}
            value={logoutUrls}
            onChange={(e) => setLogoutUrls(e.target.value)}
          />
        </label>
        <label className="a0m-field">
          <span className="a0m-field-label">Allowed web origins</span>
          <textarea
            className="a0m-textarea"
            rows={2}
            value={origins}
            onChange={(e) => setOrigins(e.target.value)}
          />
        </label>
        {error ? <p className="a0m-error">{error}</p> : null}
        <div className="a0m-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Manager panel ───────────────────────────────────────────────────────────

// Post-wizard / from-row panel for managing an Auth0 tenant's applications.
// Rendered inline below the integrations list (like OpenClawAgentManager), not
// as a modal — the create/edit dialogs are Modals layered on top. Takes the
// integration id (+ optional tenant domain / current default for display); the
// wizard path passes only the id.
export function Auth0ApplicationManager({
  getAccessTokenSilently,
  integrationId,
  domain,
  defaultApplicationId,
  onClose,
}: {
  getAccessTokenSilently: GetAccessToken;
  integrationId: string;
  domain?: string;
  defaultApplicationId?: string;
  onClose: () => void;
}) {
  const [applications, setApplications] = useState<Auth0Application[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editCallbacksModalOpen, setEditCallbacksModalOpen] = useState(false);
  const [inFlightAction, setInFlightAction] = useState<
    "create" | "edit_callbacks" | "set_default" | null
  >(null);
  const [defaultAppId, setDefaultAppId] = useState<string | null>(
    defaultApplicationId ?? null,
  );
  const [sessionExpired, setSessionExpired] = useState(false);

  const base = `/api/integrations/${integrationId}`;
  const selectedApp =
    applications.find((a) => a.client_id === selectedAppId) ?? null;

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await authedFetch(
        `${base}/auth0/applications`,
        {},
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg = "Couldn't load applications.";
        try {
          const body = (await res.json()) as {
            message?: string;
            error?: string;
          };
          msg = body.message ?? body.error ?? msg;
        } catch {
          // keep default
        }
        setListError(msg);
        setApplications([]);
        return;
      }
      const body = (await res.json()) as { applications?: Auth0Application[] };
      setApplications(body.applications ?? []);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setApplications([]);
    } finally {
      setLoadingList(false);
    }
  }, [base, getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSetDefault(appId: string) {
    setInFlightAction("set_default");
    setListError(null);
    try {
      const res = await authedFetch(
        `${base}/auth0/default-application`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ application_id: appId }),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError("Couldn't set the default application. Try again.");
        return;
      }
      setDefaultAppId(appId);
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    } finally {
      setInFlightAction(null);
    }
  }

  function copyClientId(clientId: string) {
    void navigator.clipboard?.writeText(clientId).catch(() => {});
  }

  if (sessionExpired) {
    return (
      <div className="a0m">
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="a0m">
      <div className="a0m-head">
        <div className="a0m-title">
          <h4>
            Auth0 Applications
            <HelpLink articleId="auth0" label="Help — Auth0" />
          </h4>
          {domain ? <span className="a0m-domain">{domain}</span> : null}
        </div>
        <button type="button" className="linklike" onClick={onClose}>
          Close
        </button>
      </div>

      {listError ? <p className="a0m-error">{listError}</p> : null}

      <div className="a0m-body">
        <div className="a0m-list-pane">
          <div className="a0m-section-head">
            <h5>Applications</h5>
            <button
              type="button"
              className="linklike"
              onClick={() => void refresh()}
              disabled={loadingList}
            >
              {loadingList ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {loadingList ? (
            <p className="a0m-muted">Loading applications…</p>
          ) : applications.length === 0 ? (
            <p className="a0m-muted">
              No applications yet. Create one to get started.
            </p>
          ) : (
            <div className="a0m-cards">
              {applications.map((a) => {
                const selected = selectedAppId === a.client_id;
                const badge = appTypeBadge(a.app_type);
                const isDefault = defaultAppId === a.client_id;
                return (
                  <Card
                    key={a.client_id}
                    variant={selected ? "elevated" : "default"}
                    padding="sm"
                    interactive
                    onClick={() => setSelectedAppId(a.client_id)}
                  >
                    <div className="a0m-app">
                      <div className="a0m-app-name">
                        {a.name}
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {isDefault ? (
                          <Pill variant="success" size="sm">
                            Default
                          </Pill>
                        ) : null}
                      </div>
                      <div className="a0m-app-meta a0m-mono">
                        …{a.client_id.slice(-8)}
                      </div>
                      <div className="a0m-app-meta">
                        {(a.callbacks ?? []).length} callback URL
                        {(a.callbacks ?? []).length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <Button onClick={() => setCreateModalOpen(true)}>
            Create New Application
          </Button>
        </div>

        <div className="a0m-detail-pane">
          {!selectedApp ? (
            <p className="a0m-muted">Select an application to view details.</p>
          ) : (
            <Card variant="default" padding="md">
              <div className="a0m-detail">
                <div className="a0m-detail-title">{selectedApp.name}</div>
                <div className="a0m-app-name">
                  <Badge variant={appTypeBadge(selectedApp.app_type).variant}>
                    {appTypeBadge(selectedApp.app_type).label}
                  </Badge>
                  {defaultAppId === selectedApp.client_id ? (
                    <Pill variant="success" size="sm">
                      Default
                    </Pill>
                  ) : null}
                </div>

                <div className="a0m-detail-row">
                  <span className="a0m-muted">Client ID</span>
                  <div className="a0m-clientid">
                    <code className="a0m-mono">{selectedApp.client_id}</code>
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => copyClientId(selectedApp.client_id)}
                    >
                      Copy
                    </button>
                  </div>
                </div>

                <UrlList label="Callbacks" urls={selectedApp.callbacks} />
                <UrlList
                  label="Allowed logout URLs"
                  urls={selectedApp.allowed_logout_urls}
                />
                <UrlList
                  label="Allowed origins"
                  urls={selectedApp.allowed_origins}
                />
                <UrlList label="Web origins" urls={selectedApp.web_origins} />

                <div className="a0m-actions">
                  <Button
                    onClick={() => void handleSetDefault(selectedApp.client_id)}
                    disabled={
                      defaultAppId === selectedApp.client_id ||
                      inFlightAction === "set_default"
                    }
                  >
                    {defaultAppId === selectedApp.client_id
                      ? "Default"
                      : inFlightAction === "set_default"
                        ? "Saving…"
                        : "Set as Default"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditCallbacksModalOpen(true)}
                  >
                    Edit Callback URLs
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      {createModalOpen ? (
        <CreateApplicationModal
          base={base}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => {
            setCreateModalOpen(false);
            setInFlightAction(null);
          }}
          onCreated={(app) => {
            setSelectedAppId(app.client_id);
            void refresh();
          }}
        />
      ) : null}

      {editCallbacksModalOpen && selectedApp ? (
        <EditCallbacksModal
          base={base}
          app={selectedApp}
          getAccessTokenSilently={getAccessTokenSilently}
          onClose={() => setEditCallbacksModalOpen(false)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function UrlList({ label, urls }: { label: string; urls?: string[] }) {
  return (
    <div className="a0m-detail-row">
      <span className="a0m-muted">{label}</span>
      {urls && urls.length > 0 ? (
        <ul className="a0m-url-list">
          {urls.map((u) => (
            <li key={u} className="a0m-mono">
              {u}
            </li>
          ))}
        </ul>
      ) : (
        <span className="a0m-muted">—</span>
      )}
    </div>
  );
}
