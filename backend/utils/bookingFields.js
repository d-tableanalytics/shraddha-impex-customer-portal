/**
 * WHICH booking fields an Admin may edit after submission, and which are sealed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST AND NOT A `$set: req.body`
 * ---------------------------------------------------------------------------
 *
 * The requirement is "Admin should have full editing access to the business
 * details". The dangerous reading of that is to pass the request body into
 * `$set` and let Mongoose sort it out. That hands the network the ability to
 * rewrite `confirmedQty` without touching stock, flip `status` past its
 * lifecycle, repoint `user` at another customer, or forge `poGeneratedBy` —
 * none of which anybody asked for, and every one of which would look like a
 * legitimate admin edit in the audit trail.
 *
 * So the allow-list is explicit and closed. A field absent from EDITABLE_FIELDS
 * cannot be written through this route no matter what the body contains, and
 * adding one is a deliberate act with a reviewer.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR CLASSES (the requirement's own taxonomy)
 * ---------------------------------------------------------------------------
 *
 *   1. CUSTOMER MASTER    Identity and contact — name, phone, GST, shop.
 *                         Editable. These are the fields the client is
 *                         actually asking to correct.
 *
 *   2. ORDER / BOOKING    Commercial terms of THIS booking — PO number and
 *                         date, vendor code, addresses, payment term.
 *                         Editable.
 *
 *   3. PRODUCT / LINE     SKU, MSIL code, quantities, box number, price.
 *                         NOT editable here. Every one of them already has a
 *                         route that does the surrounding work: changing a
 *                         quantity moves stock, changing a SKU re-reserves,
 *                         changing a price needs VIEW_PRICING. A silent `$set`
 *                         would skip all of it and desynchronise the ledger.
 *
 *   4. WORKFLOW / SYSTEM  Status, stock state, ids, timestamps, PO provenance.
 *                         NOT editable. These are the record OF the work, and
 *                         a system whose audit fields are editable has no audit.
 */

/**
 * Class 1 + 2: what an Admin may correct after Sales has submitted.
 *
 * `type` drives coercion and validation in one place, so the route does not
 * re-derive "is this a date" from the field name.
 */
export const EDITABLE_FIELDS = Object.freeze({
  // ── Class 1: customer master, as denormalised onto the booking ───────────
  //
  // NOTE: the customer-facing name lives on the booking as `company`, not
  // `customerName`. raisePo already maps it that way (`setFields.company =
  // customerName`), and the API surface has always called it customerName.
  // Keeping the alias here means the admin screen speaks the same language as
  // the PO dialog instead of exposing a column name nobody outside the schema
  // recognises.
  customerName: { column: 'company', type: 'string', max: 200, label: 'Customer Name' },
  phoneNumber: { column: 'phoneNumber', type: 'string', max: 40, label: 'Phone Number' },
  emailId: { column: 'emailId', type: 'email', max: 200, label: 'Email' },
  location: { column: 'location', type: 'string', max: 200, label: 'Location' },
  shopNumber: { column: 'shopNumber', type: 'string', max: 60, label: 'Shop Number' },
  gstCode: { column: 'gstCode', type: 'gst', max: 20, label: 'GST Number' },

  // ── Class 2: this booking's commercial terms ─────────────────────────────
  poNumber: { column: 'poNumber', type: 'poNumber', max: 80, label: 'PO Number' },
  poDate: { column: 'poDate', type: 'date', label: 'PO Date' },
  vendorCode: { column: 'vendorCode', type: 'string', max: 60, label: 'Vendor Code' },
  shippingAddress: { column: 'shippingAddress', type: 'string', max: 500, label: 'Shipping Address' },
  billingAddress: { column: 'billingAddress', type: 'string', max: 500, label: 'Billing Address' },
  paymentTerm: { column: 'paymentTerm', type: 'string', max: 120, label: 'Payment Term' },
  remarks: { column: 'remarks', type: 'string', max: 1000, label: 'Remarks' },

  /**
   * Writes BOTH promiseDate and supplyByDate, because raisePo does and every
   * reader takes `first.promiseDate || first.supplyByDate` as one
   * booking-level fact. Editing only one of them would leave the picklist's
   * "Supply By" disagreeing with the PO's promise.
   */
  promiseDate: { column: 'promiseDate', type: 'date', label: 'Promise Date', alsoWrites: ['supplyByDate'] },
});

export const EDITABLE_KEYS = Object.freeze(Object.keys(EDITABLE_FIELDS));

/**
 * Class 3 + 4, written down rather than merely implied.
 *
 * Nothing reads this list at runtime — the allow-list above is what enforces.
 * It exists so the NEXT person to widen admin editing can see which omissions
 * were decisions and which were oversights, and why each one is dangerous.
 */
export const PROTECTED_FIELDS = Object.freeze({
  // Class 3 — product / line item. Each has a route that does the real work.
  skuCode: 'Identifies the product. Changing it must re-reserve stock — use the items endpoint.',
  msilCode: 'Derived from the product master, not a booking-level fact.',
  boxNo: 'Snapshot of the product master, re-stamped when the PO is raised.',
  requestedQty: 'Quantity changes move stock. Use the items endpoint.',
  bookedQty: 'The original customer ask — the baseline every quantity diff is measured against.',
  confirmedQty: 'Backed by a reservation. Editing it here would desynchronise the stock ledger.',
  pendingQty: 'Derived from the confirmed/booked split by the indent logic.',
  unitPrice: 'Pricing is a separate duty behind VIEW_PRICING.',
  priceType: 'Pricing is a separate duty behind VIEW_PRICING.',
  lineSeq: 'Line order has its own endpoint, so that a reorder is audited as a reorder.',
  scheduledDate: 'Has its own endpoint, which notifies the customer.',

  // Class 4 — workflow / system.
  _id: 'Database identity.',
  orderId: 'The booking number. Everything joins on it; it is the one identifier printed on paper.',
  uniqueId: 'System-generated identifier.',
  user: 'Ownership. Repointing a booking at another customer is not an edit, it is a transfer.',
  brand: 'Determines stock pool and access; changing it would move the booking between ledgers.',
  status: 'Has a lifecycle with side effects (stock settlement, notifications).',
  stockState: 'Inventory transaction state, owned by the reservation engine.',
  stockSettledAt: 'Inventory transaction record.',
  autoCancelledAt: 'Written by the expiry job.',
  poGeneratedAt: 'Provenance of the PO. Forging it would falsify the lock.',
  poGeneratedBy: 'Provenance of the PO. Forging it would falsify who is accountable.',
  createdAt: 'Audit field.',
  updatedAt: 'Audit field, maintained by Mongoose.',
});

export default { EDITABLE_FIELDS, EDITABLE_KEYS, PROTECTED_FIELDS };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * GSTIN: 2-digit state, 10-character PAN, entity digit, 'Z', checksum.
 *
 * Applied ONLY to a value the admin is actually changing. Validating the whole
 * record on every save would make a booking whose GST was captured before this
 * check existed impossible to edit at all — the admin would be blocked from
 * fixing a phone number by a GST they never touched, which is exactly the
 * "cannot modify after submission" complaint this work exists to remove.
 */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Deliberately permissive — the portal has never constrained the local part. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class FieldValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'FieldValidationError';
    this.status = 400;
    this.field = field;
  }
}

/**
 * Coerce and validate one submitted value against its field definition.
 *
 * Returns the value to store. An empty string becomes `null` rather than '',
 * because every reader in this codebase tests truthiness (`first.gstCode ||
 * null`) and a stored empty string would render as a blank that no longer
 * falls back to the customer master.
 */
export function coerceField(key, raw) {
  const def = EDITABLE_FIELDS[key];
  if (!def) throw new FieldValidationError(`${key} is not an editable field.`, key);

  // Explicit clearing. `null`, `undefined` and '' all mean "no value".
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (def.type === 'poNumber') {
      // Blanking the PO number would silently UNLOCK the booking, because
      // isPlaceholderPo('') is true. That is a lifecycle change wearing the
      // costume of a typo fix, so it is refused here rather than allowed to
      // happen as a side effect.
      throw new FieldValidationError(
        'PO Number cannot be cleared. Raise a corrected PO instead.', key,
      );
    }
    return null;
  }

  if (def.type === 'date') {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new FieldValidationError(`${def.label} is not a valid date.`, key);
    }
    return d;
  }

  const value = String(raw).trim();

  if (def.max && value.length > def.max) {
    throw new FieldValidationError(
      `${def.label} cannot be longer than ${def.max} characters.`, key,
    );
  }

  if (def.type === 'gst' && !GSTIN.test(value.toUpperCase())) {
    throw new FieldValidationError(
      `${def.label} must be a valid 15-character GSTIN.`, key,
    );
  }

  if (def.type === 'email' && !EMAIL.test(value)) {
    throw new FieldValidationError(`${def.label} is not a valid email address.`, key);
  }

  if (def.type === 'gst') return value.toUpperCase();
  return value;
}
