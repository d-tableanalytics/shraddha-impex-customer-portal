import { AlertTriangle, PackageCheck, Clock } from "lucide-react";

import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Pagination } from "../ui/Pagination";
import { usePagination } from "../../hooks/usePagination";

/**
 * Review Indent — the popup shown before a booking is confirmed.
 *
 * ONE component, used by Individual Booking and by Bulk Upload. It was written
 * inline in the individual flow, and bulk confirmed with no review at all; the
 * two now differ only in where their lines come from. Keeping a single copy is
 * what makes "identical UI, validations and behaviour" true rather than
 * something that has to be re-checked whenever either screen changes.
 *
 * When nothing is short, this renders the plain confirmation instead — the same
 * decision the individual flow already made, moved inside so every caller gets
 * it for free rather than each remembering to branch.
 */

const REVIEW_PAGE_SIZE = 10;

const ValidityNotice = () => (
  <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
    <Clock size={14} className="text-red-500 shrink-0" />
    <p className="text-[11px] text-red-700 leading-relaxed">
      Booking valid for <span className="font-semibold">7 days</span>. Items are released if no PO is received.
    </p>
  </div>
);

export const ReviewIndentModal = ({
  isOpen,
  onClose,
  onConfirm,
  review = { available: [], pending: [] },
  loading = false,
  itemCount = 0,
  unitCount = 0,
}) => {
  // Hooks run unconditionally — a bulk upload can list hundreds of lines, so
  // both breakdowns page.
  const availablePaging = usePagination(review.available, REVIEW_PAGE_SIZE);
  const indentPaging = usePagination(review.pending, REVIEW_PAGE_SIZE);

  const hasIndent = review.pending.length > 0;

  // ── Nothing short: the plain confirmation ────────────────────────────────
  if (!hasIndent) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Confirm Booking" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-700 leading-relaxed">
            You&apos;re about to confirm {itemCount} item{itemCount === 1 ? "" : "s"}
            {" "}({unitCount} units).
          </p>

          <ValidityNotice />

          <div className="flex justify-end gap-3 mt-2">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={loading}>
              Confirm Booking
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Something is short: the indent review ────────────────────────────────
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Review Indent" size="lg">
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <AlertTriangle size={20} className="text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-slate-700 leading-relaxed">
            Some items exceed the available quantity. Review what will be booked now versus
            what becomes a <span className="font-bold">Indent</span> (fulfilled when
            fresh stock arrives), then continue.
          </p>
        </div>

        {/* Available for booking */}
        <div>
          <h4 className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <PackageCheck size={14} /> Available for booking ({review.available.length})
          </h4>
          {review.available.length === 0 ? (
            <p className="text-xs text-slate-400 italic px-1">No stock available for these items right now.</p>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5">SKU Code</th>
                      <th className="px-4 py-2.5 text-center">Requested</th>
                      <th className="px-4 py-2.5 text-center">Booking Now</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {availablePaging.pageItems.map((l) => (
                      <tr key={l.code}>
                        <td className="px-4 py-2.5 font-bold text-slate-800">{l.code}</td>
                        <td className="px-4 py-2.5 text-center text-slate-600">{l.requested}</td>
                        <td className="px-4 py-2.5 text-center font-bold text-emerald-600">{l.bookable}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2.5 border-t border-slate-200 bg-slate-50/50">
                <Pagination
                  page={availablePaging.page}
                  pageSize={REVIEW_PAGE_SIZE}
                  totalItems={availablePaging.total}
                  onPageChange={availablePaging.setPage}
                />
              </div>
            </div>
          )}
        </div>

        {/* Converts to indent */}
        <div>
          <h4 className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <AlertTriangle size={14} /> Converts to Indent ({review.pending.length})
          </h4>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5">SKU Code</th>
                    <th className="px-4 py-2.5 text-center">Requested</th>
                    <th className="px-4 py-2.5 text-center">AVL</th>
                    <th className="px-4 py-2.5 text-center">Indent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {indentPaging.pageItems.map((l) => (
                    <tr key={l.code}>
                      <td className="px-4 py-2.5 font-bold text-slate-800">{l.code}</td>
                      <td className="px-4 py-2.5 text-center text-slate-600">{l.requested}</td>
                      <td className="px-4 py-2.5 text-center text-slate-600">{l.available}</td>
                      <td className="px-4 py-2.5 text-center font-bold text-amber-600">{l.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2.5 border-t border-slate-200 bg-slate-50/50">
              <Pagination
                page={indentPaging.page}
                pageSize={REVIEW_PAGE_SIZE}
                totalItems={indentPaging.total}
                onPageChange={indentPaging.setPage}
              />
            </div>
          </div>
        </div>

        <ValidityNotice />

        <div className="flex items-center justify-between gap-3 mt-2">
          <p className="text-[11px] text-slate-500 font-medium">
            Confirming raises {review.pending.length} indent{review.pending.length === 1 ? "" : "s"} in one step.
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm} disabled={loading}>
              <AlertTriangle size={16} className="mr-2" />
              Raise All Indents &amp; Confirm
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ReviewIndentModal;
