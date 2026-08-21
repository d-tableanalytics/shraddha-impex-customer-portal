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
  promiseDate: { type: Date, default: null }
}, { timestamps: true });

// Compound indexes
orderSchema.index({ skuCode: 1, brand: 1 });
orderSchema.index({ company: 1, status: 1 });

export default mongoose.model('Order', orderSchema);
