import { useCallback, useEffect, useState } from "react";

import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Drawer } from "../../../components/ui/Drawer";
import { HrmsPageLayout } from "../../../components/hrms/HrmsPageLayout";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { HRMS_ROUTE_PREFIX } from "@shared/constants/hrms.js";
import { auditApi, formatAuditAction } from "../../../services/hrms/settings";
import { formatInstant } from "../../../services/hrms";

/**
 * Audit Logs.
 *
 * The reference's own page — filters, a table, and a row-click detail view —
 * over the audit trail this codebase already writes. Its own nav entry and its
 * own permission, as in the reference: `audit-logs:view:org` reaches
 * super_admin, hr_admin and auditor, while Settings reaches only the first.
 *
 * The reference's detail modal renders the raw request payload it captured.
 * That is how its hr_admin and auditor can read SSO client secrets and
 * integration API keys — credentials their role is explicitly not permitted to
 * see. What arrives here has been redacted on the server, and the screen says
 * so rather than presenting a blanked field as if the value were simply absent.
 */

const PAGE_SIZE = 25;

const METHOD_VARIANT = {
  POST: "success",
  PATCH: "primary",
  PUT: "primary",
  DELETE: "danger",
  GET: "neutral",
  SYSTEM_JOB: "warning",
};

export function AuditLogsPage() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [result, setResult] = useState({ data: [], total: 0 });
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (action) params.action = action;
      if (from) params.from = from;
      if (to) params.to = to;
      setResult(await auditApi.list(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, action, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    auditApi
      .actions()
      .then((rows) => setActions(Array.isArray(rows) ? rows : []))
      // A filter that cannot load its options must not fail the page: the
      // unfiltered trail is still correct, and this is the screen most likely
      // to be open during an incident.
      .catch(() => setActions([]));
  }, []);

  const columns = [
    {
      header: "When",
      className: "w-44",
      cell: (row) => (
        <div className="leading-tight">
          <div>{formatInstant(row.createdAt)}</div>
          <div className="text-xs text-slate-400">
            {new Date(row.createdAt).toLocaleTimeString()}
          </div>
        </div>
      ),
    },
    {
      header: "Actor",
      className: "w-44",
      cell: (row) => row.actorName ?? <span className="text-slate-400">System</span>,
    },
    {
      header: "Method",
      className: "w-28",
      cell: (row) =>
        row.method ? (
          <Badge variant={METHOD_VARIANT[row.method] ?? "neutral"}>{row.method}</Badge>
        ) : (
          "—"
        ),
    },
    {
      header: "Action",
      accessorKey: "action",
      cell: (row) => (
        <div className="leading-tight">
          <div className="font-medium text-slate-900">{formatAuditAction(row.action)}</div>
          <div className="font-mono text-xs text-slate-400">{row.action}</div>
        </div>
      ),
    },
    {
      header: "",
      className: "w-24",
      cell: (row) => (
        <Button size="xs" variant="secondary" onClick={() => setSelected(row)}>
          Details
        </Button>
      ),
    },
  ];

  const selectClass =
    "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700";

  return (
    <HrmsPageLayout
      title="Audit Logs"
      subtitle="Every recorded change across HRMS. Credentials are redacted before they leave the server."
      breadcrumbs={[
        { label: "HRMS", to: `${HRMS_ROUTE_PREFIX}/dashboard` },
        { label: "Audit Logs" },
      ]}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <label htmlFor="audit-action" className="sr-only">
            Filter by action
          </label>
          <select
            id="audit-action"
            className={selectClass}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {formatAuditAction(a)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="audit-from" className="sr-only">
            From date
          </label>
          <input
            id="audit-from"
            type="date"
            className={selectClass}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>

        <div>
          <label htmlFor="audit-to" className="sr-only">
            To date
          </label>
          <input
            id="audit-to"
            type="date"
            className={selectClass}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {(action || from || to) && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAction("");
              setFrom("");
              setTo("");
              setPage(1);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <HrmsDataTable
        columns={columns}
        rows={result.data ?? []}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        rowKey={(row) => row.id}
        emptyTitle="No matching audit entries"
        emptyDescription="Nothing has been recorded for these filters."
      />

      <Drawer
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? formatAuditAction(selected.action) : ""}
        maxWidth="max-w-xl"
      >
        {selected && (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Actor">{selected.actorName ?? "System"}</Field>
              <Field label="When">{formatInstant(selected.createdAt)}</Field>
              <Field label="Action">
                <span className="font-mono text-xs">{selected.action}</span>
              </Field>
              <Field label="Method">{selected.method ?? "—"}</Field>
              <Field label="Endpoint" wide>
                <span className="break-all font-mono text-xs">{selected.endpoint ?? "—"}</span>
              </Field>
              <Field label="IP address">{selected.ipAddress ?? "—"}</Field>
            </dl>

            {selected.remarks && (
              <div>
                <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Summary
                </h4>
                <p className="mt-1 text-sm text-slate-800">{selected.remarks}</p>
              </div>
            )}

            <div>
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Detail
              </h4>
              <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-slate-50 p-3 text-xs text-slate-800">
                {JSON.stringify(selected.meta ?? {}, null, 2)}
              </pre>
              <p className="mt-1 text-xs text-slate-500">
                Any credential is shown as <code>[redacted]</code> — it is removed on the
                server, so it never reaches this page.
              </p>
            </div>
          </div>
        )}
      </Drawer>
    </HrmsPageLayout>
  );
}

function Field({ label, children, wide = false }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export default AuditLogsPage;
