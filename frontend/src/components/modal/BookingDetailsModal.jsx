import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { Loader2, AlertTriangle, ArrowRightLeft } from "lucide-react";

import { Modal } from "../ui/Modal";
import { ERPButton } from "../ui/ERPButton";
import { CustomerSelect, customerDisplayName } from "../booking/CustomerSelect";
import { salesApi } from "../../services/sales";
import { customersApi } from "../../services/users";
import { bookingOwnerOf, bookingDetailsFromCustomer, siTeamLabelOf } from "../../utils/bookingParty";

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
 *
 * ---------------------------------------------------------------------------
 * SELECT CUSTOMER
 * ---------------------------------------------------------------------------
 *
 * The same picker as Create Booking (components/booking/CustomerSelect),
 * showing the customer the booking belongs to. Choosing a DIFFERENT customer
 * fills the customer fields below from that customer's record
 * (bookingDetailsFromCustomer, the mapping the server uses too) and, on save,
 * moves the booking to their account: it then shows in their Booking History
 * and on the desk under their name. Nothing about the customer is sent unless a
 * different one is chosen, so an ordinary correction never touches ownership.
 * The server applies Create Booking's rules to the choice (live customer,
 * brand access, MSIL category) and says which one failed.
 *
 * The SI Team is shown, read-only, from the booking's own creator stamp. No
 * edit changes it, whoever makes the edit.
 */

/** Mirrors EDITABLE_FIELDS on the server. Labels are the ones staff use. */
const FIELDS = [
  // The company stamped on the booking (the server's `company` column). The
  // customer themselves is chosen with Select Customer above the fields.
  { key: "customerName", label: "Company Name", type: "text" },
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

/** The form fields that follow the customer when a different one is chosen. */
const CUSTOMER_KEYS = Object.keys(bookingDetailsFromCustomer({}));

export const BookingDetailsModal = ({ isOpen, booking, onClose, onSaved, initialCustomerId = null }) => {
  const location = useLocation();
  const [form, setForm] = useState(() => initialForm(booking));
  const [baseline, setBaseline] = useState(() => initialForm(booking));
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const owner = bookingOwnerOf(booking);
  const [picked, setPicked] = useState(owner);

  // Re-seed when a different booking is opened. Keyed on orderId rather than an
  // effect on `booking`, so a socket refresh of the same booking mid-edit does
  // not throw away what the admin has typed.
  const [seededFor, setSeededFor] = useState(booking?.orderId);
  if (booking?.orderId !== seededFor) {
    setSeededFor(booking?.orderId);
    setForm(initialForm(booking));
    setBaseline(initialForm(booking));
    setFieldError(null);
    setPicked(bookingOwnerOf(booking));
  }

  const isOwner = (c) => Boolean(c && owner && String(c._id) === owner._id);
  const customerChanged = Boolean(picked) && !isOwner(picked);

  /**
   * A different customer fills the customer fields from their record. Going
   * back to the booking's own customer, or clearing the choice, restores what
   * the booking already had, so nothing is overwritten unless a different
   * customer is actually selected.
   */
  const pickCustomer = (customer) => {
    setPicked(customer);
    if (fieldError?.field === "customerId") setFieldError(null);
    const source = customer && !isOwner(customer)
      ? bookingDetailsFromCustomer(customer)
      : Object.fromEntries(CUSTOMER_KEYS.map((k) => [k, baseline[k]]));
    setForm((f) => ({ ...f, ...source }));
  };

  // Back from "+ Add Customer" with the new account's id: select it.
  useEffect(() => {
    if (!initialCustomerId) return undefined;
    let live = true;
    customersApi.getById(initialCustomerId)
      .then((customer) => { if (live && customer) pickCustomer(customer); })
      .catch(() => toast.error("Could not load the new customer. Select them from the list."));
    return () => { live = false; };
    // Only when a new id arrives; pickCustomer is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCustomerId]);

  // "+ Add Customer" comes back to this booking with this form open.
  const addCustomerReturn = booking?.orderId
    ? `${location.pathname}?booking=${encodeURIComponent(booking.orderId)}&editDetails=1`
    : null;

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (fieldError?.field === key) setFieldError(null);
  };

  /** Only the fields whose value actually moved. */
  const changed = Object.keys(form).filter((k) => form[k] !== baseline[k]);
  const changeCount = changed.length + (customerChanged ? 1 : 0);

  const handleSave = async () => {
    if (changeCount === 0) return onClose();

    const patch = {
      ...Object.fromEntries(changed.map((k) => [k, form[k]])),
      ...(customerChanged ? { customerId: picked._id } : {}),
    };

    setSaving(true);
    setFieldError(null);
    try {
      const updated = await salesApi.updateDetails(booking.orderId, patch);
      toast.success(
        customerChanged
          ? `Booking moved to ${customerDisplayName(picked)}. The change is recorded in the audit trail.`
          : `Updated ${changed.length} field${changed.length === 1 ? "" : "s"}. The change is recorded in the audit trail.`,
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50/40 p-3">
          <div className="sm:col-span-2" data-testid="booking-details-customer">
            <CustomerSelect
              value={picked}
              onChange={pickCustomer}
              disabled={saving}
              returnTo={addCustomerReturn}
              hint={owner
                ? `Leave empty to keep ${customerDisplayName(owner)}.`
                : "Select the customer this booking belongs to."}
            />
            {customerChanged && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-amber-700">
                <ArrowRightLeft size={13} className="mt-px shrink-0" aria-hidden="true" />
                <span>
                  On save, this booking, its open indent and its status history move to{" "}
                  {customerDisplayName(picked)}&apos;s account. Their details are filled in below;
                  check them before saving.
                </span>
              </p>
            )}
            {fieldError?.field === "customerId" && (
              <p className="mt-1 text-[11px] font-semibold text-error-600">{fieldError.message}</p>
            )}
          </div>
          <div className="sm:col-span-2">
            <label
              htmlFor="bd-siTeam"
              className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1"
            >
              SI Team
            </label>
            <input
              id="bd-siTeam"
              type="text"
              readOnly
              tabIndex={-1}
              className={`${input} bg-slate-100 text-slate-600 cursor-not-allowed`}
              value={siTeamLabelOf(booking) || "—"}
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Who placed this booking on the customer&apos;s behalf. Editing never changes it.
            </p>
          </div>
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
            {changeCount === 0
              ? "No changes yet."
              : `${changeCount} change${changeCount === 1 ? "" : "s"} will be saved and recorded.`}
          </p>
          <div className="flex gap-2">
            <ERPButton variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </ERPButton>
            <ERPButton onClick={handleSave} disabled={saving || changeCount === 0}>
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
