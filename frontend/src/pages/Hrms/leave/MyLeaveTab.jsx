import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import toast from "react-hot-toast";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { ConfirmationDialog } from "../../../components/ui/ConfirmationDialog";
import { ApplyLeaveDrawer } from "./ApplyLeaveDrawer";
import { LeaveStatusBadge, LeaveRange, LeaveDuration, LeaveTypeChip } from "./leaveShared";
import { leaveApi, holidaysApi, HrmsApiError, formatDays } from "../../../services/hrms";

/**
 * My Leave — balances, own requests, and the way in to applying.
 *
 * Three reads, once, on mount: types, balances and requests. The types and
 * holidays are handed to the apply drawer rather than re-fetched by it, so
 * opening the form costs nothing.
 */

const UNPAGINATED = 1000;

/** One entitlement bucket. */
function BalanceCard({ balance }) {
  const overdrawn = balance.balance < 0;
  return (
    <Card className="flex flex-col gap-1 p-4">
      <div className="flex items-baseline justify-between">
        <LeaveTypeChip code={balance.code} name={balance.leaveTypeName} color={balance.color} />
        <span
          className={`text-xl font-bold ${overdrawn ? "text-error-600" : "text-slate-900"}`}
          title={overdrawn ? "More has been approved than was accrued" : undefined}
        >
          {balance.balance}
        </span>
      </div>
      <p className="text-xs text-slate-500">{balance.leaveTypeName}</p>
      <dl className="mt-1 flex gap-4 text-[11px] text-slate-500">
        <span>
          <dt className="inline font-semibold text-slate-600">Accrued</dt>{" "}
          <dd className="inline">{balance.accrued}</dd>
        </span>
        <span>
          <dt className="inline font-semibold text-slate-600">Used</dt>{" "}
          <dd className="inline">{balance.used}</dd>
        </span>
        <span>
          <dt className="inline font-semibold text-slate-600">Pending</dt>{" "}
          <dd className="inline">{balance.pending}</dd>
        </span>
      </dl>
    </Card>
  );
}

export function MyLeaveTab() {
  const [requests, setRequests] = useState([]);
  const [balances, setBalances] = useState([]);
  const [types, setTypes] = useState([]);
  const [holidays, setHolidays] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The request list is the only one that must succeed; the rest enrich it.
      const [list, myBalances, leaveTypes, holidayList] = await Promise.all([
        leaveApi.requests(),
        leaveApi.myBalances().catch(() => []),
        leaveApi.types().catch(() => []),
        holidaysApi.list(new Date().getFullYear()).catch(() => []),
      ]);
      setRequests(list);
      setBalances(myBalances);
      setTypes(leaveTypes);
      setHolidays(holidayList);
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await leaveApi.cancel(confirm.id);
      toast.success("Request cancelled.");
      setConfirm(null);
      await load();
    } catch (err) {
      toast.error(err.message ?? "Could not cancel the request.");
      setConfirm(null);
    } finally {
      setCancelling(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        header: "Type",
        accessorKey: "leaveTypeCode",
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
      { header: "Duration", className: "w-56", cell: (row) => <LeaveDuration request={row} /> },
      { header: "Reason", cell: (row) => <span className="text-slate-600">{row.reason}</span> },
      {
        header: "Status",
        accessorKey: "status",
        className: "w-32",
        cell: (row) => <LeaveStatusBadge status={row.status} />,
      },
      {
        header: "",
        className: "w-28 text-right",
        cell: (row) =>
          // Only a pending request can be withdrawn, and only by its owner —
          // which this tab only ever shows.
          row.status === "pending" ? (
            <Button variant="ghost" onClick={() => setConfirm(row)} className="text-slate-500">
              Cancel
            </Button>
          ) : null,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-xl text-xs text-slate-500">
          Weekends and holidays are only charged when they fall between two full days of leave.
        </p>
        <Button onClick={() => setApplyOpen(true)}>
          <Plus size={15} className="mr-1.5" />
          Apply for leave
        </Button>
      </div>

      {balances.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {balances.map((balance) => (
            <BalanceCard key={balance.leaveTypeId} balance={balance} />
          ))}
        </div>
      )}

      {!loading && !error && balances.length === 0 && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          No leave entitlement has been set up for you yet. You can still request leave — it will be
          recorded and approved as usual.
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={requests}
        loading={loading}
        error={error}
        onRetry={load}
        total={requests.length}
        pageSize={UNPAGINATED}
        emptyTitle="No leave requests yet"
        emptyDescription="Everything you apply for will appear here, with its status."
      />

      <ApplyLeaveDrawer
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        onCreated={async () => {
          setApplyOpen(false);
          await load();
        }}
        types={types}
        holidays={holidays}
      />

      <ConfirmationDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={cancel}
        loading={cancelling}
        variant="danger"
        title="Cancel this request?"
        description={
          confirm
            ? `${formatDays(confirm.durationValue)} of ${confirm.leaveTypeCode} will be released back to your balance. Your manager will no longer see it for approval.`
            : ""
        }
        confirmText="Cancel request"
        cancelText="Keep it"
      />
    </div>
  );
}

export default MyLeaveTab;
