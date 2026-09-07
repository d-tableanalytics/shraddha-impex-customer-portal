import { motion, AnimatePresence } from "framer-motion";
import { X, Printer, FileDown, Loader2 } from "lucide-react";
import { useState } from "react";
import toast from "react-hot-toast";

import { ERPButton } from "../ui/ERPButton";
import { COMPANY } from "../../constants/company";
import { formatRupees } from "../../constants/pricing";

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
 * NO TAX COLUMN. The reference invoice this is modelled on carries GST, and the
 * portal holds no tax rate for any SKU — only the customer's GSTIN, which is an
 * identifier rather than a rate. A GST column computed from a rate nobody
 * entered would be a number on a commercial document that no data supports, so
 * the document prices the goods and says so.
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

export const PicklistPreview = ({ doc, onClose, onDownload }) => {
  const [downloading, setDownloading] = useState(false);

  if (!doc) return null;

  const money = doc.totals.pricedLines > 0;
  const columns = 3 + (doc.showBoxNo ? 1 : 0) + 1 + (money ? 2 : 0);

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
              <ERPButton variant="outline" size="sm" onClick={() => window.print()}>
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

          {/* The document. `print:` utilities strip the chrome so Print gives
              the paper rather than a screenshot of a dialog. */}
          <div className="flex-1 overflow-y-auto p-6 print:p-0 print:overflow-visible" id="picklist-document">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 py-3 border-b border-slate-200">
              <div className="flex flex-col gap-0.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">
                  Billed to
                </p>
                <Field label="Customer" value={doc.customer.name} />
                {doc.customer.company && doc.customer.company !== doc.customer.name && (
                  <Field label="Company" value={doc.customer.company} />
                )}
                <Field label="Contact No." value={doc.customer.phone} />
                <Field label="Place of supply" value={doc.customer.location} />
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

            {/* Lines */}
            <table className="w-full mt-4 text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 text-[10px] font-bold uppercase text-slate-600">
                  <th className="px-2 py-2 border border-slate-300 w-10 text-center">Sr.</th>
                  <th className="px-2 py-2 border border-slate-300">Item Code</th>
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
                    <td className="px-2 py-1.5 border border-slate-300 font-mono text-slate-700">
                      {line.itemCode || "—"}
                    </td>
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
                  <td colSpan={3} className="px-2 py-2 border border-slate-300 text-right font-bold text-slate-600">
                    Total
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
                ? "Amounts are in Indian Rupees and exclude any applicable taxes."
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
