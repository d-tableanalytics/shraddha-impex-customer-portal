import mongoose from 'mongoose';

/**
 * Oversold exception (IMS Module M7).
 *
 * Raised when a posted count leaves AVAILABLE negative — physical stock is now
 * below what is already reserved against confirmed bookings. Stock has been
 * promised that does not exist.
 *
 * This is not hypothetical: the audit found the previous CLI count script
 * explicitly detected SKUs counted below their booked quantity and silently
 * floored the result at zero, hiding the problem entirely.
 *
 * The count is NOT blocked. Refusing to record a true count would be worse —
 * the stock genuinely is not there. Instead the shortfall is surfaced with the
 * affected bookings listed in confirmation order, so the sales desk can decide
 * which to reduce or cancel. Only a person can make that call.
 */
const oversoldExceptionSchema = new mongoose.Schema(
  {
    skuCode: { type: String, required: true },
    brand: { type: String, required: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
    locationCode: { type: String, default: null },

    // The position that raised it, captured at detection time.
    onHand: { type: Number, required: true },
    reserved: { type: Number, required: true },
    // Negative available, expressed positively — how many units are promised
    // but absent.
    shortfall: { type: Number, required: true },

    // What caused it.
    source: { type: String, enum: ['count', 'adjustment', 'issue'], default: 'count' },
    countId: { type: String, default: null },
    transactionId: { type: String, default: null },

    // Bookings holding the reserved units, oldest confirmation first — the
    // order a sales desk would work through them.
    affectedBookings: {
      type: [{
        orderId: String,
        company: String,
        skuCode: String,
        confirmedQty: Number,
        confirmedAt: Date,
        _id: false,
      }],
      default: [],
    },

    status: { type: String, enum: ['Open', 'Resolved'], default: 'Open' },
    resolution: {
      type: String,
      enum: ['bookings-reduced', 'bookings-cancelled', 'stock-found', 'recounted', 'other', null],
      default: null,
    },
    resolutionNote: { type: String, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },

    raisedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
);

// The open worklist.
oversoldExceptionSchema.index({ status: 1, raisedAt: -1 });
oversoldExceptionSchema.index({ skuCode: 1, brand: 1, status: 1 });
oversoldExceptionSchema.index({ countId: 1 });

export default mongoose.model('OversoldException', oversoldExceptionSchema);
