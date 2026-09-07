import { useCallback, useEffect, useMemo, useState } from "react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { SelfieThumb } from "./SelfieThumb";
import { StatusCell, CELL, HEAD_CELL } from "./attendanceTable";
import { attendanceApi } from "../../../services/hrms";
import { formatTime, formatLocation, formatDayLabel } from "./attendanceFormat";

/**
 * Today, one row per person the viewer is responsible for.
 *
 * ---------------------------------------------------------------------------
 * The reference's Team tab, column for column
 * ---------------------------------------------------------------------------
 * Employee (name over code), Clock in, Clock out, Status, Selfie / Location —
 * and NO Hours column (`AttendancePage.tsx:266-350`). An earlier pass here had
 * one; it is removed rather than kept, because the brief is parity and an extra
 * column is an invention.
 *
 * It shows EVERYONE in scope, including the people who have not clocked in —
 * which is the whole point of a manager opening it at 10am. That only works
 * because the row comes from the employee list rather than from the attendance
 * rows; a grid built from attendance would silently omit exactly the people the
 * manager is looking for.
 *
 * Not paginated, as in the reference (`pagination={false}`). The set is "my
 * reports today" — bounded by span of control, not by headcount — so AD-13's
 * requirement, which is about lists that grow with the company, does not bite.
 */
export function TeamAttendanceTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await attendanceApi.teamGrid()) ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** A one-line summary above the grid, so the header answers "how many are in". */
  const summary = useMemo(() => {
    const present = rows.filter((r) => r.clockIn).length;
    return { present, total: rows.length };
  }, [rows]);

  const columns = useMemo(
    () => [
      {
        header: "Employee",
        className: CELL,
        headerClassName: HEAD_CELL,
        cell: (row) => (
          <div className="flex flex-col">
            <span className="font-semibold text-slate-900">{row.displayName}</span>
            <span className="text-[11px] text-slate-500">{row.employeeCode}</span>
          </div>
        ),
      },
      {
        header: "Clock in",
        className: `${CELL} w-[120px] tabular-nums`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatTime(row.clockIn),
      },
      {
        header: "Clock out",
        className: `${CELL} w-[120px] tabular-nums`,
        headerClassName: HEAD_CELL,
        cell: (row) => formatTime(row.clockOut),
      },
      {
        header: "Status",
        className: `${CELL} w-[220px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => <StatusCell derived={row.derived} />,
      },
      {
        header: "Selfie / Location",
        className: `${CELL} w-[170px]`,
        headerClassName: HEAD_CELL,
        cell: (row) => {
          const location = formatLocation(row.clockInCapture) ?? formatLocation(row.clockOutCapture);
          const hasSelfie = row.clockInCapture?.hasSelfie || row.clockOutCapture?.hasSelfie;
          if (!hasSelfie && !location) return <span className="text-slate-400">—</span>;

          return (
            <div className="flex flex-col gap-1">
              {hasSelfie && (
                <div className="flex gap-1">
                  {/*
                    `recordId` is null for someone with no row today, and the
                    capture flags are false with it — so a thumbnail can never
                    be rendered without an id to fetch against.
                  */}
                  {row.recordId && row.clockInCapture?.hasSelfie && (
                    <SelfieThumb recordId={row.recordId} punch="in" label="In" />
                  )}
                  {row.recordId && row.clockOutCapture?.hasSelfie && (
                    <SelfieThumb recordId={row.recordId} punch="out" label="Out" />
                  )}
                </div>
              )}
              {location && (
                <span className="text-[11px] text-slate-500 leading-snug line-clamp-2" title={location}>
                  {location}
                </span>
              )}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-semibold text-slate-500">{formatDayLabel()}</p>
        {!loading && !error && rows.length > 0 && (
          <p className="text-xs text-slate-500">
            <span className="font-semibold text-slate-900">{summary.present}</span> of{" "}
            {summary.total} clocked in
          </p>
        )}
      </div>

      <HrmsDataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        rowKey={(row) => row.employeeId}
        total={rows.length}
        pageSize={rows.length || 1}
        emptyTitle="Nobody reports to you yet"
        emptyDescription="Once employees report to you, their attendance for today appears here."
      />
    </div>
  );
}

export default TeamAttendanceTab;
