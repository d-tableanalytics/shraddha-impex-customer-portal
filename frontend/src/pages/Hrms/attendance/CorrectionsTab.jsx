import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { HrmsStatusBadge } from "../../../components/hrms/HrmsStatusBadge";
import { SearchableSelect } from "../../../components/hrms/SearchableSelect";
import { Button } from "../../../components/ui/Button";
import { CELL, HEAD_CELL, PAGE_SIZE } from "./attendanceTable";
import { attendanceCorrectionsApi } from "../../../services/hrms";
import { CORRECTION_STATUSES } from "@shared/constants/attendance.js";
import { formatDate, formatTime } from "./attendanceFormat";

const STATUS_OPTIONS = CORRECTION_STATUSES.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/**
 * The corrections list — an employee's own requests, or an approver's queue.
 *
 * ---------------------------------------------------------------------------
 * The reference's columns, in its order
 * ---------------------------------------------------------------------------
 * Employee, Date, Requested in, Requested out, Reason, Status, and — for an
 * approver only — a pair of small Approve / Reject buttons
 * (`AttendancePage.tsx:363-425`). Paginated at 15.
 *
 * ---------------------------------------------------------------------------
 * One list, two audiences
 * ---------------------------------------------------------------------------
 * The rows a person sees are decided entirely by the server's scope filter, so
 * this component does not branch on who is looking. `canApprove` only decides
 * whether the decision buttons render, and hiding them is a convenience — the
 * endpoint re-checks, and it checks against the REQUESTER's manager chain, so a
 * manager cannot decide a request from outside their team even by calling it
 * directly.
 */
export function CorrectionsTab({ canApprove }) {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: PAGE_SIZE });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const [failure, setFailure] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        (await attendanceCorrectionsApi.list({
          page,
          pageSize: PAGE_SIZE,
          ...(status ? { status } : {}),
        })) ?? { data: [], total: 0, page, pageSize: PAGE_SIZE },
      );
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = useCallback(
    async (id, decision) => {
      setDeciding(id);
      setFailure(null);
      try {
        await attendanceCorrectionsApi.decide(id, decision);
        await load();
      } catch (err) {
        // Surfaced rather than swallowed. The commonest failure here is a
        // genuine race — someone else decided it first — and the person needs
        // to be told that rather than watching a button do nothing.
        setFailure(err?.message ?? "The decision could not be recorded.");
      } finally {
        setDeciding(null);
      }
    },
    [load],
  );

  const columns = useMemo(() => {
    const base = [
      {
        header: "Employee",
        className: CELL,
        headerClassName: HEAD_CELL,
        cell: (row) => (
          <div className="flex flex-col">
            <span className="font-semibold text-slate-900">{row.employeeName ?? "—"}</span>
            {row.employeeCode && (
              <span className="text-[11px] text-slate-500">{row.employeeCode}</span>
            )}
          </div>
        ),
      },
      {
        header: "Date",
        className: `${CELL} w-[130px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatDate(row.date),
      },
      {
        header: "Requested in",
        className: `${CELL} w-[130px] tabular-nums`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatTime(row.requestedClockIn),
      },
      {
        header: "Requested out",
        className: `${CELL} w-[130px] tabular-nums`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatTime(row.requestedClockOut),
      },
      {
        header: "Reason",
        className: CELL,
        headerClassName: HEAD_CELL,
        cell: (row) => (
          <p className="max-w-sm text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">
            {row.reason}
          </p>
        ),
      },
      {
        header: "Status",
        className: `${CELL} w-[120px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => (
          <div className="flex flex-col gap-1">
            <HrmsStatusBadge status={row.status} />
            {row.comment && (
              <span className="text-[10.5px] text-slate-500 leading-snug">“{row.comment}”</span>
            )}
          </div>
        ),
      },
    ];

    if (canApprove) {
      base.push({
        header: "",
        className: `${CELL} w-[160px]`,
        headerClassName: HEAD_CELL,
        cell: (row) =>
          row.status === "pending" ? (
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="primary"
                loading={deciding === row.id}
                onClick={() => decide(row.id, "approve")}
              >
                <Check size={12} className="mr-1" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={deciding === row.id}
                onClick={() => decide(row.id, "reject")}
              >
                <X size={12} className="mr-1" />
                Reject
              </Button>
            </div>
          ) : null,
      });
    }

    return base;
  }, [canApprove, deciding, decide]);

  return (
    <div className="flex flex-col gap-3">
      {/*
        The reference has no filter here. This one is kept because it is built
        and tested and an approver with a long history needs it — but it is a
        single compact control on its own line rather than the full FilterBar,
        so it reads as a refinement of the table below rather than a toolbar.
      */}
      <div className="flex items-center gap-2">
        <SearchableSelect
          className="w-44"
          value={status}
          onChange={(value) => {
            setStatus(value);
            // Filtering while on page 4 would land on an empty table with no
            // visible cause.
            setPage(1);
          }}
          options={STATUS_OPTIONS}
          placeholder="Status"
        />
        {status && (
          <Button
            variant="ghost"
            size="sm"
            className="text-slate-500"
            onClick={() => {
              setStatus(null);
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-xs text-error-500 font-medium">
          {failure}
        </p>
      )}

      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? PAGE_SIZE}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle={canApprove ? "Nothing to decide" : "No corrections requested"}
        emptyDescription={
          canApprove
            ? "Correction requests from your team appear here."
            : "If a punch is ever wrong, request a correction from My Attendance."
        }
      />
    </div>
  );
}

export default CorrectionsTab;
