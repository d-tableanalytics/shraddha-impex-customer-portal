import mongoose from 'mongoose';

const reservationSchema = new mongoose.Schema({
  reservationId: { type: String, required: true, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  skuCode: { type: String, required: true },
  msilCode: { type: String, default: null },
  quantity: { type: Number, required: true },
  reservationDate: { type: Date, default: Date.now },
  expiryDate: { type: Date, required: true },
  status: {
    type: String,
    enum: [
      'Draft', 'Reserved', 'Confirmed', 'Pending', 'Partially Confirmed', 'Expired', 'Cancelled',
      'Processing', 'Completed'
    ],
    default: 'Reserved'
  },
  reservedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  //  Indent id (PI-YYYY-######) — shares the booking's sequence number,
  // differing only in the 2-char prefix (booking is BO-YYYY-######).
  indentNumber: { type: String, default: null },
  // PO number of the confirmation that produced this indent. Distinct
  // from the booking/indent ids; used to link a indent back to its booking.
  poNumber: { type: String, default: null },
  confirmedAt: Date,
  expiredAt: Date,
  lastReminderSent: { type: String, default: null } // e.g. 'day5', 'day7'
}, { timestamps: true });

// Add index for fast querying
reservationSchema.index({ customerId: 1 });
reservationSchema.index({ status: 1 });
reservationSchema.index({ expiryDate: 1 });

export default mongoose.model('Reservation', reservationSchema);
