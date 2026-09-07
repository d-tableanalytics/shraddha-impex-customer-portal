import { BarChart3, Play } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { ErrorState } from "../../../components/hrms/ErrorState";

/**
 * The catalogue.
 *
 * The reference's card grid, grouped by `category`, with the column count as a
 * tag and a "Run report" action — reproduced with Tailwind primitives instead
 * of antd `Row`/`Col`/`Card`.
 *
 * The one behavioural difference is the empty state. The reference renders
 * `<Empty description="No reports available"/>` and stops, which is what three
 * of eight roles see — they hold `reports:payroll`, `reports:team` or
 * `reports:assets`, those grants open the module, and no report declares any of
 * them. Saying so is more useful than a shrug.
 */

export function ReportCatalogue({ reports, loading, error, onRetry, onSelect }) {
  if (error) {
    return (
      <ErrorState
        title="Reports could not be loaded"
        description={error.message}
        onRetry={onRetry}
      />
    );
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            data-testid="report-card-skeleton"
            className="h-36 animate-pulse rounded-lg border border-slate-200 bg-slate-50"
          />
        ))}
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-6 py-12 text-center">
        <BarChart3 className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium text-slate-700">No reports available</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          A report is offered on the module it reads, not on Reports itself — the
          employee directory needs org-wide access to Employees, and the leave
          report needs it to Leave. Your role does not hold any of them.
        </p>
      </div>
    );
  }

  // Grouped by category, in the order the categories first appear — the
  // reference's `reduce` into a keyed object does the same.
  const grouped = [];
  for (const report of reports) {
    const bucket = grouped.find((g) => g.category === report.category);
    if (bucket) bucket.items.push(report);
    else grouped.push({ category: report.category, items: [report] });
  }

  return (
    <div className="space-y-6">
      {grouped.map(({ category, items }) => (
        <section key={category}>
          <h2 className="mb-3 text-sm font-semibold text-slate-900">{category}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {items.map((report) => (
              <article
                key={report.key}
                className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 transition-shadow hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{report.label}</h3>
                  <Badge variant="neutral">{report.columns.length} columns</Badge>
                </div>
                <p className="mt-1 flex-1 text-sm leading-relaxed text-slate-500">
                  {report.description}
                </p>
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSelect(report.key)}
                    aria-label={`Run ${report.label}`}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    Run report
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default ReportCatalogue;
