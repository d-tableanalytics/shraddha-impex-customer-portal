import { useEffect, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { departmentsApi, leaveApi } from "../../../services/hrms";
import {
  REPORT_FILTERS,
  DIRECTORY_STATUS_OPTIONS,
  currentMonth,
} from "../../../services/hrms/reports";

/**
 * The filter bar for whichever report is open.
 *
 * The reference has no filters at all: `params` is accepted on every endpoint
 * and ignored by every generator, so "Monthly Attendance Summary" can only ever
 * mean the current month and the directory can only ever mean the whole
 * organisation.
 *
 * Every control here changes the SERVER query. Nothing is filtered in the
 * browser — the rows on screen are one page, and filtering a page would
 * silently mean "filter the twenty-five rows you happen to be looking at".
 */

const selectClass =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700";

export function ReportFilters({ reportKey, value, onChange }) {
  const fields = REPORT_FILTERS[reportKey] ?? [];
  const [departments, setDepartments] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [searchDraft, setSearchDraft] = useState(value.search ?? "");

  const needsDepartments = fields.includes("department");
  const needsLeaveTypes = fields.includes("leaveType");

  useEffect(() => {
    if (!needsDepartments) return;
    let cancelled = false;
    departmentsApi
      .list({ pageSize: 200 })
      .then((res) => {
        if (!cancelled) setDepartments(Array.isArray(res) ? res : (res?.data ?? []));
      })
      .catch(() => {
        // A filter that cannot load its options is not a reason to fail the
        // report — the unfiltered report is still correct.
        if (!cancelled) setDepartments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsDepartments]);

  useEffect(() => {
    if (!needsLeaveTypes) return;
    let cancelled = false;
    leaveApi
      .types()
      .then((res) => {
        if (!cancelled) setLeaveTypes(Array.isArray(res) ? res : (res?.data ?? []));
      })
      .catch(() => {
        if (!cancelled) setLeaveTypes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsLeaveTypes]);

  useEffect(() => {
    setSearchDraft(value.search ?? "");
  }, [reportKey, value.search]);

  if (fields.length === 0) return null;

  const set = (patch) => onChange({ ...value, ...patch });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {fields.includes("status") && (
        <div>
          <label htmlFor="report-status" className="sr-only">
            Filter by status
          </label>
          <select
            id="report-status"
            className={selectClass}
            value={value.status ?? "active"}
            onChange={(e) => set({ status: e.target.value })}
          >
            {DIRECTORY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {fields.includes("dateRange") && (
        <div>
          <label htmlFor="report-month" className="sr-only">
            Month
          </label>
          <input
            id="report-month"
            type="month"
            className={selectClass}
            value={value.month ?? currentMonth()}
            onChange={(e) => set({ month: e.target.value })}
          />
        </div>
      )}

      {fields.includes("year") && (
        <div>
          <label htmlFor="report-year" className="sr-only">
            Year
          </label>
          <select
            id="report-year"
            className={selectClass}
            value={value.year ?? String(new Date().getFullYear())}
            onChange={(e) => set({ year: e.target.value })}
          >
            {yearOptions().map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}

      {needsLeaveTypes && (
        <div>
          <label htmlFor="report-leave-type" className="sr-only">
            Filter by leave type
          </label>
          <select
            id="report-leave-type"
            className={selectClass}
            value={value.leaveTypeId ?? ""}
            onChange={(e) => set({ leaveTypeId: e.target.value })}
          >
            <option value="">All leave types</option>
            {leaveTypes.map((t) => (
              <option key={t.id ?? t._id} value={t.id ?? t._id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {needsDepartments && (
        <div>
          <label htmlFor="report-department" className="sr-only">
            Filter by department
          </label>
          <select
            id="report-department"
            className={selectClass}
            value={value.departmentId ?? ""}
            onChange={(e) => set({ departmentId: e.target.value })}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id ?? d._id} value={d.id ?? d._id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {fields.includes("search") && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set({ search: searchDraft.trim() || undefined });
          }}
        >
          <label htmlFor="report-search" className="sr-only">
            Search employees
          </label>
          <Input
            id="report-search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Name or code…"
            className="w-48"
          />
          <Button type="submit" size="sm" variant="secondary">
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Search</span>
          </Button>
        </form>
      )}
    </div>
  );
}

/** This year and the four before it — leave buckets do not run further back. */
function yearOptions() {
  const now = new Date().getFullYear();
  return [0, 1, 2, 3, 4].map((n) => String(now - n));
}

export default ReportFilters;
