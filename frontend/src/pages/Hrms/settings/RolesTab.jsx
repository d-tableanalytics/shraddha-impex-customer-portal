import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Info } from "lucide-react";

import { Badge } from "../../../components/ui/Badge";
import { ErrorState } from "../../../components/hrms/ErrorState";
import { settingsApi } from "../../../services/hrms/settings";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";

/**
 * Roles & Permissions — a viewer, not an editor.
 *
 * The reference ships a custom-role builder here: a drawer with a key, a label
 * and a 19 x 7 x 4 grid of permission checkboxes, writing `Role` /
 * `RolePermission` rows. Its authorization really is database-driven — the
 * actor loader reads permissions from those tables — so its checkboxes do what
 * they appear to do.
 *
 * Shraddha's do not exist to be edited. AD-3 fixes eight HRMS roles and every
 * module resolves permissions from the code matrix at request time, so the same
 * grid here would be 532 controls that grant nothing. A settings screen whose
 * controls do not affect the system is worse than one that admits it cannot.
 *
 * So this shows what is true: the eight roles, their real permissions, how many
 * people hold each, and where role membership IS changed.
 */

export function RolesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openRole, setOpenRole] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await settingsApi.roles());
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
      <ErrorState title="Roles could not be loaded" description={error.message} onRetry={load} />
    );
  }

  if (loading) {
    return <div data-testid="roles-skeleton" className="h-64 animate-pulse rounded-lg bg-slate-100" />;
  }

  const roles = data?.roles ?? [];
  const selected = roles.find((r) => r.key === openRole) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        <p className="text-sm text-slate-600">
          These eight roles and their permissions are defined in code, so they are the
          same in every environment and cannot drift. To change what somebody can do,
          change which roles they hold on{" "}
          <Link
            to={`${HRMS_ROUTE_PREFIX}/employees`}
            className="font-medium text-primary-700 underline"
          >
            their employee record
          </Link>
          .
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Role</th>
              <th scope="col" className="px-4 py-2 font-medium">Key</th>
              <th scope="col" className="px-4 py-2 font-medium">Defined</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">People</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Permissions</th>
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {roles.map((role) => (
              <tr key={role.key}>
                <td className="px-4 py-2 font-medium text-slate-900">{role.label}</td>
                <td className="px-4 py-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                    {role.key}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Badge variant="neutral">In code</Badge>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{role.userCount}</td>
                <td className="px-4 py-2 text-right tabular-nums">{role.permissions.length}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    className="text-sm font-medium text-primary-700 hover:underline"
                    onClick={() => setOpenRole(openRole === role.key ? null : role.key)}
                  >
                    {openRole === role.key ? "Hide" : "View"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">
            {selected.label} — {selected.permissions.length} permissions
          </h3>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Module</th>
                  <th scope="col" className="px-3 py-2 font-medium">Action</th>
                  <th scope="col" className="px-3 py-2 font-medium">Scope</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...selected.permissions]
                  .sort(
                    (a, b) =>
                      a.module.localeCompare(b.module) || a.action.localeCompare(b.action),
                  )
                  .map((p) => (
                    <tr key={`${p.module}|${p.action}|${p.scope}`}>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-700">{p.module}</td>
                      <td className="px-3 py-1.5">{p.action}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={p.scope === "org" ? "primary" : "neutral"}>{p.scope}</Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            A wider scope satisfies a narrower one — an <code>org</code> grant also passes a
            <code> team</code> or <code>self</code> check.
          </p>
        </section>
      )}
    </div>
  );
}

export default RolesTab;
