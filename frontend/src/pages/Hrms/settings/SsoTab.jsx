import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ShieldCheck, Info } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/Badge";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { settingsApi, SSO_PROVIDER_LABELS } from "../../../services/hrms/settings";

/**
 * Single Sign-On.
 *
 * The reference's tab — one card per provider, client id, client secret,
 * redirect URI, enable toggle — with the secret genuinely write-only.
 *
 * Two honest departures:
 *
 *   1. The secret field is BLANK on load and optional on save. The server never
 *      returns it, so there is nothing to prefill; leaving it empty keeps the
 *      stored one. The reference's placeholder promises "Never leaves the
 *      server after save", which is true of its SSO endpoint and false of its
 *      integrations endpoint beside it.
 *
 *   2. The screen says plainly that configuring a provider does not yet sign
 *      anyone in. That is true of the reference too — its `buildAuthUrl` is
 *      written and never called — but its UI does not admit it, so an
 *      administrator can reasonably think they have enabled SSO.
 */

const BLANK = { clientId: "", clientSecret: "", redirectUri: "", active: false };

export function SsoTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingProvider, setSavingProvider] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await settingsApi.sso();
      setRows(next);
      setDrafts(
        Object.fromEntries(
          next.map((p) => [
            p.provider,
            {
              clientId: p.clientId ?? "",
              // Never prefilled — the server does not send it.
              clientSecret: "",
              redirectUri: p.redirectUri ?? "",
              active: p.active,
            },
          ]),
        ),
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (provider) => {
    const draft = drafts[provider] ?? BLANK;
    const row = rows.find((r) => r.provider === provider);

    if (!draft.clientId.trim() || !draft.redirectUri.trim()) {
      toast.error("A client ID and a redirect URI are required.");
      return;
    }
    if (!row?.hasClientSecret && !draft.clientSecret) {
      toast.error("A client secret is required when first configuring a provider.");
      return;
    }

    setSavingProvider(provider);
    try {
      const saved = await settingsApi.saveSso({
        provider,
        clientId: draft.clientId.trim(),
        // Omitted entirely when blank: an empty string would be a rotation to
        // nothing, which the server would reject.
        ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
        redirectUri: draft.redirectUri.trim(),
        active: draft.active,
      });
      setRows((current) => current.map((r) => (r.provider === provider ? saved : r)));
      setDrafts((c) => ({ ...c, [provider]: { ...c[provider], clientSecret: "" } }));
      toast.success(`${SSO_PROVIDER_LABELS[provider] ?? provider} saved.`);
    } catch (err) {
      toast.error(err?.message ?? "That provider could not be saved.");
    } finally {
      setSavingProvider(null);
    }
  };

  if (error) {
    return <ErrorState title="SSO could not be loaded" description={error.message} onRetry={load} />;
  }

  if (loading) {
    return <div data-testid="sso-skeleton" className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  }

  const set = (provider, patch) =>
    setDrafts((c) => ({ ...c, [provider]: { ...(c[provider] ?? BLANK), ...patch } }));

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" aria-hidden="true" />
        <p className="text-sm text-slate-700">
          These providers are <strong>stored but not yet wired to sign-in</strong> — saving
          one does not change how anybody logs in today. The configuration is kept so the
          sign-in flow has it when that lands.
        </p>
      </div>

      {rows.map((row) => {
        const draft = drafts[row.provider] ?? BLANK;
        const label = SSO_PROVIDER_LABELS[row.provider] ?? row.provider;

        return (
          <section key={row.provider} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <ShieldCheck className="h-4 w-4 text-slate-400" aria-hidden="true" />
                {label}
              </h3>
              {row.active ? (
                <Badge variant="success">Enabled</Badge>
              ) : (
                <Badge variant="neutral">Disabled</Badge>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label
                  htmlFor={`${row.provider}-client-id`}
                  className="mb-1 block text-sm font-medium text-slate-700"
                >
                  Client ID
                </label>
                <Input
                  id={`${row.provider}-client-id`}
                  value={draft.clientId}
                  onChange={(e) => set(row.provider, { clientId: e.target.value })}
                  maxLength={500}
                />
              </div>

              <div>
                <label
                  htmlFor={`${row.provider}-client-secret`}
                  className="mb-1 block text-sm font-medium text-slate-700"
                >
                  Client secret
                </label>
                <Input
                  id={`${row.provider}-client-secret`}
                  type="password"
                  autoComplete="new-password"
                  value={draft.clientSecret}
                  onChange={(e) => set(row.provider, { clientSecret: e.target.value })}
                  placeholder={row.hasClientSecret ? "Stored — leave blank to keep" : "Required"}
                />
                <p className="mt-1 text-xs text-slate-500">
                  {row.hasClientSecret
                    ? "A secret is stored. It is never sent back to this page."
                    : "Not configured yet."}
                </p>
              </div>

              <div>
                <label
                  htmlFor={`${row.provider}-redirect`}
                  className="mb-1 block text-sm font-medium text-slate-700"
                >
                  Redirect URI
                </label>
                <Input
                  id={`${row.provider}-redirect`}
                  value={draft.redirectUri}
                  onChange={(e) => set(row.provider, { redirectUri: e.target.value })}
                  placeholder="https://…"
                  maxLength={2000}
                />
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => set(row.provider, { active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Enable this provider
              </label>

              <Button
                type="button"
                size="sm"
                disabled={savingProvider === row.provider}
                onClick={() => save(row.provider)}
              >
                {savingProvider === row.provider ? "Saving…" : `Save ${label}`}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default SsoTab;
