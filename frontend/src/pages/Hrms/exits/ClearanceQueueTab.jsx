import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";

import { Button } from "../../../components/ui/Button";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import {
  exitsApi,
  formatDay,
  CLEARANCE_AREA_LABELS,
} from "../../../services/hrms";
import { useHrmsStore } from "../../../store/hrmsStore";
import { ClearanceStatusBadge } from "./exitsShared";

/**
 * The clearances assigned to the signed-in employee, across every exit.
 *
 * The reference's `ClearanceQueueTab` builds this by downloading every exit
 * request it can see and looping over each one's clearances in the browser,
 * comparing `assigneeUserId === me.user.id`. The list endpoint here already
 * includes the requests where the caller owns a clearance — whatever their
 * scope otherwise is — so the flattening is all that is left to do.
 */

export function ClearanceQueueTab() {
  const actor = useHrmsStore((state) => state.actor);
  const myEmployeeId = actor?.employeeId ? String(actor.employeeId) : null;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Only exits that are actually awaiting clearance can be worked.
      const page = await exitsApi.list({ status: "clearance_pending", pageSize: 100 });

      const mine = [];
      for (const exit of page.data ?? []) {
        for (const clearance of exit.clearances ?? []) {
          const isMine =
            myEmployeeId && String(clearance.assigneeEmployeeId) === myEmployeeId;
          const outstanding = !["completed", "waived"].includes(clearance.status);
          // Never your own exit — the server refuses it, and offering the
          // buttons anyway would only produce a 403.
          if (isMine && outstanding && !exit.isOwnExit) {
            mine.push({
              id: clearance.id,
              exitId: exit.id,
              employeeName: exit.employeeName,
              lastDay: exit.actualLastDay ?? exit.requestedLastDay,
              area: clearance.area,
              status: clearance.status,
            });
          }
        }
      }
      setRows(mine);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [myEmployeeId]);

  useEffect(() => {
    load();
  }, [load]);

  const change = async (row, status, done) => {
    setBusyId(row.id);
    try {
      await exitsApi.updateClearance(row.exitId, row.id, { status });
      toast.success(done);
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That clearance could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      header: "Employee",
      accessorKey: "employeeName",
      cell: (row) => <span className="font-medium text-slate-900">{row.employeeName}</span>,
    },
    {
      header: "Area",
      className: "w-28",
      cell: (row) => CLEARANCE_AREA_LABELS[row.area] ?? row.area,
    },
    {
      header: "Last working day",
      className: "w-40",
      cell: (row) => formatDay(row.lastDay),
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-32",
      cell: (row) => <ClearanceStatusBadge status={row.status} />,
    },
    {
      header: "",
      className: "w-56",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          {row.status === "pending" && (
            <Button
              size="xs"
              variant="secondary"
              disabled={busyId === row.id}
              onClick={() => change(row, "in_progress", "Marked in progress.")}
            >
              Start
            </Button>
          )}
          <Button
            size="xs"
            variant="secondary"
            disabled={busyId === row.id}
            onClick={() => change(row, "waived", "Clearance waived.")}
          >
            Waive
          </Button>
          <Button
            size="xs"
            disabled={busyId === row.id}
            onClick={() => change(row, "completed", "Clearance completed.")}
          >
            Mark done
          </Button>
        </div>
      ),
    },
  ];

  return (
    <HrmsDataTable
      columns={columns}
      rows={rows}
      loading={loading}
      error={error}
      onRetry={load}
      emptyTitle="Nothing awaiting you"
      emptyDescription="Clearances assigned to you for a departing colleague will appear here."
    />
  );
}

export default ClearanceQueueTab;
