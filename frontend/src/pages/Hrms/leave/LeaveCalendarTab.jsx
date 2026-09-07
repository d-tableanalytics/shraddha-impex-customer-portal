import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Button } from "../../../components/ui/Button";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { leaveApi, HrmsApiError } from "../../../services/hrms";
import { eachDay, isWeekend } from "@shared/leave/dates.js";

/**
 * Team calendar — a month of who is away.
 *
 * ONE request per month, to `/leave/calendar`, which returns the requests and
 * the holidays for the window together. Both are already scoped by the server:
 * a manager gets their own team, HR gets everyone. Nothing is filtered here, so
 * the grid cannot show a person the caller may not see — and it never fetches
 * the whole directory to work out who to display.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const pad = (n) => String(n).padStart(2, "0");
const monthStart = (year, month) => `${year}-${pad(month + 1)}-01`;
const monthEnd = (year, month) => {
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(last)}`;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday-first offset for the 1st of the month. */
const leadingBlanks = (isoFirst) => {
  const dow = new Date(`${isoFirst}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
};

export function LeaveCalendarTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth());

  const [data, setData] = useState({ requests: [], holidays: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const from = monthStart(year, month);
  const to = monthEnd(year, month);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await leaveApi.calendar(from, to));
    } catch (err) {
      setError(err instanceof HrmsApiError ? err : new HrmsApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  /** date -> what is happening on it. */
  const byDate = useMemo(() => {
    const map = new Map(eachDay(from, to).map((d) => [d, { leaves: [], holiday: null }]));

    for (const holiday of data.holidays ?? []) {
      if (map.has(holiday.date)) map.get(holiday.date).holiday = holiday;
    }

    for (const request of data.requests ?? []) {
      // A request can start before the window or end after it; only the days
      // inside the month are painted.
      for (const day of eachDay(request.startDate, request.endDate)) {
        if (map.has(day)) map.get(day).leaves.push(request);
      }
    }

    return map;
  }, [data, from, to]);

  const step = (delta) => {
    const next = month + delta;
    if (next < 0) {
      setMonth(11);
      setYear(year - 1);
    } else if (next > 11) {
      setMonth(0);
      setYear(year + 1);
    } else {
      setMonth(next);
    }
  };

  const days = eachDay(from, to);
  const blanks = leadingBlanks(from);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-500">
          Approved and pending leave for everyone you can see, with the holiday calendar.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => step(-1)} aria-label="Previous month">
            <ChevronLeft size={14} />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-slate-800">
            {MONTHS[month]} {year}
          </span>
          <Button variant="secondary" onClick={() => step(1)} aria-label="Next month">
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex min-h-[260px] items-center justify-center">
          <LoadingSpinner />
        </div>
      )}

      {!loading && error && (
        <ErrorState
          variant={error.isForbidden ? "forbidden" : "error"}
          description={
            error.isForbidden
              ? "Seeing other people's leave needs a team or organisation-wide grant."
              : error.message
          }
          onRetry={error.isForbidden ? undefined : load}
        />
      )}

      {!loading && !error && (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <div className="grid min-w-[42rem] grid-cols-7 border-b border-slate-200 bg-slate-50">
              {WEEKDAYS.map((label) => (
                <div
                  key={label}
                  className="px-2 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-slate-500"
                >
                  {label}
                </div>
              ))}
            </div>

            <div className="grid min-w-[42rem] grid-cols-7">
              {Array.from({ length: blanks }, (_, i) => (
                <div key={`blank-${i}`} className="min-h-[6.5rem] border-b border-r border-slate-100 bg-slate-50/40" />
              ))}

              {days.map((day) => {
                const cell = byDate.get(day);
                const weekend = isWeekend(day);
                const holiday = cell?.holiday;

                return (
                  <div
                    key={day}
                    className={`min-h-[6.5rem] border-b border-r border-slate-100 p-1.5 ${
                      holiday ? "bg-primary-50/60" : weekend ? "bg-slate-50/60" : "bg-white"
                    }`}
                  >
                    <div className="mb-1 flex items-baseline justify-between gap-1">
                      <span className="text-xs font-semibold text-slate-700">
                        {Number(day.slice(8, 10))}
                      </span>
                      {holiday && (
                        <span
                          className="truncate text-[10px] font-semibold text-primary-700"
                          title={holiday.name}
                        >
                          {holiday.name}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-col gap-0.5">
                      {cell?.leaves.slice(0, 3).map((request) => (
                        <span
                          key={`${day}-${request.id}`}
                          title={`${request.employeeName} · ${request.leaveTypeCode} · ${request.status}`}
                          className={`truncate rounded px-1 py-0.5 text-[10px] font-medium ${
                            request.status === "approved"
                              ? "bg-success-50 text-success-600"
                              : "bg-warning-50 text-warning-600"
                          }`}
                        >
                          {/* Status is in the text, not only the colour. */}
                          {request.employeeName}
                          {request.status === "pending" ? " (pending)" : ""}
                        </span>
                      ))}
                      {cell && cell.leaves.length > 3 && (
                        <span className="px-1 text-[10px] text-slate-400">
                          +{cell.leaves.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {data.requests.length === 0 && (
            <EmptyState
              title="Nobody is away this month"
              description="Approved and pending leave for the people you can see will appear on this grid."
            />
          )}
        </>
      )}
    </div>
  );
}

export default LeaveCalendarTab;
