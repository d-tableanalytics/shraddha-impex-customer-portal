import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { PageHeader } from "../../components/common/PageHeader";
import { Button } from "../../components/ui/Button";
import { o2dApi, formatDate } from "../../services/o2d/orders";
import { o2dRoute } from "@shared/constants/o2d.js";
import { O2dApiError } from "../../services/o2d/client";

/**
 * Order intake (§2, §26, §27).
 *
 * ---------------------------------------------------------------------------
 * THE DUPLICATE CHECK RUNS WHILE YOU TYPE
 * ---------------------------------------------------------------------------
 *
 * §26 asks for a duplicate check at entry. A check that only fires on submit —
 * after twenty lines have been keyed — is one people learn to dismiss, so this
 * calls `/orders/check-duplicate` as soon as both the PO number and customer are
 * filled, debounced, and shows the offending order with a link to open it.
 *
 * It is a WARNING here and a REFUSAL on the server, and that asymmetry is
 * deliberate: the browser's answer can be stale by the time Submit is pressed,
 * so the server re-checks and the partial unique index refuses regardless.
 *
 * ---------------------------------------------------------------------------
 * THE PROMISE DATE IS REQUIRED, WITH A NAMED EXCEPTION
 * ---------------------------------------------------------------------------
 *
 * §27. The form does not silently allow a blank: leaving it empty reveals a
 * reason box, and the reason is stored ON the order so the gap is visible on the
 * tracker rather than inferred from a null six weeks later.
 */

const EMPTY_LINE = { skuCode: "", productName: "", orderedQty: "" };

export function NewOrderPage() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    poNumber: "",
    poDate: "",
    customerName: "",
    promiseDate: "",
    promiseDateOverrideReason: "",
    stockStatus: "",
    remarks: "",
  });
  const [items, setItems] = useState([{ ...EMPTY_LINE }]);
  const [duplicate, setDuplicate] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  // ── the Customer Portal booking behind this PO (§3) ─────────────────────
  const [bookingSearch, setBookingSearch] = useState("");
  const [bookingOptions, setBookingOptions] = useState([]);
  const [booking, setBooking] = useState(null);
  const [bookingsLoading, setBookingsLoading] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  // ── the live duplicate check ────────────────────────────────────────────
  const checkDuplicate = useCallback(async () => {
    if (!form.poNumber.trim() || !form.customerName.trim()) {
      setDuplicate(null);
      return;
    }
    try {
      const { duplicate: found } = await o2dApi.checkDuplicate(form.poNumber, form.customerName);
      setDuplicate(found);
    } catch {
      // A failed check must not block entry — the server re-checks on submit,
      // and refusing to let someone type because a lookup timed out is worse
      // than warning late.
      setDuplicate(null);
    }
  }, [form.poNumber, form.customerName]);

  useEffect(() => {
    const t = setTimeout(checkDuplicate, 400);
    return () => clearTimeout(t);
  }, [checkDuplicate]);

  /**
   * The bookings still waiting for an O2D order (§3).
   *
   * Loaded once on mount and re-queried as the user searches. The endpoint
   * already hides bookings that have a live O2D order, so the list is "what
   * still needs doing" rather than a full customer ledger.
   *
   * A failed load leaves the picker empty and says so rather than blocking the
   * form: a PO that arrives by email has no booking behind it, and intake must
   * stay possible when this lookup is unavailable.
   */
  useEffect(() => {
    let cancelled = false;
    setBookingsLoading(true);
    const t = setTimeout(async () => {
      try {
        const { rows } = await o2dApi.bookings({
          search: bookingSearch.trim() || undefined,
          pageSize: 25,
        });
        if (!cancelled) setBookingOptions(rows ?? []);
      } catch {
        if (!cancelled) setBookingOptions([]);
      } finally {
        if (!cancelled) setBookingsLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [bookingSearch]);

  /**
   * Picking a booking PREFILLS the form; it does not lock it.
   *
   * The customer name is copied because the server refuses a mismatch, so
   * leaving the user to retype it exactly would be a trap. Everything else is a
   * starting point they may correct — the PO number in particular, which is
   * what the customer wrote on the paper PO and is often not what the portal
   * generated.
   */
  const pickBooking = (row) => {
    setBooking(row);
    setForm((f) => ({
      ...f,
      customerName: row.customerName ?? f.customerName,
      poNumber: f.poNumber || (row.poNumber && row.poNumber !== "-" ? row.poNumber : ""),
      promiseDate: f.promiseDate || (row.promiseDate ? row.promiseDate.slice(0, 10) : ""),
    }));

    // The booking's lines are the obvious starting point for the order's, but
    // only when the user has not already keyed some — overwriting typed work
    // is never the helpful reading of a click.
    const hasTyped = items.some((r) => r.skuCode.trim() || String(r.orderedQty).trim());
    if (!hasTyped && row.lines?.length) {
      setItems(
        row.lines.map((l) => ({
          skuCode: l.skuCode ?? "",
          productName: "",
          // What was actually confirmed, falling back to what was booked: a
          // partially confirmed line should not silently order the full
          // quantity the customer originally asked for.
          orderedQty: String(l.confirmedQty || l.bookedQty || ""),
        })),
      );
    }
  };

  const clearBooking = () => setBooking(null);

  // ── lines ───────────────────────────────────────────────────────────────
  const setLine = (index, key, value) =>
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, [key]: value } : r)));

  const addLine = () => setItems((rows) => [...rows, { ...EMPTY_LINE }]);
  const removeLine = (index) => setItems((rows) => rows.filter((_, i) => i !== index));

  const submit = async (event) => {
    event.preventDefault();
    setFieldError(null);
    setSubmitting(true);

    // Blank rows are dropped rather than rejected: an empty spare line at the
    // bottom of a grid is how people work, not a mistake to report.
    const lines = items
      .filter((r) => r.skuCode.trim() && String(r.orderedQty).trim())
      .map((r, i) => ({
        skuCode: r.skuCode.trim(),
        productName: r.productName.trim() || null,
        lineSeq: i + 1,
        orderedQty: Number(r.orderedQty),
      }));

    try {
      const { order } = await o2dApi.create({
        poNumber: form.poNumber.trim(),
        // `datetime-local` has no zone. The business runs on IST, so it is
        // stamped explicitly rather than left to the browser's locale.
        poDate: new Date(`${form.poDate}T00:00:00+05:30`).toISOString(),
        customerName: form.customerName.trim(),
        // §3 — the relationship to the Customer Portal booking, kept on the
        // order. Null when this PO arrived without one, which is ordinary.
        sourceBookingId: booking?.bookingId ?? null,
        promiseDate: form.promiseDate
          ? new Date(`${form.promiseDate}T00:00:00+05:30`).toISOString()
          : null,
        promiseDateOverrideReason: form.promiseDate
          ? null
          : form.promiseDateOverrideReason.trim() || null,
        stockStatus: form.stockStatus.trim() || null,
        remarks: form.remarks.trim() || null,
        items: lines,
      });

      toast.success(`${order.poNumber} created.`);
      navigate(o2dRoute("orders"));
    } catch (err) {
      const error = err instanceof O2dApiError ? err : new O2dApiError(err.message);
      if (error.isUserCorrectable) {
        // Shown inline next to the form rather than as a toast that vanishes:
        // these are all things the user must change something to resolve.
        setFieldError(error.message);
        if (error.code === "O2D_DUPLICATE_PO" && error.data?.duplicate) {
          setDuplicate(error.data.duplicate);
        }
      } else {
        toast.error(error.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const input =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500";
  const label = "block text-xs font-medium text-slate-600 mb-1";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="New order"
        subtitle="Key in a customer PO. Stage 1 completes the moment it is saved."
        actions={
          <Button variant="secondary" size="sm" onClick={() => navigate(o2dRoute("orders"))}>
            Cancel
          </Button>
        }
      />

      <form onSubmit={submit} className="flex flex-col gap-4">
        {/*
          §3 — the customer's booking, reviewed before the order is created.

          FIRST on the page and OPTIONAL, which is the whole design. Most POs
          that reach FMS started as a portal booking, and linking them is what
          lets Order 360 answer "where did this come from". But a PO that
          arrived by email has no booking, and an intake form that demanded one
          would make those unenterable — so this prefills and links, and never
          blocks.
        */}
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-slate-800">Customer booking</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Link this PO to the booking it came from. Leave it blank for a PO that arrived
            without one.
          </p>

          {booking ? (
            <div className="mt-3 rounded-lg border border-primary-200 bg-primary-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-primary-900">
                    {booking.bookingId} — {booking.customerName}
                  </p>
                  <p className="mt-0.5 text-xs text-primary-800">
                    {booking.lineCount} line{booking.lineCount === 1 ? "" : "s"},{" "}
                    {booking.totalConfirmedQty || booking.totalBookedQty} unit(s)
                    {booking.bookedAt ? ` · booked ${formatDate(booking.bookedAt)}` : ""}
                    {booking.status ? ` · ${booking.status}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-xs font-medium text-primary-800 underline"
                  onClick={clearBooking}
                >
                  Unlink
                </button>
              </div>

              {booking.lines?.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-primary-700">
                      <tr>
                        <th className="py-1 pr-3 font-medium">SKU</th>
                        <th className="py-1 pr-3 font-medium">Booked</th>
                        <th className="py-1 font-medium">Confirmed</th>
                      </tr>
                    </thead>
                    <tbody className="text-primary-900">
                      {booking.lines.map((l) => (
                        <tr key={l.skuCode}>
                          <td className="py-0.5 pr-3">{l.skuCode}</td>
                          <td className="py-0.5 pr-3">{l.bookedQty}</td>
                          <td className="py-0.5">{l.confirmedQty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <label className="sr-only" htmlFor="bookingSearch">
                Search customer bookings
              </label>
              <input
                id="bookingSearch"
                className={input}
                placeholder="Search by booking id, customer, PO number or SKU"
                value={bookingSearch}
                onChange={(e) => setBookingSearch(e.target.value)}
              />

              <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-slate-200">
                {bookingsLoading && (
                  <p className="p-3 text-xs text-slate-500">Loading bookings…</p>
                )}
                {!bookingsLoading && bookingOptions.length === 0 && (
                  <p className="p-3 text-xs text-slate-500">
                    No bookings are waiting for an order. Key the PO in below.
                  </p>
                )}
                {!bookingsLoading &&
                  bookingOptions.map((row) => (
                    <button
                      key={row.bookingId}
                      type="button"
                      onClick={() => pickBooking(row)}
                      className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50"
                    >
                      <span className="text-sm text-slate-800">{row.bookingId}</span>
                      <span className="text-xs text-slate-500">
                        {row.customerName} · {row.lineCount} line
                        {row.lineCount === 1 ? "" : "s"}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={label} htmlFor="poNumber">
                PO number
              </label>
              <input
                id="poNumber"
                className={input}
                value={form.poNumber}
                onChange={(e) => set("poNumber", e.target.value)}
                required
                maxLength={80}
              />
            </div>

            <div>
              <label className={label} htmlFor="customerName">
                Customer
              </label>
              <input
                id="customerName"
                className={input}
                value={form.customerName}
                onChange={(e) => set("customerName", e.target.value)}
                required
                maxLength={200}
              />
            </div>

            <div>
              <label className={label} htmlFor="poDate">
                PO date
              </label>
              <input
                id="poDate"
                type="date"
                className={input}
                value={form.poDate}
                onChange={(e) => set("poDate", e.target.value)}
                required
              />
            </div>

            <div>
              <label className={label} htmlFor="promiseDate">
                Promise date
              </label>
              <input
                id="promiseDate"
                type="date"
                className={input}
                value={form.promiseDate}
                onChange={(e) => set("promiseDate", e.target.value)}
              />
            </div>

            <div>
              <label className={label} htmlFor="stockStatus">
                Stock status
              </label>
              <input
                id="stockStatus"
                className={input}
                placeholder="In stock / partial / awaiting import"
                value={form.stockStatus}
                onChange={(e) => set("stockStatus", e.target.value)}
                maxLength={80}
              />
            </div>
          </div>

          {/* §27 — the exception, revealed only when it applies. */}
          {!form.promiseDate && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <label className={label} htmlFor="promiseDateOverrideReason">
                No promise date — why?
              </label>
              <input
                id="promiseDateOverrideReason"
                className={input}
                placeholder="Recorded against the order and shown on the tracker"
                value={form.promiseDateOverrideReason}
                onChange={(e) => set("promiseDateOverrideReason", e.target.value)}
                maxLength={300}
              />
            </div>
          )}

          {duplicate && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              <p className="font-medium">
                {duplicate.poNumber} is already open for {duplicate.customerName}.
              </p>
              <p className="mt-0.5 text-xs">
                Entered {formatDate(duplicate.poDate)}, currently at stage {duplicate.currentStage}.
                Two live orders cannot share a PO number — if this one supersedes it, cancel the
                existing order first.
              </p>
              <button
                type="button"
                className="mt-1 text-xs font-medium underline"
                onClick={() => navigate(o2dRoute("orders"))}
              >
                Open the order tracker
              </button>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Items</h3>
            <Button type="button" size="xs" variant="secondary" onClick={addLine}>
              Add line
            </Button>
          </div>

          <p className="mb-2 text-xs text-slate-500">
            Lines are kept in the order you enter them — the sequence on the customer&apos;s PO.
          </p>

          <div className="space-y-2">
            {items.map((row, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[2rem_1fr_1fr_8rem_2.5rem]">
                <span className="self-center text-xs text-slate-400">{index + 1}</span>
                <input
                  className={input}
                  placeholder="SKU code"
                  aria-label={`SKU code, line ${index + 1}`}
                  value={row.skuCode}
                  onChange={(e) => setLine(index, "skuCode", e.target.value)}
                />
                <input
                  className={input}
                  placeholder="Product name (optional)"
                  aria-label={`Product name, line ${index + 1}`}
                  value={row.productName}
                  onChange={(e) => setLine(index, "productName", e.target.value)}
                />
                <input
                  className={input}
                  type="number"
                  min="1"
                  placeholder="Qty"
                  aria-label={`Quantity, line ${index + 1}`}
                  value={row.orderedQty}
                  onChange={(e) => setLine(index, "orderedQty", e.target.value)}
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLine(index)}
                    aria-label={`Remove line ${index + 1}`}
                    className="self-center text-slate-400 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <label className={label} htmlFor="remarks">
            Remarks
          </label>
          <textarea
            id="remarks"
            className={input}
            rows={2}
            value={form.remarks}
            onChange={(e) => set("remarks", e.target.value)}
            maxLength={2000}
          />
        </section>

        {fieldError && (
          <p role="alert" className="text-sm text-red-700">
            {fieldError}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Create order"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate(o2dRoute("orders"))}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default NewOrderPage;
