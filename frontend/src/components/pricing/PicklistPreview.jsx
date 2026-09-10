import { motion, AnimatePresence } from "framer-motion";
import { X, Printer, FileDown, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import { ERPButton } from "../ui/ERPButton";
import { COMPANY } from "../../constants/company";
import { formatRupees, GST_LABEL } from "../../constants/pricing";

/**
 * The picklist / purchase-order preview — the document itself.
 *
 * ONE COMPONENT FOR BOTH AUDIENCES, fed by the adapters in
 * utils/picklistDocument.js. The customer's copy and the desk's copy are the
 * same paper: same columns, same layout, same totals. What differs was already
 * decided by the adapter — the desk's copy names the price schedule and carries
 * box numbers, the customer's carries neither — so nothing here has to remember
 * who is looking, and the two cannot drift into different documents.
 *
 * NO TAX COLUMN, BUT A TAX LINE. There is still no per-SKU tax rate in the
 * portal — no HSN code, only the customer's GSTIN, which is an identifier — so
 * a per-line tax column would be a number no data supports. GST is instead one
 * rate on the whole subtotal, defined once in constants/pricing.js, shown as
 * its own row and added into the payable total.
 *
 * The columns are not fixed either: `showMsilCode` on the document decides
 * whether the MSIL code column appears, and it is the CUSTOMER's category that
 * decides that, not the reader's. Both are settled by the adapter, so this
 * component still renders whatever it is handed and asks nothing.
 */

const fmtDate = (d) => {
  if (!d) return "—";
  const date = new Date(d);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const Field = ({ label, value }) => (
  <div className="flex gap-2 text-[11px] leading-relaxed">
    <span className="text-slate-500 shrink-0 w-24">{label}</span>
    <span className="font-semibold text-slate-800 break-words">{value || "—"}</span>
  </div>
);

/** Where the document is cloned to for printing — a direct child of <body>. */
const PRINT_ROOT_ID = "picklist-print-root";

/**
 * Lift the document out of the dialog, print it, put everything back.
 *
 * ---------------------------------------------------------------------------
 * WHY A CLONE, AND NOT JUST CSS
 * ---------------------------------------------------------------------------
 *
 * The previous approach hid `body *` and re-showed `#picklist-document`, then
 * pulled it to the top-left with `position: absolute`. It could not work, and
 * the reason is the ancestor chain rather than anything in the rule:
 *
 *   div.fixed.inset-0                                  positioned ancestor
 *     motion.div .relative .max-h-[92vh] .overflow-hidden   <-- the problem
 *       #picklist-document
 *
 *   1. `position: absolute` resolves against the nearest POSITIONED ancestor,
 *      which is the modal card — so "top-left" meant the top-left of the card,
 *      not of the page.
 *   2. That card is `max-h-[92vh]` with `overflow-hidden`, so it CLIPPED the
 *      document to roughly one screenful. `max-height:none; overflow:visible`
 *      on the document itself cannot undo a clip applied by an ancestor.
 *   3. framer-motion writes an inline `transform` on that same card, which
 *      makes it a containing block for fixed positioning too, and shifts
 *      whatever is inside it.
 *
 * No stylesheet can reach "every ancestor of this node" to unpick that. Moving
 * the content to a direct child of <body> removes the whole chain instead, so
 * there is nothing left to clip, offset or constrain.
 *
 * Bound to `beforeprint`/`afterprint` rather than to the button, so Ctrl+P and
 * the browser's own print menu behave identically — with the old code they
 * produced the same truncated page, and there was no button press to hook.
 */
const usePrintablePicklist = (enabled) => {
  useEffect(() => {
    if (!enabled) return undefined;

    const build = () => {
      const source = document.getElementById("picklist-document");
      if (!source || document.getElementById(PRINT_ROOT_ID)) return;

      const clone = source.cloneNode(true);
      clone.id = PRINT_ROOT_ID;
      // Drop the dialog's layout classes. `flex-1`, `overflow-y-auto` and the
      // padding are how it behaved as a pane inside a modal; on paper they
      // would reintroduce a scroll box that prints only its visible part.
      clone.className = "";
      clone.removeAttribute("style");
      document.body.appendChild(clone);
    };

    const teardown = () => document.getElementById(PRINT_ROOT_ID)?.remove();

    window.addEventListener("beforeprint", build);
    window.addEventListener("afterprint", teardown);
    return () => {
      window.removeEventListener("beforeprint", build);
      window.removeEventListener("afterprint", teardown);
      teardown();
    };
  }, [enabled]);
};

export const PicklistPreview = ({ doc, onClose, onDownload }) => {
  const [downloading, setDownloading] = useState(false);

  usePrintablePicklist(Boolean(doc));

  if (!doc) return null;

  const money = doc.totals.pricedLines > 0;
  // Cells to the left of Qty, and to the left of the amount — the two spans the
  // totals rows need. Counted, because the MSIL code column is optional.
  const labelSpan = 2 + (doc.showMsilCode ? 1 : 0);
  const moneySpan = labelSpan + 2;

  /*
   * Safari does not fire `beforeprint`. Building the clone here as well covers
   * it; `build()` is a no-op when one already exists, so the two paths cannot
   * produce two copies.
   */
  const handlePrint = () => {
    const source = document.getElementById("picklist-document");
    if (source && !document.getElementById(PRINT_ROOT_ID)) {
      const clone = source.cloneNode(true);
      clone.id = PRINT_ROOT_ID;
      clone.className = "";
      clone.removeAttribute("style");
      document.body.appendChild(clone);
    }
    window.print();
    // `afterprint` removes it on every browser that fires it. This is the
    // backstop for the ones that do not, and for a print dialog dismissed
    // without printing — a stale clone would otherwise sit in the DOM.
    window.setTimeout(() => document.getElementById(PRINT_ROOT_ID)?.remove(), 1000);
  };

  const handleDownload = async () => {
    if (!onDownload) return;
    setDownloading(true);
    const ok = await onDownload(doc);
    setDownloading(false);
    if (!ok) toast.error("The PDF could not be generated.");
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm cursor-pointer"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          className="relative w-full max-w-3xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[92vh] z-10 overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between shrink-0 bg-slate-50">
            <div>
              <h3 className="text-sm font-black text-slate-800">
                {doc.poNumber ? "Purchase Order Preview" : "Picklist Preview"}
              </h3>
              <p className="text-[11px] text-slate-500">
                {doc.poNumber
                  ? `PO ${doc.poNumber}`
                  : `Booking ${doc.orderId} — no purchase order raised yet`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onDownload && (
                <ERPButton variant="outline" size="sm" onClick={handleDownload} disabled={downloading}>
                  {downloading
                    ? <Loader2 size={14} className="mr-1.5 animate-spin" />
                    : <FileDown size={14} className="mr-1.5" />}
                  PDF
                </ERPButton>
              )}
              <ERPButton variant="outline" size="sm" onClick={handlePrint}>
                <Printer size={14} className="mr-1.5" />
                Print
              </ERPButton>
              <button
                onClick={onClose}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* The document. This node is what appears on SCREEN; printing uses a
              clone of it placed outside the dialog — see usePrintablePicklist. */}
          <div className="flex-1 overflow-y-auto p-6" id="picklist-document">
            {/* Letterhead */}
            <div className="flex items-start justify-between gap-4 pb-3 border-b-2 border-slate-800">
              <div>
                <h1 className="text-lg font-black tracking-tight text-slate-900">{COMPANY.name}</h1>
                {COMPANY.addressLines.map((line) => (
                  <p key={line} className="text-[11px] text-slate-600">{line}</p>
                ))}
                <p className="text-[11px] text-slate-600">
                  {[COMPANY.phone, COMPANY.email, COMPANY.website].filter(Boolean).join("  ·  ")}
                </p>
                {COMPANY.gstin && (
                  <p className="text-[11px] text-slate-600">GSTIN: {COMPANY.gstin}</p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  {doc.poNumber ? "Purchase Order" : "Picklist"}
                </p>
                <p className="text-base font-black font-mono text-slate-900">
                  {doc.poNumber || doc.orderId}
                </p>
                <p className="text-[11px] text-slate-600">{fmtDate(doc.poDate || doc.date)}</p>
              </div>
            </div>

            {/* Parties and terms */}
            <div className="picklist-pair grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 py-3 border-b border-slate-200">
              <div className="flex flex-col gap-0.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                  Billed to
                </p>
                <Field label="Customer" value={doc.customer.name} />
                {doc.customer.company && doc.customer.company !== doc.customer.name && (
                  <Field label="Company" value={doc.customer.company} />
                )}
                <Field label="Contact No." value={doc.customer.phone} />
                {/* "Place of supply" removed: it printed the delivery TOWN under a
                    heading that reads like an address, which the Shipping and
                    Billing blocks below now state in full. */}
                <Field label="GST No." value={doc.customer.gstNumber} />
                {doc.customer.shopNumber && <Field label="Shop No." value={doc.customer.shopNumber} />}
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                  Order
                </p>
                <Field label="Booking No." value={doc.orderId} />
                <Field label="PO No." value={doc.poNumber || "Not raised"} />
                <Field label="PO Date" value={doc.poDate ? fmtDate(doc.poDate) : "—"} />
                <Field label="Payment Term" value={doc.paymentTerm} />
                <Field label="Supply By" value={doc.promiseDate ? fmtDate(doc.promiseDate) : "—"} />
                {doc.customer.vendorCode && <Field label="Vendor Code" value={doc.customer.vendorCode} />}
                {/* Internal copies only — the adapter leaves this null for a
                    customer, so the tier is never named on their paper. */}
                {doc.priceTypeLabel && (
                  <Field label="Price Type" value={doc.priceTypeLabel} />
                )}
              </div>
            </div>

            {/*
              Shipping and billing, side by side and full width.

              Their own row rather than two more `Field`s in the grid above: a
              `Field` is a single label/value line, and an address is several —
              it would either clip or push the terms column out of alignment.

              BOTH HEADINGS ALWAYS RENDER, even when the two addresses are the
              same. Showing one heading would leave the reader unable to tell
              "billing is the same" apart from "billing is unknown".

              `whitespace-pre-line` so a multi-line address stored with newlines
              prints as the customer typed it.
            */}
            <div className="picklist-pair grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 py-3 border-b border-slate-200">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                  Shipping Address
                </p>
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-line">
                  {doc.customer.shippingAddress || "—"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                  Billing Address
                </p>
                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-line">
                  {doc.customer.billingAddress || "—"}
                </p>
              </div>
            </div>

            {/* Lines */}
            <table className="w-full mt-4 text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 text-[10px] font-bold uppercase text-slate-600">
                  <th className="px-2 py-2 border border-slate-300 w-10 text-center">Sr.</th>
                  {/* MSIL customers only — see the note at the top. */}
                  {doc.showMsilCode && (
                    <th className="px-2 py-2 border border-slate-300">MSIL Code</th>
                  )}
                  <th className="px-2 py-2 border border-slate-300">Ko-ken Code</th>
                  <th className="px-2 py-2 border border-slate-300 w-16 text-right">Qty</th>
                  {money && <th className="px-2 py-2 border border-slate-300 w-24 text-right">Price</th>}
                  {money && <th className="px-2 py-2 border border-slate-300 w-28 text-right">Total</th>}
                  {doc.showBoxNo && <th className="px-2 py-2 border border-slate-300 w-20">Box</th>}
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((line) => (
                  <tr key={`${line.skuCode}-${line.sr}`} className="text-xs">
                    <td className="px-2 py-1.5 border border-slate-300 text-center text-slate-600">
                      {line.sr}
                    </td>
                    {doc.showMsilCode && (
                      <td className="px-2 py-1.5 border border-slate-300 font-mono text-slate-700">
                        {line.msilCode || "—"}
                      </td>
                    )}
                    <td className="px-2 py-1.5 border border-slate-300 font-mono font-semibold text-slate-800">
                      {line.skuCode}
                    </td>
                    <td className="px-2 py-1.5 border border-slate-300 text-right font-semibold text-slate-800">
                      {line.quantity}
                    </td>
                    {money && (
                      <td className="px-2 py-1.5 border border-slate-300 text-right text-slate-700">
                        {formatRupees(line.unitPrice)}
                      </td>
                    )}
                    {money && (
                      <td className="px-2 py-1.5 border border-slate-300 text-right font-bold text-slate-900">
                        {formatRupees(line.amount)}
                      </td>
                    )}
                    {doc.showBoxNo && (
                      <td className="px-2 py-1.5 border border-slate-300 text-slate-600">
                        {line.boxNo || "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 text-xs">
                  <td colSpan={labelSpan} className="px-2 py-2 border border-slate-300 text-right font-bold text-slate-600">
                    {money ? "Subtotal" : "Total"}
                  </td>
                  <td className="px-2 py-2 border border-slate-300 text-right font-black text-slate-900">
                    {doc.totals.quantity}
                  </td>
                  {money && <td className="px-2 py-2 border border-slate-300" />}
                  {money && (
                    <td className="px-2 py-2 border border-slate-300 text-right font-black text-slate-900">
                      {formatRupees(doc.totals.amount)}
                    </td>
                  )}
                  {doc.showBoxNo && <td className="px-2 py-2 border border-slate-300" />}
                </tr>
                {/* The tax, then what is payable. Stated as two rows rather than
                    one net figure, because a document that only shows the total
                    cannot be checked against the rate it was charged at. */}
                {money && (
                  <tr className="bg-slate-50 text-xs">
                    <td colSpan={moneySpan} className="px-2 py-2 border border-slate-300 text-right font-bold text-slate-600">
                      {GST_LABEL}
                    </td>
                    <td className="px-2 py-2 border border-slate-300 text-right font-bold text-slate-800">
                      {formatRupees(doc.totals.gstAmount)}
                    </td>
                    {doc.showBoxNo && <td className="px-2 py-2 border border-slate-300" />}
                  </tr>
                )}
                {money && (
                  <tr className="bg-slate-200 text-xs">
                    <td colSpan={moneySpan} className="px-2 py-2 border border-slate-300 text-right font-black text-slate-800">
                      Grand Total
                    </td>
                    <td className="px-2 py-2 border border-slate-300 text-right font-black text-slate-900">
                      {formatRupees(doc.totals.grandTotal)}
                    </td>
                    {doc.showBoxNo && <td className="px-2 py-2 border border-slate-300" />}
                  </tr>
                )}
              </tfoot>
            </table>

            {/* A total that skips lines has to say so, on the document itself. */}
            {money && doc.totals.unpricedLines > 0 && (
              <p className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                {doc.totals.unpricedLines} line(s) have no rate on file and are not included in the
                total.
              </p>
            )}

            {doc.lines.some((l) => l.pendingQty > 0) && (
              <p className="mt-2 text-[11px] text-slate-600">
                Quantities shown are what is being supplied against this order. Any remainder is
                held on an indent and will follow separately.
              </p>
            )}

            <p className="mt-4 pt-3 border-t border-slate-200 text-[10px] text-slate-400 leading-relaxed">
              {money
                ? `Amounts are in Indian Rupees. ${GST_LABEL} is charged on the subtotal and included in the grand total.`
                : "This document lists the items on the order. No pricing has been applied to it."}
              {" "}Generated from the Shraddha Impex customer portal on {fmtDate(new Date())}.
            </p>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default PicklistPreview;
