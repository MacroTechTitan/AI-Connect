import { useCallback, useEffect, useState, type FormEvent } from "react";

import { authedFetch, isSessionExpired, type GetAccessToken } from "../lib/api";
import { SessionExpiredNotice } from "./SessionExpiredNotice";

interface WpModule {
  slug: string;
  title: string;
  source_url: string;
  required_memberpress_tier: string | null;
}

interface WpMembership {
  id: string;
  title: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;

export function WordPressModuleManager({
  getAccessTokenSilently,
  integrationId,
  siteUrl,
  onClose,
}: {
  getAccessTokenSilently: GetAccessToken;
  integrationId: string;
  siteUrl: string;
  onClose: () => void;
}) {
  const [modules, setModules] = useState<WpModule[] | null>(null);
  const [memberships, setMemberships] = useState<WpMembership[] | null>(null);
  const [memberpressInstalled, setMemberpressInstalled] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Add/edit form. When editingSlug is set, the slug is locked (it's the URL
  // key the plugin updates by) and submit PATCHes instead of POSTs.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [tier, setTier] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const base = `/api/integrations/${integrationId}`;

  const refresh = useCallback(async () => {
    setListError(null);
    setModules(null);
    try {
      const [modRes, statusRes] = await Promise.all([
        authedFetch(`${base}/modules`, {}, getAccessTokenSilently),
        authedFetch(`${base}/status`, {}, getAccessTokenSilently),
      ]);
      if (!modRes.ok) {
        let msg = "Couldn't load modules.";
        try {
          const body = (await modRes.json()) as { reason?: string };
          if (body?.reason) msg = body.reason;
        } catch {
          // keep default
        }
        setListError(msg);
        setModules([]);
        return;
      }
      const modBody = (await modRes.json()) as { modules?: WpModule[] };
      setModules(modBody.modules ?? []);

      // Status is best-effort — gating dropdown degrades gracefully if it fails.
      if (statusRes.ok) {
        const statusBody = (await statusRes.json()) as {
          memberpress_installed?: boolean;
          memberpress_memberships?: WpMembership[] | null;
        };
        setMemberpressInstalled(Boolean(statusBody.memberpress_installed));
        setMemberships(statusBody.memberpress_memberships ?? null);
      }
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
      setModules([]);
    }
  }, [base, getAccessTokenSilently]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function resetForm() {
    setEditingSlug(null);
    setSlug("");
    setTitle("");
    setSourceUrl("");
    setTier("");
    setFormError(null);
  }

  function startEdit(m: WpModule) {
    setEditingSlug(m.slug);
    setSlug(m.slug);
    setTitle(m.title);
    setSourceUrl(m.source_url);
    setTier(m.required_memberpress_tier ?? "");
    setFormError(null);
  }

  const canSubmit =
    SLUG_RE.test(slug) &&
    title.trim().length > 0 &&
    /^https?:\/\//i.test(sourceUrl);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!canSubmit) {
      setFormError(
        "Slug must be lowercase letters, numbers, and hyphens; title and a valid http(s) source URL are required.",
      );
      return;
    }
    setSaving(true);
    try {
      const payload = {
        slug,
        title: title.trim(),
        source_url: sourceUrl,
        required_memberpress_tier: tier === "" ? null : tier,
      };
      const res = await authedFetch(
        editingSlug
          ? `${base}/modules/${encodeURIComponent(editingSlug)}`
          : `${base}/modules`,
        {
          method: editingSlug ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        let msg =
          res.status >= 500
            ? "Something went wrong on our end. Try again in a moment."
            : "Couldn't save the module.";
        try {
          const body = (await res.json()) as {
            reason?: string;
            error?: string;
          };
          if (body?.reason) msg = body.reason;
          else if (body?.error) msg = body.error;
        } catch {
          // keep default
        }
        setFormError(msg);
        return;
      }
      const body = (await res.json()) as { modules?: WpModule[] };
      if (body.modules) setModules(body.modules);
      resetForm();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setFormError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(m: WpModule) {
    if (!window.confirm(`Remove the "${m.title}" module (/${m.slug}/)?`)) {
      return;
    }
    try {
      const res = await authedFetch(
        `${base}/modules/${encodeURIComponent(m.slug)}`,
        { method: "DELETE" },
        getAccessTokenSilently,
      );
      if (!res.ok) {
        setListError("Couldn't remove that module.");
        return;
      }
      const body = (await res.json()) as { modules?: WpModule[] };
      if (body.modules) setModules(body.modules);
      else await refresh();
      if (editingSlug === m.slug) resetForm();
    } catch (err) {
      if (isSessionExpired(err)) {
        setSessionExpired(true);
        return;
      }
      setListError("Couldn't reach the server. Try again.");
    }
  }

  function moduleUrl(s: string): string {
    return `${siteUrl.replace(/\/$/, "")}/${s}/`;
  }

  function tierName(id: string | null): string {
    if (!id) return "Public";
    const m = memberships?.find((x) => x.id === id);
    return m ? m.title : `Tier ${id}`;
  }

  if (sessionExpired) {
    return (
      <div className="wp-module-manager">
        <SessionExpiredNotice />
      </div>
    );
  }

  return (
    <div className="wp-module-manager">
      <div className="wp-module-manager-head">
        <h4>Modules — {siteUrl}</h4>
        <button type="button" className="linklike" onClick={onClose}>
          Close
        </button>
      </div>

      {modules === null && !listError ? (
        <p className="muted">Loading modules…</p>
      ) : null}
      {listError ? <p className="error">{listError}</p> : null}
      {modules && modules.length === 0 && !listError ? (
        <p className="muted">No modules yet. Add one below.</p>
      ) : null}

      {modules && modules.length > 0 ? (
        <ul className="wp-module-list">
          {modules.map((m) => (
            <li key={m.slug} className="wp-module-row">
              <div className="wp-module-info">
                <div className="wp-module-title">{m.title}</div>
                <div className="wp-module-slug">/{m.slug}/</div>
                <div className="wp-module-meta">
                  <span className="wp-module-tier">{tierName(m.required_memberpress_tier)}</span>
                  <a
                    href={m.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="wp-module-source"
                  >
                    {m.source_url}
                  </a>
                </div>
              </div>
              <div className="wp-module-actions">
                <a
                  href={moduleUrl(m.slug)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-primary"
                >
                  Test Module ↗
                </a>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => startEdit(m)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void handleRemove(m)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="wp-module-form" onSubmit={(e) => void handleSubmit(e)}>
        <h5>{editingSlug ? `Edit "${editingSlug}"` : "Add module"}</h5>
        <div className="row">
          <input
            className="label-input"
            type="text"
            placeholder="slug (lowercase-with-hyphens)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={editingSlug !== null}
            maxLength={100}
            required
          />
          <input
            className="label-input"
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
          />
        </div>
        <input
          className="credential-input"
          type="text"
          placeholder="Source URL (https://your-app.example.com)"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          maxLength={2000}
          required
        />
        <div className="row">
          <label className="wp-module-tier-label">
            Required tier:
            {memberpressInstalled && memberships && memberships.length > 0 ? (
              <select value={tier} onChange={(e) => setTier(e.target.value)}>
                <option value="">Public (no gating)</option>
                {memberships.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted">
                {" "}
                MemberPress not installed — modules are public.
              </span>
            )}
          </label>
        </div>
        <div className="row">
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !canSubmit}
          >
            {saving
              ? "Saving…"
              : editingSlug
                ? "Save changes"
                : "Add module"}
          </button>
          {editingSlug ? (
            <button type="button" className="linklike" onClick={resetForm}>
              Cancel edit
            </button>
          ) : null}
        </div>
        {formError ? <p className="error">{formError}</p> : null}
      </form>
    </div>
  );
}
