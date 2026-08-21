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
import { computeReview, linesFromBulkRows } from "../../utils/bookingReview";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";

export const BulkUpload = () => {
  const navigate = useNavigate();
  const { file, rows, summary, setFile, setRows, updateRow, reset: resetStore } =
    useBulkImportStore();
  // Only to refresh the Selection List badge afterwards. An upload no longer
  // writes to the list, but a booking consumes stock, and any line the customer
  // is already holding is worth re-reading once the numbers have moved.
  const { fetchReservations } = useCartStore();
  // Regular customers upload by SKU Code alone.
  const showMsilCode = useShowMsilCode();
  const [isParsing, setIsParsing] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [excludedRowIds, setExcludedRowIds] = useState([]);
  const [outcome, setOutcome] = useState(null);

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

  // The rows that will actually be booked, and how they split between stock and
  // indent. Computed from the SELECTED rows themselves — with the Selection List
  // out of the flow, the file is now exactly the set that gets committed, so the
  // preview and the outcome cannot disagree.
  const selectedRows = rows.filter(
    (r) => (r.status === "valid" || r.status === "warning") && r.product && selectedRowIds.includes(r.id),
  );
  const bookingItems = selectedRows.map((r) => ({
    productId: r.product.id,
    quantity: Number(r.quantity) || 0,
  }));
  // Shown inline above the button. The blocking review popup is gone — an
  // uploaded sheet books directly now — so the indent split has to be visible
  // BEFORE the click rather than announced after it.
  const shortfall = computeReview(linesFromBulkRows(selectedRows));
  const indentUnits = shortfall.pending.reduce((n, p) => n + p.pending, 0);
  const bookableUnits = shortfall.available.reduce((n, a) => n + a.bookable, 0);

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

  /**
   * "Continue to Booking" — create the booking, in one step.
   *
   * The upload used to be staged through the Selection List: this handler
   * reserved every row, then asked the customer to confirm the list. That was
   * the wrong shape for a sheet. Uploading a booking sheet IS the instruction to
   * book, so the second prompt asked the same question twice — and if the
   * customer closed the page at it, the entire file was left stranded in their
   * Selection List, where the confirm would later sweep it into an unrelated
   * booking. Worse, that confirm committed the WHOLE list, so lines the customer
   * was already holding arrived inside a booking made from a file that never
   * mentioned them.
   *
   * One request now reserves and confirms only the selected rows, inside a
   * single transaction on the server. The sheet either becomes a booking — plus
   * an indent for anything stock could not cover — or nothing is written and the
   * rows stay here with the reason. Nothing passes through the Selection List.
   */
  const handleContinue = async () => {
    if (bookingItems.length === 0) {
      toast.error("Select at least one row to book.");
      return;
    }

    setIsConfirming(true);
    try {
      const result = await reservationsApi.directBooking(bookingItems);

      // The upload has been committed, so the session is cleared — the rows are
      // now a booking and re-submitting them would book them twice.
      reset();
      // A booking consumes stock and may close an indent the customer was
      // holding, so the list badge should not keep showing the old position.
      fetchReservations();

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
      // Nothing was written — the whole request is one transaction — so the rows
      // are still on screen and can be corrected and re-submitted. The server's
      // message names the offending SKU.
      toast.error(
        err.response?.data?.message || err.message || "Failed to create the booking from this upload.",
      );
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
        Upload bookings using an Excel template, then click{" "}
        <span className="font-semibold">Continue to Booking</span> to create the booking directly —
        the sheet does not go through your Selection List. Lines covered by stock become a booking
        and appear in <span className="font-semibold">Booking History</span>; anything short becomes
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

              {/* What the click will produce, stated before it happens. The
                  booking is created directly, so there is no review popup to
                  carry this — and a customer who uploads 900 units of something
                  with 12 in stock must not discover the split afterwards. */}
              {indentUnits > 0 && (
                <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
                  <PackageX size={18} className="text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-sm text-amber-900">
                    <p className="font-bold">
                      {bookableUnits > 0
                        ? `${bookableUnits} unit(s) will be booked now; ${indentUnits} will move to an indent.`
                        : `None of the ${indentUnits} uploaded unit(s) are in stock — this will raise an indent, not a booking.`}
                    </p>
                    <p className="text-xs mt-1 text-amber-800">
                      {shortfall.pending
                        .slice(0, 4)
                        .map((p) => `${p.code} (${p.available} of ${p.requested} in stock)`)
                        .join(", ")}
                      {shortfall.pending.length > 4 && ` and ${shortfall.pending.length - 4} more`}
                      . Indented lines are fulfilled automatically when material is inwarded.
                    </p>
                  </div>
                </div>
              )}

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
                {/* One button, one step. It creates the booking — the sheet does
                    not pass through the Selection List. */}
                <ERPButton
                  variant="success"
                  size="lg"
                  disabled={!canConfirm}
                  onClick={handleContinue}
                  className="w-full md:w-auto px-8 shadow-md bg-green-600 hover:bg-green-700 ring-2 ring-green-300"
                >
                  <Check size={18} className="mr-2 text-white" />
                  {isConfirming ? "Creating booking..." : `Continue to Booking (${selectedCount})`}
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

      {/* No review popup here. A bulk upload books directly, and the split
          between stock and indent is shown inline above the button instead — see
          the shortfall notice. The individual booking screen still reviews,
          because there the customer is assembling a list item by item rather
          than submitting a file they have already checked. */}

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
              {/* Indent-only or combined: show Indent History button */}
              {(outcome.outcome === "indent" || outcome.outcome === "booking+indent" || outcome.pending > 0) && (
                <Button
                  variant={outcome.outcome === "indent" ? "primary" : "secondary"}
                  onClick={() => goTo("/orders/indent-history")}
                >
                  View Indent History
                </Button>
              )}
              {/* Booking-only or combined: show Booking History button.
                  Never shown for indent-only outcomes. */}
              {outcome.outcome !== "indent" && (outcome.confirmed > 0 || outcome.outcome === "booking" || outcome.outcome === "booking+indent") && (
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
