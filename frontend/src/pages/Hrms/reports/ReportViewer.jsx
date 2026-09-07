import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { ArrowLeft, Download } from "lucide-react";

import { Button } from "../../../components/ui/Button";
import { HrmsDataTable } from "../../../components/hrms/HrmsDataTable";
import {
  reportsApi,
  downloadCsv,
  formatCell,
  toQuery,
} from "../../../services/hrms/reports";
import { ReportFilters } from "./ReportFilters";

/**
 * One report, run.
 *
 * The reference's detail card — a "← Catalog" button, the label, an
 * "Export CSV" button and a table — with three differences:
 *
 *   1. THE TABLE IS SERVER-PAGED. The reference receives every row and then
 *      paginates fifty at a time in the browser.
 *   2. THERE ARE FILTERS. The reference has none.
 *   3. THERE IS AN ERROR STATE. The reference renders `<Empty description="No
 *      data"/>` on failure, so a 403 and an empty report look identical.
 */

const PAGE_SIZE = 25;

export function ReportViewer({ reportKey, catalogEntry, onBack }) {
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  // The filter state is per-report: switching reports must not carry a
  // `leaveTypeId` into a report that would reject it as unknown.
  useEffect(() => {
    setFilters({});
    setPage(1);
    setResult(null);
  }, [reportKey]);

  /** Filter state -> the query the server accepts for THIS report. */
  const query = useMemo(() => toQuery(reportKey, filters), [reportKey, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await reportsApi.run(reportKey, { ...query, page, pageSize: PAGE_SIZE }));
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [reportKey, query, page]);

  useEffect(() => {
    load();
  }, [load]);

  const onExport = async () => {
    setExporting(true);
    try {
      // The export runs the same filters, without paging — it is the whole
      // result set, not the page on screen.
      const file = await reportsApi.exportCsv(reportKey, query);
      downloadCsv(file);
      toast.success(
        file.truncated
          ? `Exported the first ${file.rows} of ${file.total} rows.`
          : `Exported ${file.rows} rows.`,
      );
    } catch (err) {
      toast.error(err?.message ?? "That report could not be exported.");
    } finally {
      setExporting(false);
    }
  };

  // The columns come with the rows, so a report opened straight from a URL
  // renders correctly before the catalogue has arrived.
  const columns = result?.columns ?? catalogEntry?.columns ?? [];
  const label = result?.report?.label ?? catalogEntry?.label ?? "Report";

  const tableColumns = columns.map((c) => ({
    header: c.label,
    accessorKey: c.key,
    className: c.type === "number" ? "text-right tabular-nums" : undefined,
    headerClassName: c.type === "number" ? "text-right" : undefined,
    cell: (row) => formatCell(row[c.key], c.type),
  }));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
            Catalog
          </Button>
          <h2 className="text-base font-semibold text-slate-900">{label}</h2>
        </div>

        <Button onClick={onExport} disabled={exporting || Boolean(error)}>
          <Download className="mr-1 h-4 w-4" aria-hidden="true" />
          {exporting ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      <ReportFilters
        reportKey={reportKey}
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
      />

      <HrmsDataTable
        columns={tableColumns}
        rows={result?.data ?? []}
        loading={loading}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={result?.total ?? 0}
        onPageChange={setPage}
        rowKey={(row, index) => `${row.employeeCode ?? ""}-${index}`}
        emptyTitle="No data"
        emptyDescription="Nothing matched this report's filters."
      />
    </div>
  );
}

export default ReportViewer;
