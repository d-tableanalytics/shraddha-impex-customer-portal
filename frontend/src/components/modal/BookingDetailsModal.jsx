import { useState } from "react";
import toast from "react-hot-toast";
import { Loader2, AlertTriangle } from "lucide-react";

import { Modal } from "../ui/Modal";
import { ERPButton } from "../ui/ERPButton";
import { salesApi } from "../../services/sales";

/**
 * Admin correction of a booking's submitted customer/order details.
 *
 * ---------------------------------------------------------------------------
 * SENDS ONLY WHAT CHANGED
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation posts the whole form. It is wrong here for two
 * reasons that both bite in production:
 *
 *   1. The audit trail would record every field as "edited" on every save, so
 *      the one field that actually changed is buried among eleven that did not
 *      — and the trail exists precisely so somebody can answer "who changed the
 *      shop number?".
 *   2. A field the server left null renders as '' in the form and would be
 *      posted back as '', which the endpoint reads as an explicit clear. Saving
 *      a booking after correcting one field would blank every empty one.
 *
 * So the diff is computed against what was loaded, and an unchanged field is
 * simply not sent.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION IS THE SERVER'S, SHOWN HERE
 * ---------------------------------------------------------------------------
 *
 * No format checking is duplicated in the browser. The endpoint validates GSTIN,
 * PO uniqueness, lengths and dates, and returns `field` alongside the message;
 * this maps that onto the input so the error lands where the fix is. A second
 * copy of the rules here would drift from the first and start disagreeing about
 * what is valid.
 */

/** Mirrors EDITABLE_FIELDS on the server. Labels are the ones staff use. */
const FIELDS = [
  { key: "customerName", label: "Customer Name", type: "text" },
  { key: "poNumber", label: "PO Number", type: "text", hint: "Must be unique across bookings." },
  { key: "poDate", label: "PO Date", type: "date" },
  { key: "shopNumber", label: "Shop Number", type: "text" },
  { key: "vendorCode", label: "Vendor Code", type: "text" },
  { key: "gstCode", label: "GST Number", type: "text", hint: "15-character GSTIN." },
  { key: "phoneNumber", label: "Phone Number", type: "text" },
  { key: "emailId", label: "Email", type: "text" },
  { key: "location", label: "Location", type: "text" },
  { key: "paymentTerm", label: "Payment Term", type: "text" },
  { key: "promiseDate", label: "Promise Date", type: "date" },
  { key: "shippingAddress", label: "Shipping Address", type: "textarea" },
  { key: "billingAddress", label: "Billing Address", type: "textarea" },
  { key: "remarks", label: "Remarks", type: "textarea" },
];

/** `2026-09-12T00:00:00.000Z` -> `2026-09-12`, which is what <input type=date> wants. */
const toDateInput = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const initialForm = (booking) =>
  Object.fromEntries(
    FIELDS.map((f) => {
      // customerName lives on the booking as `customer`, the name the API has
      // always used for it.
      const raw = f.key === "customerName"
        ? booking?.customer ?? booking?.customerName
        : booking?.[f.key];
      return [f.key, f.type === "date" ? toDateInput(raw) : (raw ?? "")];
    }),
  );

export const BookingDetailsModal = ({ isOpen, booking, onClose, onSaved }) => {
  const [form, setForm] = useState(() => initialForm(booking));
  const [baseline, setBaseline] = useState(() => initialForm(booking));
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  // Re-seed when a different booking is opened. Keyed on orderId rather than an
  // effect on `booking`, so a socket refresh of the same booking mid-edit does
  // not throw away what the admin has typed.
  const [seededFor, setSeededFor] = useState(booking?.orderId);
  if (booking?.orderId !== seededFor) {
    setSeededFor(booking?.orderId);
    setForm(initialForm(booking));
    setBaseline(initialForm(booking));
    setFieldError(null);
  }

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (fieldError?.field === key) setFieldError(null);
  };

  /** Only the fields whose value actually moved. */
  const changed = Object.keys(form).filter((k) => form[k] !== baseline[k]);

  const handleSave = async () => {
    if (changed.length === 0) return onClose();

    const patch = Object.fromEntries(changed.map((k) => [k, form[k]]));

    setSaving(true);
    setFieldError(null);
    try {
      const updated = await salesApi.updateDetails(booking.orderId, patch);
      toast.success(
        `Updated ${changed.length} field${changed.length === 1 ? "" : "s"}. The change is recorded in the audit trail.`,
      );
      onSaved?.(updated);
      onClose();
    } catch (error) {
      const res = error?.response?.data;
      const message = res?.message || "Could not save those changes.";
      // The server names the offending field; put the message on that input
      // rather than only in a toast that disappears.
      if (res?.field) setFieldError({ field: res.field, message });
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const input =
    "w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg outline-none " +
    "focus:border-primary-500 focus:ring-1 focus:ring-primary-500 transition-all";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Edit details — ${booking?.orderId ?? ""}`} size="lg">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-xs text-amber-900 leading-relaxed">
            Quantities, SKUs, pricing and booking status are changed on their own screens, which
            also move the stock and send the customer the right notice. This form covers the
            customer and order details only.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FIELDS.map((f) => {
            const invalid = fieldError?.field === f.key;
            return (
              <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                <label
                  htmlFor={`bd-${f.key}`}
                  className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1"
                >
                  {f.label}
                  {form[f.key] !== baseline[f.key] && (
                    <span className="ml-1.5 font-semibold normal-case text-primary-600">• changed</span>
                  )}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    id={`bd-${f.key}`}
                    rows={2}
                    className={`${input} ${invalid ? "border-error-500" : ""}`}
                    value={form[f.key]}
                    onChange={set(f.key)}
                  />
                ) : (
                  <input
                    id={`bd-${f.key}`}
                    type={f.type}
                    className={`${input} ${invalid ? "border-error-500" : ""}`}
                    value={form[f.key]}
                    onChange={set(f.key)}
                  />
                )}
                {invalid ? (
                  <p className="mt-1 text-[11px] font-semibold text-error-600">{fieldError.message}</p>
                ) : f.hint ? (
                  <p className="mt-1 text-[11px] text-slate-400">{f.hint}</p>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <p className="text-xs text-slate-500">
            {changed.length === 0
              ? "No changes yet."
              : `${changed.length} field${changed.length === 1 ? "" : "s"} will be updated and recorded.`}
          </p>
          <div className="flex gap-2">
            <ERPButton variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </ERPButton>
            <ERPButton onClick={handleSave} disabled={saving || changed.length === 0}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              Save changes
            </ERPButton>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default BookingDetailsModal;
