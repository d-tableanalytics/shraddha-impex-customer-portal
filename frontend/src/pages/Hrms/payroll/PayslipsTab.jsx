import { useCallback, useEffect, useMemo, useState } from "react";

import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import { Modal } from "../../../components/ui/Modal";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { payslipsApi } from "../../../services/hrms";
import { formatMoney, formatPeriod } from "../../../services/hrms/payroll";

const CELL = "px-4 py-2.5 align-top";
const HEAD = "px-4 py-2.5";

/**
 * The employee-facing payslip history.
 *
 * The reference's Payslips tab. Its columns are Payslip / Gross / Deductions /
 * Net pay / Status, right-aligned money, net emphasised — kept, with the period
 * replacing its truncated payslip id, which told a reader nothing.
 *
 * Only FINAL payslips appear: the server filters to locked and disbursed runs
 * for anyone without the org grant, because a figure that is still moving is
 * worse than no figure. That is enforced server-side; this component does not
 * need to know.
 */
export function PayslipsTab() {
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 15 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult((await payslipsApi.mine({ page, pageSize: 15 })) ?? { data: [], total: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const money = (v) => <span className="tabular-nums">₹ {formatMoney(v)}</span>;

  const columns = useMemo(
    () => [
      {
        header: "Period",
        className: `${CELL} font-semibold text-slate-900`,
        headerClassName: HEAD,
        cell: (row) => formatPeriod(row.month, row.year),
      },
      {
        header: "Gross",
        className: `${CELL} text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => money(row.gross),
      },
      {
        header: "Deductions",
        className: `${CELL} text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => money(row.totalDeductions),
      },
      {
        header: "Net pay",
        className: `${CELL} text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) => (
          <span className="tabular-nums font-semibold text-success-600">
            ₹ {formatMoney(row.netPay)}
          </span>
        ),
      },
      {
        header: "Loss of pay",
        className: `${CELL} text-right`,
        headerClassName: `${HEAD} text-right`,
        cell: (row) =>
          row.lopDays > 0 ? (
            <Badge variant="warning">
              {row.lopDays} day{row.lopDays === 1 ? "" : "s"}
            </Badge>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        header: "",
        className: `${CELL} w-[110px]`,
        headerClassName: HEAD,
        cell: (row) => (
          <Button size="xs" variant="secondary" onClick={() => setOpen(row)}>
            View
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <HrmsDataTable
        columns={columns}
        rows={result.data}
        loading={loading}
        error={error}
        onRetry={load}
        page={result.page ?? page}
        pageSize={result.pageSize ?? 15}
        total={result.total ?? 0}
        onPageChange={setPage}
        emptyTitle="No payslips yet"
        emptyDescription="Your payslip appears here once payroll for the month has been finalised."
      />

      <Modal
        isOpen={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open ? `Payslip — ${formatPeriod(open.month, open.year)}` : "Payslip"}
        size="lg"
      >
        {open && <PayslipDetail payslip={open} />}
      </Modal>
    </>
  );
}

/**
 * The breakdown, grouped the way a payslip reads.
 *
 * Employer contributions are shown SEPARATELY and excluded from the net, which
 * is what they are: cost to company, never deducted from the employee.
 */
function PayslipDetail({ payslip }) {
  const group = (types) => payslip.lines.filter((l) => types.includes(l.type));
  const earnings = group(["earning", "reimbursement"]);
  const deductions = group(["deduction"]);
  const employer = group(["employer_contribution"]);

  const Section = ({ title, lines, total }) =>
    lines.length === 0 ? null : (
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1.5">
          {title}
        </h4>
        <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
          {lines.map((l) => (
            <li
              key={l.componentCode}
              className="flex items-baseline justify-between gap-3 px-3 py-2 bg-white"
            >
              <span className="text-xs text-slate-700 min-w-0">
                {l.componentName}
                {l.subtitle && (
                  <span className="block text-[10.5px] text-slate-400">{l.subtitle}</span>
                )}
              </span>
              <span className="text-xs tabular-nums text-slate-900 shrink-0">
                ₹ {formatMoney(l.amount)}
              </span>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 px-3 py-2 bg-slate-50 font-semibold">
            <span className="text-xs text-slate-700">Total</span>
            <span className="text-xs tabular-nums text-slate-900">₹ {formatMoney(total)}</span>
          </li>
        </ul>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Earnings" lines={earnings} total={payslip.gross} />
        <Section title="Deductions" lines={deductions} total={payslip.totalDeductions} />
      </div>

      <div className="flex items-baseline justify-between px-4 py-3 rounded-lg bg-success-50 border border-success-200">
        <span className="text-sm font-semibold text-slate-900">Net pay</span>
        <span className="text-lg font-bold tabular-nums text-success-600">
          ₹ {formatMoney(payslip.netPay)}
        </span>
      </div>

      {employer.length > 0 && (
        <Section
          title="Employer contributions (not deducted from you)"
          lines={employer}
          total={payslip.employerContributions}
        />
      )}

      {payslip.lopDays > 0 && (
        <p className="text-[11px] text-slate-500">
          This month includes {payslip.lopDays} day{payslip.lopDays === 1 ? "" : "s"} of unpaid
          leave.
        </p>
      )}
    </div>
  );
}

export default PayslipsTab;
