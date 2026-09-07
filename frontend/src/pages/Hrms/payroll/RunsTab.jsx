import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Lock, Banknote, Undo2, Plus } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { Input } from "../../../components/ui/Input";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { payrollRunsApi, payGroupsApi } from "../../../services/hrms";
import { formatMoney, formatPeriod, MONTH_NAMES } from "../../../services/hrms/payroll";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

const STATUS_TONES = {
  draft: "neutral",
  review: "primary",
  locked: "warning",
  disbursed: "success",
};

/**
 * Which actions a run in this state offers.
 *
 * Mirrors the server's declared state machine exactly. The UI showing a button
 * is a convenience — every transition is re-checked server-side against
 * `RUN_TRANSITIONS`, so a stale page whose run has moved on gets a 409 rather
 * than a wrong transition.
 */
const ACTIONS_FOR = {
  draft: ["compute"],
  review: ["compute", "lock", "rollback"],
  locked: ["disburse"],
  disbursed: [],
};

const ACTION_META = {
  compute: { label: "Compute", icon: Play, variant: "primary" },
  lock: { label: "Lock", icon: Lock, variant: "primary" },
  disburse: { label: "Mark disbursed", icon: Banknote, variant: "primary" },
  rollback: { label: "Roll back", icon: Undo2, variant: "secondary" },
};

/**
 * Payroll runs — the admin's month-by-month workspace.
 *
 * The reference's Runs tab: a table of runs with their totals and the actions
 * their state allows.
 *
 * Locking and disbursing are CONFIRMED before they are sent. Both are one-way:
 * a locked run's payslips become visible to employees and can never be
 * recomputed, and the reference fires both straight from a table button with no
 * confirmation at all.
 */
export function RunsTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 25 });
  const [payGroups, setPayGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runs, groups] = await Promise.all([
        payrollRunsApi.list({ page, pageSize: 25 }),
        payGroupsApi.list(),
      ]);
      setResult(runs ?? { data: [], total: 0 });
      setPayGroups(groups ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (run, action) => {
    setBusy(run.id);
    setFailure(null);
    setNotice(null);
    try {
      const res = await payrollRunsApi[action](run.id);
      if (action === "compute") {
        const skipped = res?.skipped ?? [];
        setNotice(
          `Computed ${res?.payslipsGenerated ?? 0} payslip(s)` +
            // Somebody skipped is somebody who is not being paid this month.
            // That must be visible before the run is locked.
            (skipped.length > 0
              ? ` — ${skipped.length} employee(s) were skipped: ${skipped
                  .map((s) => s.reason)
                  .join("; ")}`
              : "."),
        );
      }
      await load();
    } catch (err) {
      setFailure(err?.message ?? "That action could not be completed.");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const request = useCallback((run, action) => {
    // One-way transitions are confirmed; recompute and rollback are not, since
    // both are reversible while the run is still in review.
    if (action === "lock" || action === "disburse") setConfirm({ run, action });
    else act(run, action);
    // `act` is stable enough for this purpose: it closes only over `load`,
    // which is itself memoised on `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const columns = useMemo(
    () => [
      {
        header: "Period",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => formatPeriod(row.month, row.year),
      },
      {
        header: "Pay group",
        className: CELL,
        headerClassName: HEAD,
        cell: (row) => row.payGroupName ?? "—",
      },
      {
        header: "Status",
        className: `${CELL} w-[110px]`,
        headerClassName: HEAD,
        cell: (row) => <Badge variant={STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>,
      },
      {
        header: "Headcount",
        className: `${CELL} w-[100px] text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => row.totals.headcount ?? 0,
      },
      {
        header: "Gross",
        className: `${CELL} text-right tabular-nums`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => `₹ ${formatMoney(row.totals.gross)}`,
      },
      {
        header: "Net pay",
        className: `${CELL} text-right tabular-nums font-semibold`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => `₹ ${formatMoney(row.totals.netPay)}`,
      },
      {
        header: "",
        className: `${CELL} w-[280px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <div className="flex flex-wrap gap-1.5">
            {(ACTIONS_FOR[row.status] ?? []).map((action) => {
              const meta = ACTION_META[action];
              const Icon = meta.icon;
              return (
                <Button
                  key={action}
                  size="xs"
                  variant={meta.variant}
                  loading={busy === row.id}
                  onClick={() => request(row, action)}
                >
                  <Icon size={12} className="mr-1" />
                  {meta.label}
                </Button>
              );
            })}
          </div>
        ),
      },
    ],
    [busy, request],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Draft → compute → review → lock → disbursed. A locked run is final.
        </p>
        <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} className="mr-1.5" />
          New run
        </Button>
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
          {notice}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? 25}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No payroll runs yet"
        emptyDescription="Open a run for a pay group and month to begin."
      />

      <ConfirmDialog
        request={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act(confirm.run, confirm.action)}
        busy={Boolean(busy)}
      />

      <CreateRunDialog
        open={createOpen}
        payGroups={payGroups}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          load();
        }}
      />
    </div>
  );
}

function ConfirmDialog({ request, onCancel, onConfirm, busy }) {
  if (!request) return null;
  const { run, action } = request;
  const locking = action === "lock";

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={locking ? "Lock this payroll run?" : "Mark this run disbursed?"}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 leading-relaxed">
          {locking ? (
            <>
              Locking <strong>{formatPeriod(run.month, run.year)}</strong> makes its{" "}
              {run.totals.headcount} payslip(s) visible to employees and final. It cannot be
              recomputed or rolled back afterwards.
            </>
          ) : (
            <>
              This records that <strong>{formatPeriod(run.month, run.year)}</strong> has been paid
              out. A disbursed run can no longer be changed in any way.
            </>
          )}
        </p>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            {locking ? "Lock run" : "Mark disbursed"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateRunDialog({ open, payGroups, onClose, onCreated }) {
  const now = new Date();
  const [payGroupId, setPayGroupId] = useState(null);
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [year, setYear] = useState(now.getUTCFullYear());
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null);
    if (!payGroupId) {
      setFailure("Choose a pay group.");
      return;
    }
    setSubmitting(true);
    try {
      await payrollRunsApi.create({ payGroupId, month: Number(month), year: Number(year) });
      onCreated();
    } catch (err) {
      setFailure(err?.message ?? "The run could not be created.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Open a payroll run" size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-700">Pay group</label>
          <SearchableSelect
            value={payGroupId}
            onChange={setPayGroupId}
            options={payGroups.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))}
            placeholder="Select a pay group"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-700" htmlFor="run-month">
            Month
          </label>
          <select
            id="run-month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg shadow-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          >
            {MONTH_NAMES.slice(1).map((name, index) => (
              <option key={name} value={index + 1}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <Input
          type="number"
          label="Year"
          aria-label="Year"
          value={year}
          min={2000}
          max={2100}
          onChange={(e) => setYear(e.target.value)}
        />

        {failure && (
          <p role="alert" className="text-xs text-error-500 font-medium">
            {failure}
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Create run
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default RunsTab;
