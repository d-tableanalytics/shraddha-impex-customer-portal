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
import { Download, AlertTriangle, Check, RefreshCw, PackageCheck, PackageX } from "lucide-react";
import { computeReview } from "../../utils/bookingReview";
import { ReviewIndentModal } from "../../components/booking/ReviewIndentModal";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";

export const BulkUpload = () => {
  const navigate = useNavigate();
  const { file, rows, summary, setFile, setRows, updateRow, removeRow, reset: resetStore } =
    useBulkImportStore();
  const { fetchReservations, confirmBooking } = useCartStore();
  // Non-MSIL customers upload by SKU Code alone.
  const showMsilCode = useShowMsilCode();
  const [isParsing, setIsParsing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [excludedRowIds, setExcludedRowIds] = useState([]);
  // The review popup is opened against the Selection List AFTER the rows have
  // been reserved, not against the parsed file — see handleContinue.
  const [pendingReview, setPendingReview] = useState(null);
  const [outcome, setOutcome] = useState(null);

  // Clearing the session also clears row exclusions.
  const reset = () => {
    setExcludedRowIds([]);
    setPendingReview(null);
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
  //
  // The shortfall is NOT worked out from the parsed rows here. It is computed
  // in handleContinue from the Selection List once the rows are reserved,
  // because that is the set the confirmation actually commits — a preview built
  // from the file alone omits lines the customer already held and misstates a
  // repeat SKU the server merged into an existing line.

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

  /**
   * Step 1 — reserve the selected rows, then REVIEW.
   *
   * This used to stop here and send the user to Create Booking, which is the
   * reported defect: an uploaded file that was entirely out of stock — a pure
   * indent — was dumped onto the booking screen, and nothing the file created
   * ever reached Booking History because nothing was ever confirmed.
   *
   * The review is still shown, because a file must not get a shortcut past the
   * check every hand-made booking goes through. What changed is that it is now
   * computed against the SELECTION LIST as it stands after the import, not
   * against the parsed rows — the confirm step commits every reserved line the
   * customer holds, so anything already sitting there must be visible in the
   * popup rather than swept in unannounced.
   */
  const handleContinue = async () => {
    setIsConfirming(true);
    try {
      const { failures } = await importValidRows();
      if (failures.length > 0) {
        // Rows that failed to reserve stay on this screen with their error and
        // are never carried into the booking — a failed record must not appear
        // in Booking History as though it had been created.
        throw new Error(`Some items could not be reserved: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""}`);
      }

      // The Selection List as the server sees it — importValidRows has already
      // refetched it. Read back rather than trusting the parsed rows: the
      // server merges a repeat SKU into an existing line, so the quantity that
      // will actually be booked can differ from the quantity in the file.
      const items = useCartStore.getState().items;
      if (items.length === 0) {
        throw new Error("Nothing is on your Selection List to confirm.");
      }
      setPendingReview({
        review: computeReview(items),
        itemCount: items.length,
        unitCount: items.reduce((n, i) => n + (i.orderQuantity || 0), 0),
      });
    } catch (err) {
      toast.error(err.message || err.response?.data?.message || "Failed to add the uploaded rows to the Selection List.");
    } finally {
      setIsConfirming(false);
    }
  };

  /**
   * Step 2 — confirm, and route on what was actually created.
   *
   * The server reports the outcome (`booking`, `indent`, or `booking+indent`)
   * rather than leaving the client to guess from the totals. Bookings land in
   * Booking History and indents in Indent History, so a file of out-of-stock
   * lines is never again announced as a booking that does not exist.
   */
  const handleConfirm = async () => {
    setIsConfirming(true);
    try {
      const result = await confirmBooking();
      setPendingReview(null);
      reset();
      setOutcome({
        outcome: result?.outcome || (result?.totals?.totalConfirmed > 0 ? "booking" : "indent"),
        orderId: result?.orderId || "",
        indentId: result?.indentId || "",
        poNumber: result?.poNumber || "",
        confirmed: result?.totals?.totalConfirmed ?? 0,
        pending: result?.totals?.totalPending ?? 0,
        lines: (result?.summary || []).length,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || "Failed to confirm the uploaded rows.");
    } finally {
      setIsConfirming(false);
    }
  };

  const goTo = (path) => {
    setOutcome(null);
    navigate(path);
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
        Upload bookings using an Excel template. Lines covered by stock become a booking and
        appear in <span className="font-semibold">Booking History</span>; anything short becomes
        an indent and appears in <span className="font-semibold">Indent History</span>.
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
                    the booking is committed, not announced afterwards. */}
                <ERPButton
                  variant="success"
                  size="lg"
                  disabled={!canConfirm}
                  onClick={handleContinue}
                  className="w-full md:w-auto px-8 shadow-md bg-green-600 hover:bg-green-700 ring-2 ring-green-300"
                >
                  <Check size={18} className="mr-2 text-white" />
                  {isConfirming ? "Adding..." : `Review & Confirm (${selectedCount})`}
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

      {/* The SAME review popup Create Booking uses. It decides for itself
          whether this is a plain confirmation or an indent review, so the two
          screens cannot drift apart on what a shortfall looks like. */}
      <ReviewIndentModal
        isOpen={!!pendingReview}
        onClose={() => setPendingReview(null)}
        onConfirm={handleConfirm}
        review={pendingReview?.review || { available: [], pending: [] }}
        loading={isConfirming}
        itemCount={pendingReview?.itemCount || 0}
        unitCount={pendingReview?.unitCount || 0}
      />

      {/* WHERE THE UPLOAD ACTUALLY WENT. A file can produce a booking, an
          indent, or both, and each lives in its own history — so the outcome
          names what was created and links to the screen that holds it. */}
      <Modal
        isOpen={!!outcome}
        onClose={() => setOutcome(null)}
        title={
          outcome?.outcome === "indent"
            ? "Indent Raised"
            : outcome?.outcome === "booking+indent"
              ? "Booking Confirmed with Indent"
              : "Booking Confirmed"
        }
        size="sm"
      >
        {outcome && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className={`w-11 h-11 rounded-full flex items-center justify-center ${
                outcome.outcome === "indent" ? "bg-amber-50" : "bg-emerald-50"
              }`}>
                {outcome.outcome === "indent"
                  ? <PackageX size={22} className="text-amber-600" />
                  : <PackageCheck size={22} className="text-emerald-600" />}
              </div>
              <div>
                <p className="text-sm font-bold text-slate-800">
                  {outcome.outcome === "indent"
                    ? `Indent ${outcome.indentId}`
                    : `Booking ${outcome.orderId}`}
                </p>
                <p className="text-xs text-slate-500">
                  {outcome.lines} line{outcome.lines === 1 ? "" : "s"} from your upload
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-black text-emerald-700">{outcome.confirmed}</p>
                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider mt-1">Units Booked</p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-black text-amber-700">{outcome.pending}</p>
                <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mt-1">Units → Indent</p>
              </div>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              {outcome.outcome === "indent"
                ? `None of the uploaded quantity was in stock, so no booking was created. Indent ${outcome.indentId} is tracked in Indent History and fulfilled when material is inwarded.`
                : outcome.outcome === "booking+indent"
                  ? `Booking ${outcome.orderId} holds the ${outcome.confirmed} unit(s) available now. The remaining ${outcome.pending} are on indent ${outcome.indentId}.`
                  : `Booking ${outcome.orderId} holds all ${outcome.confirmed} uploaded unit(s).`}
            </p>

            <div className="flex justify-end gap-3 mt-1">
              {outcome.pending > 0 && (
                <Button
                  variant={outcome.outcome === "indent" ? "primary" : "secondary"}
                  onClick={() => goTo("/orders/indent-history")}
                >
                  View Indent History
                </Button>
              )}
              {outcome.confirmed > 0 && (
                <Button variant="primary" onClick={() => goTo("/orders/history")}>
                  View Booking History
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
export default BulkUpload;
