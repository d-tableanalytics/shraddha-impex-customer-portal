import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { FileText, Loader2 } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Drawer } from "../../../components/ui/Drawer";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import {
  exitsApi,
  employeesApi,
  formatDay,
  formatInstant,
  EXIT_STATUS_LABELS,
  EXIT_REASON_LABELS,
  CLEARANCE_AREA_LABELS,
} from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import {
  ExitStatusBadge,
  ClearanceStatusBadge,
  ExitProgress,
  Field,
} from "./exitsShared";
import { SettlementCard } from "./MyExitTab";

/**
 * Exit requests, for HR and reporting managers.
 *
 * The reference's `ExitRequestsTab`: a table, a Manage drawer, a card of
 * state-machine buttons each disabled off-status, a clearances editor and the
 * settlement.
 *
 * Its "state machine" card offers every button to everyone and lets the server
 * refuse; here a button a manager cannot use is not rendered, because the only
 * thing an always-failing control communicates is that the screen is broken.
 */

const PAGE_SIZE = 15;

export function ExitRequestsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { page, pageSize: PAGE_SIZE };
      if (status) params.status = status;
      setResult(await exitsApi.list(params));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = result.data ?? [];
  const detail = rows.find((row) => row.id === detailId) ?? null;

  const columns = [
    {
      header: "Employee",
      accessorKey: "employeeName",
      cell: (row) => <span className="font-medium text-slate-900">{row.employeeName}</span>,
    },
    {
      header: "Category",
      className: "w-32",
      cell: (row) => EXIT_REASON_LABELS[row.reasonCategory] ?? row.reasonCategory,
    },
    {
      header: "Requested LWD",
      className: "w-36",
      cell: (row) => formatDay(row.requestedLastDay),
    },
    {
      header: "Initiated",
      className: "w-32",
      cell: (row) => formatInstant(row.initiatedAt),
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-40",
      cell: (row) => <ExitStatusBadge status={row.status} />,
    },
    {
      header: "",
      className: "w-24",
      cell: (row) => (
        <Button size="sm" variant="secondary" onClick={() => setDetailId(row.id)}>
          Manage
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-4">
        <label htmlFor="exit-status-filter" className="sr-only">
          Filter by status
        </label>
        <select
          id="exit-status-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
        >
          <option value="">All statuses</option>
          {Object.entries(EXIT_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No exit requests"
        emptyDescription="Requests from the people you manage will appear here."
      />

      {detail && (
        <ExitDetailDrawer
          exit={detail}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function ExitDetailDrawer({ exit, onClose, onChanged }) {
  const { can } = useHrmsPermissions();
  const isHr = can(M.EXITS, A.EDIT, S.ORG);
  const [busy, setBusy] = useState(false);

  const act = async (run, done) => {
    setBusy(true);
    try {
      await run();
      toast.success(done);
      await onChanged();
      onClose();
    } catch (err) {
      toast.error(err?.message ?? "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  const viewLetter = async () => {
    setBusy(true);
    try {
      const { url } = await exitsApi.relievingLetterUrl(exit.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err?.message ?? "That letter could not be opened.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Only the action that is actually available in this state, and only to
   * someone who may take it. The reference renders all six buttons always and
   * disables the ones that do not apply.
   */
  const actions = [];
  if (exit.status === "initiated" && !exit.isOwnExit) {
    actions.push({
      label: "Approve as manager",
      run: () => exitsApi.managerApprove(exit.id),
      done: "Exit approved.",
    });
  }
  if (isHr && exit.status === "manager_approved" && !exit.isOwnExit) {
    actions.push({
      label: "HR approve — start notice",
      run: () => exitsApi.hrApprove(exit.id),
      done: "Approved. The employee is now on notice.",
    });
  }
  if (isHr && exit.status === "in_notice") {
    actions.push({
      label: "Open clearances",
      run: () => exitsApi.openClearances(exit.id),
      done: "Clearances opened.",
    });
  }
  if (isHr && exit.status === "cleared") {
    actions.push({
      label: "Compute settlement",
      run: () => exitsApi.createSettlement(exit.id),
      done: "Settlement computed.",
    });
  }
  if (isHr && exit.status === "f_and_f_pending") {
    actions.push({
      label: "Disburse and close",
      run: () => exitsApi.disburseSettlement(exit.id),
      done: "Settlement disbursed and the exit is closed.",
    });
  }
  if (isHr && exit.status === "closed" && !exit.relievingLetter) {
    actions.push({
      label: "Generate relieving letter",
      run: () => exitsApi.generateRelievingLetter(exit.id),
      done: "Relieving letter generated.",
    });
  }
  if (isHr && !["closed", "cancelled"].includes(exit.status)) {
    actions.push({
      label: "Withdraw exit",
      variant: "danger",
      run: () => exitsApi.cancel(exit.id),
      done: "Exit withdrawn.",
    });
  }

  return (
    <Drawer
      isOpen
      onClose={busy ? () => {} : onClose}
      title={`Exit — ${exit.employeeName}`}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <ExitStatusBadge status={exit.status} />
          {exit.isOwnExit && (
            <span className="text-xs text-slate-500">This is your own exit.</span>
          )}
        </div>

        <div className="overflow-x-auto">
          <ExitProgress status={exit.status} />
        </div>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category">
            {EXIT_REASON_LABELS[exit.reasonCategory] ?? exit.reasonCategory}
          </Field>
          <Field label="Requested last day">{formatDay(exit.requestedLastDay)}</Field>
          <Field label="Actual last day">
            {exit.actualLastDay ? formatDay(exit.actualLastDay) : null}
          </Field>
          <Field label="Initiated">{formatInstant(exit.initiatedAt)}</Field>
          <Field label="Manager approved">{formatInstant(exit.managerApprovedAt)}</Field>
          <Field label="HR approved">{formatInstant(exit.hrApprovedAt)}</Field>
          <Field label="Reason" wide>
            {exit.reason}
          </Field>
        </dl>

        {actions.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Next step
            </h4>
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action.label}
                  size="sm"
                  variant={action.variant ?? "primary"}
                  disabled={busy}
                  onClick={() => act(action.run, action.done)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {exit.relievingLetter && (
          <div className="flex items-center justify-between rounded-lg border border-primary-200 bg-primary-50 px-4 py-3">
            <span className="text-sm text-primary-700">
              Relieving letter generated {formatInstant(exit.relievingLetter.generatedAt)}.
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={viewLetter}>
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              )}
              View letter
            </Button>
          </div>
        )}

        {isHr && <HandoverEditor exit={exit} onChanged={onChanged} />}

        {exit.clearances.length > 0 && (
          <ClearancesEditor exit={exit} onChanged={onChanged} />
        )}

        {isHr && exit.status === "cleared" && !exit.fullAndFinal && (
          <SettlementPreview exitId={exit.id} />
        )}
        {exit.fullAndFinal && <SettlementCard fnf={exit.fullAndFinal} />}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Handover — the architecture boundary
// ---------------------------------------------------------------------------

/**
 * Who picks the work up, and the notes that go with it.
 *
 * This pair IS the handover record. The reference additionally notifies the
 * project manager of every project the leaver belongs to; Projects are outside
 * this system's scope (AD-5), so there is no project handover to fake — the
 * replacement and the notes are what the reference itself stores on the request.
 */
function HandoverEditor({ exit, onChanged }) {
  const [form, setForm] = useState({
    actualLastDay: exit.actualLastDay ?? "",
    replacementEmployeeId: exit.replacementEmployeeId ?? "",
    transferNotes: exit.transferNotes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState([]);

  // The picker takes a list, so load one — excluding the leaver, who cannot be
  // their own replacement (the server refuses it too).
  useEffect(() => {
    let cancelled = false;
    employeesApi
      .list({ pageSize: 100, status: "active" })
      .then((page) => {
        if (cancelled) return;
        setPeople(
          (page.data ?? [])
            .filter((row) => row.id !== exit.employeeId)
            .map((row) => ({
              value: row.id,
              label: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [exit.employeeId]);

  const readOnly = ["closed", "cancelled"].includes(exit.status);

  const save = async () => {
    setSaving(true);
    try {
      await exitsApi.update(exit.id, {
        actualLastDay: form.actualLastDay || null,
        replacementEmployeeId: form.replacementEmployeeId || null,
        transferNotes: form.transferNotes.trim() || null,
      });
      toast.success("Handover details saved.");
      await onChanged();
    } catch (err) {
      toast.error(err?.message ?? "Those details could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-900">Handover</h4>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Handed over to">{exit.replacementEmployeeName}</Field>
          <Field label="Actual last day">
            {exit.actualLastDay ? formatDay(exit.actualLastDay) : null}
          </Field>
          <Field label="Notes" wide>
            {exit.transferNotes}
          </Field>
        </dl>
        <p className="mt-2 text-xs text-slate-500">
          A {exit.status} exit can no longer be edited.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h4 className="mb-3 text-sm font-semibold text-slate-900">Handover</h4>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="handover-last-day"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Actual last working day
          </label>
          <Input
            id="handover-last-day"
            type="date"
            value={form.actualLastDay}
            onChange={(e) => setForm((c) => ({ ...c, actualLastDay: e.target.value }))}
          />
        </div>

        <div>
          <SearchableSelect
            label="Handing over to"
            value={form.replacementEmployeeId || null}
            onChange={(value) =>
              setForm((c) => ({ ...c, replacementEmployeeId: value ?? "" }))
            }
            options={people}
            placeholder="Select an employee…"
          />
        </div>

        <div className="sm:col-span-2">
          <label
            htmlFor="handover-notes"
            className="mb-1 block text-xs font-medium text-slate-600"
          >
            Transfer notes
          </label>
          <textarea
            id="handover-notes"
            rows={3}
            maxLength={4000}
            value={form.transferNotes}
            onChange={(e) => setForm((c) => ({ ...c, transferNotes: e.target.value }))}
            placeholder="What is being handed over, and to whom?"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Button size="sm" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save handover"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clearances
// ---------------------------------------------------------------------------

function ClearancesEditor({ exit, onChanged }) {
  const { can } = useHrmsPermissions();
  const isHr = can(M.EXITS, A.EDIT, S.ORG);
  const [busyId, setBusyId] = useState(null);

  const open = exit.status === "clearance_pending";

  const change = async (clearance, status) => {
    setBusyId(clearance.id);
    try {
      await exitsApi.updateClearance(exit.id, clearance.id, { status });
      toast.success("Clearance updated.");
      await onChanged();
    } catch (err) {
      toast.error(err?.message ?? "That clearance could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h4 className="mb-3 text-sm font-semibold text-slate-900">Clearances</h4>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 font-semibold">Area</th>
            <th className="py-2 font-semibold">Assignee</th>
            <th className="py-2 font-semibold">Status</th>
            <th className="py-2 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {exit.clearances.map((clearance) => {
            const done = ["completed", "waived"].includes(clearance.status);
            return (
              <tr key={clearance.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 font-medium text-slate-700">
                  {CLEARANCE_AREA_LABELS[clearance.area] ?? clearance.area}
                </td>
                <td className="py-2 text-slate-600">
                  {clearance.assigneeName ?? (
                    <span className="text-warning-600">Unassigned</span>
                  )}
                </td>
                <td className="py-2">
                  <ClearanceStatusBadge status={clearance.status} />
                </td>
                <td className="py-2 text-right">
                  {/*
                    Only HR gets controls here, and only while clearances are
                    open. An assignee works their own from the Clearance Queue
                    tab. The reference shows a Waive button to every viewer,
                    which is a guaranteed 403 for anyone but the assignee or HR.
                  */}
                  {isHr && open && !done && !exit.isOwnExit && (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busyId === clearance.id}
                        onClick={() => change(clearance, "waived")}
                      >
                        Waive
                      </Button>
                      <Button
                        size="xs"
                        disabled={busyId === clearance.id}
                        onClick={() => change(clearance, "completed")}
                      >
                        Mark done
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlement preview
// ---------------------------------------------------------------------------

/**
 * What the settlement would be, before it is committed.
 *
 * Safe to fetch on open: the endpoint only reads. The reference's equivalent
 * preview shares its computation with the create path, and that computation
 * zeroes the employee's loan balances — so merely opening its drawer destroys
 * data.
 */
function SettlementPreview({ exitId }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    exitsApi
      .previewSettlement(exitId)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [exitId]);

  if (loading) return null;
  if (!preview) return null;

  if (!preview.computable) {
    return (
      <div className="rounded-lg border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-600">
        {preview.notes?.[0] ?? "This settlement cannot be computed yet."}
      </div>
    );
  }

  return (
    <div>
      <SettlementCard fnf={{ ...preview, disbursedAt: null }} title="Settlement preview" />
      {preview.notes?.length > 0 && (
        <ul className="mt-2 space-y-1">
          {preview.notes.map((note) => (
            <li key={note} className="text-xs text-slate-500">
              {note}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Nothing is saved until you compute the settlement.
      </p>
    </div>
  );
}

export default ExitRequestsTab;
