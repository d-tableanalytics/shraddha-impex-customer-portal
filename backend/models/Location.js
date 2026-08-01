import mongoose from 'mongoose';

/**
 * Stock location master (IMS Module M1).
 *
 * Introduced now, at one location, on purpose. Whether Manesar / Kharkhoda /
 * Gurgaon / Gujarat are stock-holding sites or merely customer delivery
 * addresses is still an open business question — but adding a location
 * dimension AFTER go-live means rewriting every balance, every movement and
 * every report, whereas carrying it from the start costs almost nothing.
 *
 * Until that question is answered the system runs with the single seeded
 * DEFAULT location, and multi-location becomes data plus a transfer workflow
 * rather than a schema change.
 *
 * Balances and movements reference a location from Module M3 onward. Nothing in
 * M1 posts stock, so this is master data only for now.
 */
const locationSchema = new mongoose.Schema(
  {
    // Short stable identifier used on movements and in imports, e.g. 'DEFAULT',
    // 'MANESAR'. Upper-cased on write so lookups are predictable.
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['Warehouse', 'Shop', 'Transit', 'Virtual'],
      default: 'Warehouse',
    },
    address: { type: String, default: null },
    // The location used when a caller does not specify one. Exactly one location
    // carries this flag; setDefault() in the controller enforces that.
    isDefault: { type: Boolean, default: false },
    // Deactivating a location that still holds stock is blocked (BR-73). The
    // check lives in the controller because the balances it must consult do not
    // exist until M3 — see the note there.
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

locationSchema.index({ active: 1 });

export default mongoose.model('Location', locationSchema);
