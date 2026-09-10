import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema({
  brand: {
    type: String,
    enum: ['Koken', 'BIX', 'IMADA'],
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    // Admin-managed lifecycle: PO Received → Ready for Dispatch → Dispatched → Delivered.
    // 'Booked'/'Cancelled' are retained only so pre-existing records still load.
    enum: ['PO Received', 'Ready for Dispatch', 'Dispatched', 'Delivered', 'Booked', 'Cancelled'],
    default: 'PO Received'
  },

  // Sheet columns
  orderTimestamp: { type: Date, default: null }, // Maps to 'Timestamp'
  company: { type: String, default: null }, // Maps to 'Company'
  role: { type: String, default: null }, // Maps to 'Role'
  orderId: { type: String, required: true }, // Maps to 'Order ID'
  date: { type: Date, default: null }, // Maps to 'Date'
  skuCode: { type: String, required: true }, // Maps to 'SKU Code'
  category: { type: String, default: null }, // Maps to 'Category'
  requestedQty: { type: Number, default: 0 }, // Maps to 'Requested Qty' (kept = confirmedQty for back-compat)
  bookedQty: { type: Number, default: 0 },     // Original quantity the customer booked
  confirmedQty: { type: Number, default: 0 },  // Quantity actually fulfilled from stock
  pendingQty: { type: Number, default: 0 },    // Unfulfilled remainder moved to backorder
  poNumber: { type: String, default: null }, // Maps to 'PO Number'
  // PO audit. A booking is locked once poGeneratedAt is set (see utils/bookingLock.js).
  // Rows predating this field fall back to "poNumber is a real value", which is
  // the convention the rest of the app already uses ('-' means not yet raised).
  poGeneratedAt: { type: Date, default: null },
  poGeneratedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Where this line's stock currently sits. Confirming a booking moves units
  // available → booked ('reserved'). From there exactly one thing happens:
  //   'consumed' — the PO was raised, so the units leave inventory for good
  //   'released' — no PO within the deadline, so the units go back on sale
  // Guarding on this makes settlement idempotent: a re-run can never double
  // release or double deduct. Missing (legacy rows) is treated as 'reserved'.
  stockState: {
    type: String,
    enum: ['reserved', 'consumed', 'released'],
    default: 'reserved',
  },
  stockSettledAt: { type: Date, default: null },
  autoCancelledAt: { type: Date, default: null },
  remarks: { type: String, default: null }, // Maps to 'Remarks'
  expiryNotified: { type: Boolean, default: false }, // Maps to 'Expiry Notified'
  uniqueId: { type: String, default: null }, // Maps to 'Unique ID'
  statusTimestamp: { type: Date, default: null }, // Maps to 'Status_Timestamp'
  msilCode: { type: String, default: null }, // Maps to 'MSIL CODE'
  poDate: { type: Date, default: null }, // Maps to 'PO Date'
  supplyByDate: { type: Date, default: null }, // Maps to 'SupplyByDate'
  boxNo: { type: String, default: null }, // Maps to 'boxNo'
  location: { type: String, default: null }, // Maps to 'Location'
  vendorCode: { type: String, default: null }, // Maps to 'Vendor code'
  emailId: { type: String, default: null }, // Maps to 'Email id'
  phoneNumber: { type: String, default: null }, // Maps to 'Phone Number'
  shippingAddress: { type: String, default: null },
  billingAddress: { type: String, default: null },
  shopNumber: { type: String, default: null },
  gstCode: { type: String, default: null },
  paymentTerm: { type: String, default: null },
  promiseDate: { type: Date, default: null },

  /**
   * ── The price this customer was given ─────────────────────────────────────
   *
   * `priceType` is WHICH of the four tiers the sales desk offered (see
   * config/pricing.js); `unitPrice` is the INR-per-piece figure that tier held
   * at the moment the PO was raised.
   *
   * BOTH, not just the type, and this is the whole point of the pair. The
   * pricelist is reloaded from a workbook whenever the supplier issues one, so
   * looking a price up by type later would answer "what does the Trader tier
   * cost today", when the question a raised PO asks is "what was this customer
   * quoted". The number is copied here so the answer cannot drift, and the type
   * rides along so the desk can still see which schedule it came from.
   *
   * Stamped on EVERY row of the booking, because a row is read on its own
   * throughout this codebase and a line with no price is indistinguishable from
   * a line that was free.
   *
   * null unitPrice is "no price on file for this SKU under that tier" — the
   * picklist prints a dash. It is never 0.
   *
   * VISIBILITY: this is the only pricing a customer may ever see, and only for
   * their own booking, and only once the PO exists. The four tier prices stay on
   * the product master behind view_pricing.
   */
  priceType: { type: String, default: null },
  unitPrice: { type: Number, default: null, min: 0 },
  pricedAt: { type: Date, default: null },
  pricedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  /**
   * ── Where this SKU sat in the customer's original request ────────────────
   *
   * THE PROBLEM THIS SOLVES. This collection is ONE DOCUMENT PER SKU LINE, and
   * nothing recorded a line's position within its booking. The picklist
   * therefore printed whatever order the database happened to return, which is
   * not insertion order once any row has been updated — and the reads did not
   * even agree with each other:
   *
   *   order.controller.js   .sort({ createdAt: -1 })   (customer history — reversed)
   *   sales.controller.js   .sort({ createdAt: -1 })   (sales list)
   *   sales.controller.js   .sort({ createdAt: 1 })    (sales detail — opposite)
   *   four more reads       no .sort() at all
   *
   * so opening a booking from the list and then saving it visibly reordered the
   * lines. `createdAt` could not have fixed it anyway: `insertMany` stamps every
   * row of one booking with the SAME millisecond, so it cannot separate them.
   *
   * WHAT IS STORED. The zero-based index of the line in the request the customer
   * actually submitted — the row order of their uploaded sheet, or the order
   * they added items to the cart.
   *
   * DELIBERATELY SPARSE. Both creation loops skip a line with `confirmedQty` of
   * 0 (it becomes an indent instead), so a five-line sheet whose third line was
   * unavailable yields 0, 1, 3, 4. The gap is intentional: it preserves the
   * position the customer asked for rather than renumbering around a decision
   * made after the fact. Gaps are invisible on paper because the picklist
   * renumbers its own `sr` column densely.
   *
   * NULL ON EVERY EXISTING ROW, and that is handled rather than migrated. The
   * sort is always `{ lineSeq: 1, _id: 1 }`: for historical bookings every
   * lineSeq is null so they tie and fall through to `_id`, which for an ObjectId
   * is generation-ordered and is therefore the closest thing to true insertion
   * order that survives in the data. A backfill would have been WORSE than
   * nothing — it would freeze today's arbitrary ordering into a permanent field
   * and make it look authoritative.
   */
  lineSeq: { type: Number, default: null },

  /**
   * ── Scheduled availability, per SKU line ─────────────────────────────────
   *
   * The date an admin has told the customer this line will be available. The
   * mirror of the identically-named fields on `Reservation` — an indent already
   * had this, a booking did not, and the customer needs one delivery schedule
   * covering both.
   *
   * WHY A NEW FIELD RATHER THAN REUSING promiseDate / supplyByDate.
   *
   * Those already mean something else and are already in use. `raisePo` writes
   * BOTH to the same value when the purchase order is raised, every reader takes
   * `first.promiseDate || first.supplyByDate` as a BOOKING-level fact, and the
   * picklist prints it as "Supply By". Overloading them would:
   *   - change what the picklist's "Supply By" says, which is a live document;
   *   - make a per-line edit look like a change to the PO's promise; and
   *   - be impossible to express, since this requirement needs DIFFERENT dates
   *     for different SKUs inside one booking, while promiseDate is read from
   *     the first row as though it applied to all of them.
   * A parallel field keeps both meanings intact and, because it is named
   * identically to Reservation's, lets one email builder read indent lines and
   * booking lines without knowing which is which.
   *
   * DELIBERATELY NOT A GATE. On the indent side `scheduledDate` also withholds
   * the line from the Selection List until the date arrives. Nothing here does
   * that: a booking is already confirmed and its stock already committed, so
   * gating it would change fulfilment behaviour that nobody asked to change.
   * Here the date is a promise the customer is told about, and nothing more.
   *
   * Null on every existing row, which is exactly right — an item with no date
   * has no schedule and is left out of the email entirely.
   */
  scheduledDate: { type: Date, default: null },
  scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  scheduledAt: { type: Date, default: null },
  scheduleNote: { type: String, default: null },
}, { timestamps: true });

// Compound indexes
orderSchema.index({ skuCode: 1, brand: 1 });
orderSchema.index({ company: 1, status: 1 });
/**
 * Every picklist read is "one booking's lines, in the customer's order", so the
 * index carries the sort key as well as the lookup key. Without the trailing
 * `lineSeq` the sort is done in memory, and Mongo refuses an in-memory sort past
 * 32MB — which a large enough booking history export would eventually hit.
 */
orderSchema.index({ orderId: 1, lineSeq: 1 });

/**
 * The canonical order of the lines WITHIN a booking.
 *
 * Exported as one constant, and imported by every read, because the bug this
 * fixes was the reads disagreeing: the customer history sorted `createdAt: -1`,
 * the sales list `createdAt: -1`, the sales DETAIL `createdAt: 1`, and four more
 * reads had no sort at all — so the same booking came back in a different order
 * depending on which screen asked, and opening a booking then saving it visibly
 * reordered the picklist. A shared constant is what stops that drifting apart
 * again.
 *
 * `_id` is the tie-break, and it is doing real work: every historical row has
 * `lineSeq: null`, so they all tie, and an ObjectId sorts by generation time —
 * the closest thing to true insertion order still present in old data.
 */
export const LINE_ORDER = Object.freeze({ lineSeq: 1, _id: 1 });

export default mongoose.model('Order', orderSchema);
