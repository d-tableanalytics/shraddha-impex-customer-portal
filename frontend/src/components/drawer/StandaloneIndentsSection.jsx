import { PackageX } from "lucide-react";

import { CodeValue } from "../ui/CodeValue";
import { HeldIndentStatus } from "./MsilSupply";
import { formatRupees } from "../../constants/pricing";

/**
 * ── STANDALONE INDENTS, AS THEIR OWN TABLE ─────────────────────────────────
 *
 * The materials on this booking that Booking Items has no row for.
 *
 * Confirmation only writes an order row when `confirmedQty > 0`, so a SKU
 * stock could not cover AT ALL never became one. It exists purely as a
 * reservation under the booking's `PI-` number — on the customer's purchase
 * order, owed to them, and visible NOWHERE in the table above. That is exactly
 * the line a desk checking a booking against the customer's paper PO must not
 * miss, and the one it used to have to notice by comparing two lists by eye.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SECOND TABLE AND NOT MORE ROWS IN THE FIRST
 * ---------------------------------------------------------------------------
 *
 * Booking Items is a table of ORDER ROWS: booked, confirmed, pending, a price,
 * a box number, and — while the booking is open — controls that edit them.
 * A standalone line has none of those, because it has no order row. Giving it
 * a row there would mean inventing zeroes for every one of those columns, and
 * the moment a zero is invented, every total on that table means something
 * different from what it meant before.
 *
 * So the booking's open indent is PARTITIONED, exactly as the confirmation
 * email partitions it: a SKU that Booking Items accounts for keeps its
 * shortfall in the Indent card below, a SKU it does not appears here, and no
 * SKU is in both. The two tables added together are the whole open indent,
 * which is what makes either of them safe to read on its own.
 *
 * ---------------------------------------------------------------------------
 * BOOKING ID AND INDENT ID ON EVERY ROW
 * ---------------------------------------------------------------------------
 *
 * Both are constant down the table — one booking, one indent — and are shown
 * per row all the same, because the question this table answers for the desk
 * is "is this indent really against THIS booking?". An answer that has to be
 * carried down from a heading is an answer that gets carried down wrongly.
 *
 * `mayPrice` adds the rate, on the same permission the rest of the drawer
 * uses. It is not one of the columns this table was asked for, but these lines
 * were priced before they were moved here and dropping the money for a reader
 * who is allowed to see it would be a loss, not a simplification.
 */
export function StandaloneIndentsSection({
  orderId,
  indentNumber,
  lines = [],
  mayPrice = false,
  mayDecideIndent = false,
  onDecided,
}) {
  // Nothing standalone means nothing to say. A booking whose indent is
  // entirely partial, or which has no indent at all, gets the screen it
  // always had.
  if (!lines.length) return null;

  const totalQty = lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  const rated = lines.filter((l) => l.amount != null);
  const amount = rated.reduce((n, l) => n + l.amount, 0);
  const unrated = lines.length - rated.length;

  return (
    <div
      className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden"
      data-testid="standalone-indents"
    >
      <div className="px-5 py-4 border-b border-amber-100 bg-amber-50/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PackageX size={18} className="text-amber-600" />
          <div>
            <h3 className="text-sm font-bold text-slate-800">
              Standalone Indents
              {indentNumber && (
                <span className="ml-2 font-mono text-xs font-bold text-slate-500">
                  {indentNumber}
                </span>
              )}
            </h3>
            <p className="text-[11px] text-slate-500">
              {lines.length} material(s) · {totalQty} pc(s) — stock covered none of these, so they
              have no row in Booking Items above.
            </p>
          </div>
        </div>
        {mayPrice && rated.length > 0 && (
          <span className="text-base font-black text-slate-900 tabular-nums">
            {formatRupees(amount)}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            <tr>
              <th className="px-5 py-3 w-[15%] min-w-[130px]">Booking ID</th>
              <th className="px-5 py-3 w-[15%] min-w-[130px]">Indent ID</th>
              <th className="px-5 py-3 w-[20%] min-w-[150px]">SKU / Product Code</th>
              <th className="px-5 py-3 w-[22%] min-w-[150px]">Product Name</th>
              <th className="px-5 py-3 text-center w-[110px]">Indent Quantity</th>
              <th className="px-5 py-3">Status</th>
              {mayPrice && <th className="px-5 py-3 text-right w-[130px]">Price</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {lines.map((line) => (
              <tr key={line.reservationId || line.skuCode} className="align-top">
                <td className="px-5 py-3">
                  <CodeValue value={orderId} tone="muted" />
                </td>
                <td className="px-5 py-3">
                  <CodeValue value={line.indentNumber || indentNumber} tone="muted" />
                </td>
                <td className="px-5 py-3">
                  <CodeValue value={line.skuCode} />
                  {line.msilCode && (
                    <div className="mt-1">
                      <CodeValue value={line.msilCode} tone="muted" />
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-slate-600">
                  {line.productName || (
                    <span className="text-slate-300" title="No name on the product master.">
                      —
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-center font-bold text-amber-700 tabular-nums">
                  {line.quantity}
                </td>
                <td className="px-5 py-3">
                  <span className="text-[11px] font-semibold text-slate-600">{line.status}</span>
                  {line.expiresOn && (
                    <div
                      className="text-[10px] text-slate-400"
                      title="The reservation lapses on this date unless it is filled first."
                    >
                      expires {new Date(line.expiresOn).toLocaleDateString()}
                    </div>
                  )}
                  {/*
                    MSIL supply check: a held line gets Convert / Cancel here
                    too. These lines used to sit in the Indent card, which
                    offered the control — moving them out without it would have
                    quietly taken the decision away from the desk.
                  */}
                  <HeldIndentStatus line={line} canDecide={mayDecideIndent} onDone={onDecided} />
                </td>
                {mayPrice && (
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {line.unitPrice == null ? (
                      <span
                        className="text-[11px] font-semibold text-amber-600"
                        title="No rate for this SKU on the booking or in the product master."
                      >
                        Not rated
                      </span>
                    ) : (
                      <>
                        <div className="font-bold text-slate-800 tabular-nums">
                          {formatRupees(line.unitPrice)}
                        </div>
                        {line.amount != null && (
                          <div className="text-[11px] text-slate-500 tabular-nums">
                            {formatRupees(line.amount)}
                          </div>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50/60 border-t border-slate-200 text-sm">
            <tr>
              <td colSpan={4} className="px-5 py-3 text-right font-bold text-slate-600">
                Total
              </td>
              <td className="px-5 py-3 text-center font-black text-amber-700 tabular-nums">
                {totalQty}
              </td>
              <td className="px-5 py-3" />
              {mayPrice && <td className="px-5 py-3" />}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="px-5 py-3 border-t border-amber-100 bg-amber-50/40 text-xs text-amber-800">
        These materials are owed to the customer but are not on the booking above — check them
        against the customer&apos;s PO before raising yours. They are scheduled once stock is
        inwarded against the indent.
        {mayPrice && unrated > 0 && (
          <span className="font-semibold">
            {" "}{unrated} line(s) could not be rated, so the total above leaves them out.
          </span>
        )}
      </div>
    </div>
  );
}

export default StandaloneIndentsSection;
