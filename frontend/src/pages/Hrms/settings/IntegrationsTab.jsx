import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Info, Plug } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { ErrorState } from "../../../components/hrms/ErrorState";
import {
  settingsApi,
  INTEGRATION_LABELS,
  INTEGRATION_CATEGORIES,
} from "../../../services/hrms/settings";

/**
 * Integrations.
 *
 * The reference's tab — cards grouped by category, a per-kind field modal, an
 * active toggle — with two differences.
 *
 * The field table is SERVER-DRIVEN. The reference keeps it in the browser,
 * marks five fields `secret: true` there, and then returns every one of them
 * from `GET /integrations` because its service hands back the whole config
 * blob. Here the contract arrives with the row, and a secret arrives only as
 * its own name in `configuredSecrets`.
 *
 * And the screen says plainly that these are stored, not yet acted on — true of
 * the reference too, where nothing reads `IntegrationConfig` back.
 */

export function IntegrationsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await settingsApi.integrations());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <ErrorState
        title="Integrations could not be loaded"
        description={error.message}
        onRetry={load}
      />
    );
  }

  if (loading) {
    return (
      <div data-testid="integrations-skeleton" className="h-64 animate-pulse rounded-lg bg-slate-100" />
    );
  }

  const byKind = new Map(rows.map((r) => [r.kind, r]));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" aria-hidden="true" />
        <p className="text-sm text-slate-700">
          Credentials are <strong>stored securely but not yet acted on</strong> — nothing
          syncs to these services today. Secrets are encrypted and are never shown again
          once saved.
        </p>
      </div>

      {INTEGRATION_CATEGORIES.map(({ key, kinds }) => (
        <section key={key}>
          <h3 className="mb-3 text-sm font-semibold text-slate-900">{key}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {kinds.map((kind) => {
              const row = byKind.get(kind);
              if (!row) return null;
              return (
                <article
                  key={kind}
                  className="flex flex-col rounded-lg border border-slate-200 bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <Plug className="h-4 w-4 text-slate-400" aria-hidden="true" />
                      {INTEGRATION_LABELS[kind] ?? kind}
                    </h4>
                    {row.active ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="neutral">Inactive</Badge>
                    )}
                  </div>

                  <p className="mt-2 flex-1 text-xs text-slate-500">
                    {row.configuredSecrets.length > 0
                      ? `${row.configuredSecrets.length} credential${
                          row.configuredSecrets.length === 1 ? "" : "s"
                        } stored`
                      : "Not configured"}
                  </p>

                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(row)}
                      aria-label={`Configure ${INTEGRATION_LABELS[kind] ?? kind}`}
                    >
                      Configure
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {editing && (
        <IntegrationDrawer
          integration={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setRows((current) => current.map((r) => (r.kind === saved.kind ? saved : r)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function IntegrationDrawer({ integration, onClose, onSaved }) {
  const stored = new Set(integration.configuredSecrets);
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      integration.fields.map((f) => [
        f.key,
        // A secret is never prefilled — the server does not send it.
        f.secret ? "" : (integration.config?.[f.key] ?? ""),
      ]),
    ),
  );
  const [active, setActive] = useState(integration.active);
  const [saving, setSaving] = useState(false);

  const label = INTEGRATION_LABELS[integration.kind] ?? integration.kind;

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const config = {};
      for (const field of integration.fields) {
        const raw = values[field.key];
        // An untouched secret is omitted, which the server reads as
        // "leave the stored one alone".
        if (field.secret && !raw) continue;
        if (raw === "" || raw === undefined) continue;
        config[field.key] = field.type === "number" ? Number(raw) : raw;
      }
      onSaved(await settingsApi.saveIntegration({ kind: integration.kind, config, active }));
      toast.success(`${label} saved.`);
    } catch (err) {
      toast.error(err?.message ?? "That integration could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer isOpen onClose={saving ? () => {} : onClose} title={label} maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        {integration.fields.map((field) => (
          <div key={field.key}>
            <label
              htmlFor={`int-${field.key}`}
              className="mb-1 block text-sm font-medium text-slate-700"
            >
              {field.label}
            </label>
            <Input
              id={`int-${field.key}`}
              type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
              autoComplete={field.secret ? "new-password" : "off"}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((c) => ({ ...c, [field.key]: e.target.value }))}
              placeholder={
                field.secret && stored.has(field.key) ? "Stored — leave blank to keep" : ""
              }
            />
            {field.secret && (
              <p className="mt-1 text-xs text-slate-500">
                {stored.has(field.key)
                  ? "Stored and encrypted. It is never sent back to this page."
                  : "Encrypted on save, and never shown again."}
              </p>
            )}
          </div>
        ))}

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          Active
        </label>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export default IntegrationsTab;
