import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ChevronRight, ChevronDown } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { expensesApi, formatInstant } from "../../../services/hrms";
import { useHrmsPermissions } from "../../../hooks/useHrmsPermissions";
import {
  HRMS_MODULES as M,
  HRMS_ACTIONS as A,
  SCOPES as S,
} from "@shared/permissions/constants.js";
import { ClaimStatusBadge, Money } from "./expensesShared";
import { ClaimLines } from "./ClaimLines";

/**
 * Claims waiting on this approver.
 *
 * The reference's `ApprovalQueue`. Two differences:
 *
 *   1. THE QUEUE IS FETCHED, NOT FILTERED. The reference pulls every claim and
 *      keeps the submitted and manager-approved ones in the browser. Here the
 *      status filter is a query parameter on an already-scoped endpoint, so a
 *      manager's queue contains their reports and nobody else's.
 *
 *   2. REIMBURSE IS OFFERED HERE. The reference exposes it only through a
 *      reimbursement batch, which is driven by a payroll run and is not part of
 *      this module. Without it a finance-approved claim would have nowhere to
 *      go, so the single-claim action the API already supports is surfaced.
 *
 * A claim of the approver's own never appears with buttons: the server refuses
 * self-approval outright, and offering a control that always fails is worse
 * than not offering it.
 */

const PAGE_SIZE = 15;

/** The two statuses that are waiting on somebody. */
const PENDING = ["submitted", "manager_approved"];

export function ApprovalQueueTab() {
  const { can } = useHrmsPermissions();
  const isFinance = can(M.EXPENSES, A.APPROVE, S.ORG);

  const [view, setView] = useState("pending");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "payable") {
        setResult(
          await expensesApi.claims({ status: "finance_approved", page, pageSize: PAGE_SIZE }),
        );
        return;
      }

      // `status` takes one value, and the queue spans two. Two calls, merged —
      // rather than fetching everything and filtering, which is what leaks.
      const pages = await Promise.all(
        PENDING.map((status) => expensesApi.claims({ status, page: 1, pageSize: PAGE_SIZE })),
      );
      setResult({
        data: pages.flatMap((p) => p.data ?? []),
        total: pages.reduce((sum, p) => sum + (p.total ?? 0), 0),
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [view, page]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (claim, run, done) => {
    setBusyId(claim.id);
    try {
      await run();
      toast.success(done);
      await load();
    } catch (err) {
      toast.error(err?.message ?? "That action could not be completed.");
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      header: "",
      className: "w-10",
      cell: (row) => (
        <button
          type="button"
          onClick={() => setExpanded(expanded === row.id ? null : row.id)}
          aria-expanded={expanded === row.id}
          aria-label={`${expanded === row.id ? "Hide" : "Show"} line items for ${row.title}`}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          {expanded === row.id ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      ),
    },
    {
      header: "Employee",
      accessorKey: "employeeName",
      cell: (row) => (
        <div>
          <div className="font-medium text-slate-900">{row.employeeName ?? "—"}</div>
          <div className="text-xs text-slate-500">{row.employeeCode ?? ""}</div>
        </div>
      ),
    },
    { header: "Title", cell: (row) => row.title },
    {
      header: "Total",
      className: "w-32",
      headerClassName: "text-right",
      cell: (row) => <Money value={row.total} />,
    },
    {
      header: "Status",
      accessorKey: "status",
      className: "w-36",
      cell: (row) => <ClaimStatusBadge status={row.status} />,
    },
    {
      header: "Submitted",
      className: "w-32",
      cell: (row) => formatInstant(row.submittedAt),
    },
    {
      header: "",
      className: "w-48",
      cell: (row) => {
        // The server refuses a self-approval; do not offer it either.
        if (row.isOwnClaim) {
          return <span className="text-xs text-slate-400">Your own claim</span>;
        }
        if (row.status === "finance_approved") {
          return isFinance ? (
            <Button
              size="sm"
              disabled={busyId === row.id}
              onClick={() =>
                act(row, () => expensesApi.reimburse(row.id), "Claim marked reimbursed.")
              }
            >
              Mark reimbursed
            </Button>
          ) : null;
        }
        return (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busyId === row.id}
              onClick={() => act(row, () => expensesApi.decide(row.id, "approve"), "Claim approved.")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busyId === row.id}
              onClick={() => act(row, () => expensesApi.decide(row.id, "reject"), "Claim rejected.")}
            >
              Reject
            </Button>
          </div>
        );
      },
    },
  ];

  const rows = result.data ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { key: "pending", label: "Awaiting approval" },
          ...(isFinance ? [{ key: "payable", label: "Approved, awaiting payment" }] : []),
        ].map((option) => (
          <Button
            key={option.key}
            size="sm"
            variant={view === option.key ? "primary" : "secondary"}
            onClick={() => {
              setView(option.key);
              setPage(1);
            }}
          >
            {option.label}
          </Button>
        ))}
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
        emptyTitle={view === "payable" ? "Nothing awaiting payment" : "Nothing awaiting you"}
        emptyDescription={
          view === "payable"
            ? "Fully approved claims appear here until they are marked reimbursed."
            : "Claims submitted by your team will appear here."
        }
      />

      {expanded && rows.some((row) => row.id === expanded) && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <ClaimLines claim={rows.find((row) => row.id === expanded)} canUpload={false} />
        </div>
      )}
    </div>
  );
}

export default ApprovalQueueTab;
