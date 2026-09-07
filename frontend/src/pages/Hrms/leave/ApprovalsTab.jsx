import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Button } from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";
import { LeaveRange, LeaveDuration, LeaveTypeChip } from "./leaveShared";
import { leaveApi, HrmsApiError, formatDays } from "../../../services/hrms";

/**
 * Approvals — what this actor is being asked to decide.
 *
 * The list is the SERVER's answer to "what may you see": a manager gets their
 * own and their direct reports, HR gets everyone. Nothing is filtered here, so
 * the queue cannot show a row the caller has no business seeing.
 *
 * Deciding is likewise the server's call. The button is offered on every
 * pending row this actor can see, and a refusal comes back as a 403 with the
 * reason — a skip-level manager can see a request and cannot act on it, and
 * pretending otherwise in the browser would only hide why.
 */

const UNPAGINATED = 1000;

export function ApprovalsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  /** `{ request, decision }` while the comment is being written. */
  const [deciding, setDeciding] = useState(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await leaveApi.requests({ status: "pending" }));
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = (request, decision) => {
    setComment("");
    setDeciding({ request, decision });
  };

  const submit = async () => {
    setSaving(true);
    try {
      await leaveApi.decide(deciding.request.id, deciding.decision, comment || null);
      toast.success(deciding.decision === "approve" ? "Leave approved." : "Leave rejected.");
      setDeciding(null);
      await load();
    } catch (err) {
      // A 403 here is meaningful — "only the direct manager can decide" — so it
      // is shown rather than swallowed.
      toast.error(err.message ?? "Could not record the decision.");
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        header: "Employee",
        accessorKey: "employeeName",
        cell: (row) => (
          <div className="min-w-0">
            <div className="truncate font-semibold text-slate-900">{row.employeeName ?? "—"}</div>
            <div className="truncate text-xs text-slate-400">{row.employeeCode ?? ""}</div>
          </div>
        ),
      },
      {
        header: "Type",
        className: "w-28",
        cell: (row) => (
          <LeaveTypeChip code={row.leaveTypeCode} name={row.leaveTypeName} color={row.color} />
        ),
      },
      {
        header: "Dates",
        className: "w-56",
        cell: (row) => <LeaveRange startDate={row.startDate} endDate={row.endDate} />,
      },
      { header: "Duration", className: "w-52", cell: (row) => <LeaveDuration request={row} /> },
      { header: "Reason", cell: (row) => <span className="text-slate-600">{row.reason}</span> },
      {
        header: "",
        className: "w-48 text-right",
        cell: (row) => {
          // The name alone is ambiguous: one person can have two requests
          // waiting, and two buttons reading "Approve leave for Priya" tell a
          // screen-reader user nothing about which is which.
          const which = `${row.employeeName} ${row.startDate}`;
          return (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => open(row, "reject")}
                aria-label={`Reject leave for ${which}`}
              >
                <X size={14} className="mr-1" />
                Reject
              </Button>
              <Button onClick={() => open(row, "approve")} aria-label={`Approve leave for ${which}`}>
                <Check size={14} className="mr-1" />
                Approve
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-xs text-slate-500">
        Requests waiting on a decision. Only a direct reporting manager can decide their own
        report&apos;s leave; HR can decide any request when a manager is unavailable.
      </p>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        total={rows.length}
        pageSize={UNPAGINATED}
        emptyTitle="Nothing waiting"
        emptyDescription="No leave requests need a decision from you right now."
      />

      <Modal
        isOpen={deciding !== null}
        onClose={saving ? () => {} : () => setDeciding(null)}
        title={deciding?.decision === "approve" ? "Approve this leave?" : "Reject this leave?"}
        size="sm"
      >
        {deciding && (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div className="font-semibold text-slate-900">{deciding.request.employeeName}</div>
              <div className="mt-0.5 text-xs text-slate-600">
                {formatDays(deciding.request.durationValue)} of {deciding.request.leaveTypeCode}
                {" · "}
                <LeaveRange
                  startDate={deciding.request.startDate}
                  endDate={deciding.request.endDate}
                />
              </div>
              <p className="mt-1 text-xs italic text-slate-500">“{deciding.request.reason}”</p>
            </div>

            <div>
              <label
                htmlFor="decision-comment"
                className="mb-1.5 block text-xs font-semibold text-slate-700"
              >
                Comment {deciding.decision === "reject" && <span className="text-slate-400">(recommended)</span>}
              </label>
              <textarea
                id="decision-comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  deciding.decision === "approve"
                    ? "Optional note for the employee"
                    : "Why the request is being turned down"
                }
                className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none placeholder-slate-400 focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              />
            </div>

            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setDeciding(null)} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant={deciding.decision === "approve" ? "primary" : "danger"}
                onClick={submit}
                loading={saving}
              >
                {deciding.decision === "approve" ? "Approve" : "Reject"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default ApprovalsTab;
