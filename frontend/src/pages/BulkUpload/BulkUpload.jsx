import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../components/common/PageHeader";
import { BulkUploadCard } from "../../components/upload/BulkUploadCard";
import { ExcelPreviewTable } from "../../components/tables/ExcelPreviewTable";
import { ImportSummaryCard } from "../../components/cards/ImportSummaryCard";
import { ErrorPanel } from "../../components/cards/ErrorPanel";
import { ERPButton } from "../../components/ui";
import { useBulkImportStore } from "../../store/bulkImportStore";
import { useCartStore } from "../../store/cartStore";
import { useShowMsilCode } from "../../hooks/useShowMsilCode";
import {
  parseExcelFile,
  downloadTemplate,
  downloadErrorReport,
} from "../../utils/excelParser";
import { api } from "../../services/api";
import { reservationsApi } from "../../services/reservations";
import toast from "react-hot-toast";
import { Download, AlertTriangle, Check, RefreshCw } from "lucide-react";
import { computeReview, linesFromBulkRows } from "../../utils/bookingReview";

export const BulkUpload = () => {
  const navigate = useNavigate();
  const { file, rows, summary, setFile, setRows, updateRow, removeRow, reset: resetStore } =
    useBulkImportStore();
  const { fetchReservations } = useCartStore();
  // Non-MSIL customers upload by SKU Code alone.
  const showMsilCode = useShowMsilCode();
  const [isParsing, setIsParsing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [excludedRowIds, setExcludedRowIds] = useState([]);

  // Clearing the session also clears row exclusions.
  const reset = () => {
    setExcludedRowIds([]);
    resetStore();
  };

  // Selected = importable rows that haven't been excluded.
  const selectedRowIds = rows
    .filter((r) => (r.status === "valid" || r.status === "warning") && !excludedRowIds.includes(r.id))
    .map((r) => r.id);

  const toggleRow = (id) =>
    setExcludedRowIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleAllRows = (ids) =>
    setExcludedRowIds((prev) => {
      const allSelected = ids.every((id) => !prev.includes(id));
      // If all are currently selected, exclude them all; otherwise select all.
      return allSelected
        ? Array.from(new Set([...prev, ...ids]))
        : prev.filter((id) => !ids.includes(id));
    });

  const validateRows = async (rowsToValidate) => {
    const response = await api.post("/reservations/validate-bulk", { rows: rowsToValidate });
    const validatedRows = response.data.data;
    setRows(validatedRows);
    return validatedRows;
  };

  const handleUpload = async (uploadedFile) => {
    setIsParsing(true);
    setFile(uploadedFile);
    try {
      const parsed = await parseExcelFile(uploadedFile, showMsilCode);
      const validatedRows = await validateRows(parsed);

      const hasErrors = validatedRows.some(r => r.status === 'error');
      if (hasErrors) {
        toast.error("File parsed with validation errors");
      } else {
        toast.success("Excel file parsed and validated successfully");
      }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to validate Excel file");
      setFile(null);
    } finally {
      setIsParsing(false);
    }
  };

  // Rows edited after upload lose their server validation ('pending' status)
  // until they go through validate-bulk again.
  const hasPendingRows = rows.some((r) => r.status === "pending");
  const selectedCount = rows.filter(
    (r) => (r.status === "valid" || r.status === "warning") && selectedRowIds.includes(r.id),
  ).length;
  const canConfirm =
    summary.invalidRows === 0 && selectedCount > 0 && !hasPendingRows && !isConfirming;
  // A "clean" import (no warnings) gets the highlighted primary confirm.

  // The rows that will actually be booked, in the shape the shared review
  // popup expects — so the bulk shortfall is worked out by the same code as an
  // individual booking's, against the same stock figure.
  const reviewLines = linesFromBulkRows(
    rows.filter((r) => (r.status === "valid" || r.status === "warning")
      && !excludedRowIds.includes(r.id)),
  );
  const bulkReview = computeReview(reviewLines);


  const handleRevalidate = async () => {
    setIsParsing(true);
    try {
      await validateRows(rows);
      toast.success("Rows re-validated");
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to re-validate rows");
    } finally {
      setIsParsing(false);
    }
  };

  // Creates reservations for all valid rows in parallel, removes the rows
  // that imported successfully (so a retry never duplicates them), and
  // returns the failure list.
  const importValidRows = async () => {
    const validRows = rows.filter(
      (r) => (r.status === "valid" || r.status === "warning") && r.product && selectedRowIds.includes(r.id),
    );
    const results = await Promise.allSettled(
      validRows.map((row) => reservationsApi.create(row.product.id, row.quantity)),
    );
    const failures = [];
    results.forEach((r, idx) => {
      const row = validRows[idx];
      if (r.status === "fulfilled") {
        removeRow(row.id);
      } else {
        const err = r.reason;
        failures.push(`${row.skuCode || row.msilCode}: ${err?.response?.data?.message || err?.message || "failed"}`);
      }
    });
    await fetchReservations();
    return { attempted: validRows.length, failures };
  };

  const handleDirectConfirm = async () => {
    setIsConfirming(true);
    try {
      // Reserve every valid row — this is what puts them on the Selection List.
      const { attempted, failures } = await importValidRows();
      if (failures.length > 0) {
        throw new Error(`Some items could not be reserved: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
      }

      // STOP HERE. The booking is NOT confirmed from this screen — the upload's
      // job is to fill the Selection List, and confirming happens on Create
      // Booking exactly as it does for an item added by hand. Booking straight
      // from here gave the file a shortcut past the review every other booking
      // goes through.
      toast.success(`${attempted} item${attempted === 1 ? "" : "s"} added to your Selection List.`);
      reset();
      navigate("/orders/new");
    } catch (err) {
      toast.error(err.message || err.response?.data?.message || "Failed to add the uploaded rows to the Selection List.");
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bulk Booking Upload"
        actions={
          <ERPButton variant="outline" size="sm" onClick={() => reset()}>
            Reset Session
          </ERPButton>
        }
      />

      <p className="text-slate-600">
        Upload bookings using an Excel template.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-[30fr_70fr] gap-8 items-start">
        <div className="flex flex-col gap-6">
          <BulkUploadCard
            file={file}
            onUpload={handleUpload}
            onRemove={reset}
            isLoading={isParsing}
          />

          <div className="bg-white border border-slate-200 p-6 rounded-xl">
            <h4 className="font-bold text-slate-800 mb-2">Validation Rules</h4>
            <ul className="text-sm text-slate-600 list-disc list-inside space-y-1">
              <li>
                {showMsilCode ? "SKU Code / MSIL Code & Quantity" : "SKU Code & Quantity"} are
                validated.
              </li>
              <li>Duplicates will be automatically merged.</li>
              <li>Quantities exceeding available stock will be flagged.</li>
            </ul>

            <div className="mt-4 flex flex-col gap-2">
              <p className="text-xs font-semibold text-slate-500">Download a bulk upload template:</p>
              <ERPButton
                variant="outline"
                className="w-full"
                onClick={() => downloadTemplate(showMsilCode)}
              >
                <Download size={16} className="mr-2" />
                Download Bulk Upload Template
              </ERPButton>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-6">
          {file ? (
            <>
              <ImportSummaryCard summary={summary} />

              <ErrorPanel rows={rows} />

              {summary.invalidRows > 0 && (
                <div className="flex justify-end">
                  <ERPButton
                    variant="outline"
                    size="sm"
                    onClick={() => downloadErrorReport(rows, showMsilCode)}
                    className="text-error-600 border-error-200 hover:bg-error-50"
                  >
                    <AlertTriangle size={14} className="mr-2" /> Download Error
                    Report
                  </ERPButton>
                </div>
              )}

              <ExcelPreviewTable
                rows={rows}
                onUpdateRow={updateRow}
                selectedIds={selectedRowIds}
                onToggleRow={toggleRow}
                onToggleAll={toggleAllRows}
                showMsilCode={showMsilCode}
              />

              <div className="flex justify-end mt-4 gap-4">
                {hasPendingRows && (
                  <ERPButton
                    variant="outline"
                    size="lg"
                    disabled={isParsing || isConfirming}
                    onClick={handleRevalidate}
                    className="w-full md:w-auto px-6"
                  >
                    <RefreshCw size={16} className={`mr-2 ${isParsing ? "animate-spin" : ""}`} />
                    Re-validate Edited Rows
                  </ERPButton>
                )}
                {/* One button, and it opens the same review popup the
                    individual flow opens — the shortfall is reviewed before
                    anything is reserved, not announced afterwards. */}
                <ERPButton
                  variant="success"
                  size="lg"
                  disabled={!canConfirm}
                  onClick={handleDirectConfirm}
                  className="w-full md:w-auto px-8 shadow-md bg-green-600 hover:bg-green-700 ring-2 ring-green-300"
                >
                  <Check size={18} className="mr-2 text-white" />
                  {isConfirming ? "Adding..." : `Continue to Booking (${selectedCount})`}
                </ERPButton>
              </div>
            </>
          ) : (
            <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl h-64 flex items-center justify-center text-slate-400">
              Upload a file to see preview and validation results.
            </div>
          )}
        </div>
      </div>

    </div>
  );
};
export default BulkUpload;
