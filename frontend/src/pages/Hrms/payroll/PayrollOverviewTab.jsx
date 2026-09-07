import { useCallback, useEffect, useState } from "react";

import { ErrorState } from "../../../components/hrms/ErrorState";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingSpinner } from "../../../components/ui/LoadingSpinner";
import { Badge } from "../../../components/ui/Badge";
import { payslipsApi, payrollRunsApi } from "../../../services/hrms";
// Payroll's own formatters, imported directly: the barrel already exports an
// Expenses `formatMoney`, and payroll's groups by lakh for a payslip.
import { formatMoney, formatPeriod } from "../../../services/hrms/payroll";

/**
 * Payroll at a glance.
 *
 * The reference's Overview: the caller's own latest payslip, and — for someone
 * who can see the company's payroll — how many runs are open and which month
 * was last disbursed (`PayrollOverviewTab.tsx`).
 *
 * `seesCompanyPayroll` decides whether the company half renders AT ALL, so an
 * ordinary employee's request never asks for it. Hiding a card the API would
 * refuse is a convenience; not asking is what keeps the console clean.
 */
const RUN_TONES = {
  draft: "neutral",
  review: "primary",
  locked: "warning",
  disbursed: "success",
};

/** A right-aligned figure with a small muted label above it. */
function MoneyStat({ label, value, emphasis = false }) {
  return (
    <div className="text-right leading-tight">
      <p className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</p>
      <p
        className={`tabular-nums whitespace-nowrap font-semibold ${
          emphasis ? "text-lg text-primary-700" : "text-[15px] text-slate-900"
        }`}
      >
        ₹ {formatMoney(value)}
      </p>
    </div>
  );
}

export function PayrollOverviewTab({ seesCompanyPayroll = false }) {
  const [payslip, setPayslip] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mine, runList] = await Promise.all([
        payslipsApi.mine({ pageSize: 1 }),
        // Not requested at all without the grant — see the header.
        seesCompanyPayroll ? payrollRunsApi.list({ pageSize: 50 }) : Promise.resolve(null),
      ]);
      setPayslip(mine?.data?.[0] ?? null);
      setRuns(runList?.data ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [seesCompanyPayroll]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[30vh]">
        <LoadingSpinner size={28} />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        variant={error.isForbidden ? "forbidden" : "error"}
        description={error.message}
        onRetry={load}
      />
    );
  }

  const openRuns = runs.filter((r) => r.status !== "disbursed");
  const lastDisbursed = runs.find((r) => r.status === "disbursed");

  return (
    <div className="flex flex-col gap-4">
      {seesCompanyPayroll && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-slate-500">Runs in progress</p>
            <p
              className={`text-2xl font-bold mt-1 ${
                openRuns.length > 0 ? "text-warning-600" : "text-slate-900"
              }`}
            >
              {openRuns.length}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-semibold text-slate-500">Latest disbursed</p>
            <p className="text-2xl font-bold mt-1 text-slate-900">
              {lastDisbursed ? formatPeriod(lastDisbursed.month, lastDisbursed.year) : "—"}
            </p>
          </div>
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-xl">
        <h3 className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-900">
          My latest payslip
        </h3>
        {payslip ? (
          <div className="p-4 flex flex-wrap items-center justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                {formatPeriod(payslip.month, payslip.year)}
              </p>
              {payslip.lopDays > 0 && (
                <p className="text-[11px] text-warning-600 mt-0.5">
                  {payslip.lopDays} day{payslip.lopDays === 1 ? "" : "s"} of loss of pay
                </p>
              )}
            </div>
            <div className="flex gap-6">
              <MoneyStat label="Gross" value={payslip.gross} />
              <MoneyStat label="Deductions" value={payslip.totalDeductions} />
              <MoneyStat label="Net pay" value={payslip.netPay} emphasis />
            </div>
          </div>
        ) : (
          <EmptyState
            title="No payslips yet"
            description="Your payslip appears here once payroll for the month has been finalised."
            className="border-0 rounded-none"
          />
        )}
      </section>

      {seesCompanyPayroll && openRuns.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl">
          <h3 className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-900">
            Runs in progress
          </h3>
          <ul className="divide-y divide-slate-100">
            {openRuns.map((run) => (
              <li key={run.id} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">
                    {formatPeriod(run.month, run.year)}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {run.payGroupName ?? "—"} · headcount {run.totals.headcount}
                  </p>
                </div>
                <Badge variant={RUN_TONES[run.status] ?? "neutral"}>{run.status}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default PayrollOverviewTab;
