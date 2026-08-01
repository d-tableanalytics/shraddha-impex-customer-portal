import mongoose from 'mongoose';

/**
 * Unified product master (IMS Module M1).
 *
 * Previously this file created THREE separate collections — products_koken,
 * products_bix, products_imada — from one shared schema, with the brand implied
 * by which collection a document lived in. That cost a sequential scan of up to
 * three collections for every SKU lookup, forced the brand to be recovered by
 * matching substrings against the model name, and made paging across brands an
 * in-memory merge.
 *
 * All three now live in ONE `products` collection, discriminated on `brand`.
 * Mongoose discriminators are used deliberately rather than a plain `brand`
 * field, because a discriminator model automatically scopes every query to its
 * own brand:
 *
 *     ProductKoken.find({})        → { brand: 'Koken' }
 *     ProductKoken.findById(id)    → null for a BIX product
 *     ProductKoken.create({...})   → brand set automatically
 *
 * That is exactly the behaviour the separate collections used to provide, so
 * every existing caller — the reservations, orders and sales controllers, the
 * stock ledger, brandAccess and the migration scripts — keeps working unchanged
 * while the storage underneath is unified. `constructor.modelName` still reads
 * 'Product_koken' / 'Product_bix' / 'Product_imada', so the brand-sniffing
 * helpers in those controllers also keep working.
 *
 * Query across all brands at once with the base `Product` model.
 */

const productSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    // Uniqueness is per-brand, not global (see the compound index below). The
    // three source collections have zero SKU overlap today, so this is strictly
    // more permissive than the previous global-unique constraint.
    skuCode: { type: String, required: true },
    msilCode: { type: String, default: null },
    category: { type: [String], default: [] },
    // Products have never had a display name — every screen shows the SKU twice
    // because of it. Optional, and callers fall back to skuCode.
    description: { type: String, default: null },
    // Unit of measure. The frontend hard-coded 'PCS' in three places; this makes
    // it data. Kept simple until the costing/UoM question is settled.
    uom: { type: String, default: 'PCS' },
    itemParameter: { type: String, default: null },

    // ── Planning inputs ─────────────────────────────────────────────────────
    // These are the INPUTS to the stock-health calculation, maintained by hand
    // (or imported). The outputs they produce — Max Level, Reorder Level,
    // Available % and the health band — are deliberately NOT stored here; they
    // are derived in Module M4. Storing a derived value beside its inputs is
    // what left `availableInPercent` stale in the first place.
    dailyAvgConsumption: {
      low: { type: Number, default: 0 },
      normal: { type: Number, default: 0 },
      peak: { type: Number, default: 0 },
    },
    currentSeason: { type: String, enum: ['Low', 'Normal', 'Peak', null], default: null },
    leadTime: { type: Number, default: 0 },
    safetyFactor: { type: Number, default: 0 },
    moq: { type: Number, default: 0 },
    // Value/volume classification used later to risk-weight count frequency and
    // threshold tightness. Populated by M6; left null until then.
    abcClass: { type: String, enum: ['A', 'B', 'C', null], default: null },

    // ── Supply ──────────────────────────────────────────────────────────────
    boxNo: { type: String, default: null },
    vendorName: { type: String, default: null },
    status: {
      type: String,
      enum: ['Active', 'Inactive', 'Discontinued'],
      default: 'Active',
    },

    // ── Balances (DEPRECATED — moving to M3) ────────────────────────────────
    // These stay for now because the booking lifecycle, the stock ledger and the
    // dashboard all read and write them today. Module M3 moves them into a
    // dedicated per-location `stockbalances` projection backed by the movement
    // ledger, after which these become a dual-write mirror and are finally
    // dropped. Do NOT build anything new against them.
    totalAvailableQuantity: { type: Number, default: 0 },
    bookedQuantity: { type: Number, default: 0 },
    availableForSale: { type: Number, default: 0 },
    inTransitQty: { type: Number, default: 0 },
    openingStockQuantity: { type: Number, default: null },
    openingStockDate: { type: Date, default: null },

    // ── Derived values (DEPRECATED — moving to M4) ──────────────────────────
    // Written only by the offline import scripts and read by nothing at runtime.
    // Retained so those scripts keep working until M4 replaces them; every new
    // reader must use the M4 health service instead.
    maxLevel: { type: Number, default: 0 },
    availableInPercent: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    // Mongoose adds `brand` to the schema itself and stamps it on write. Do not
    // declare it above, or it will be overwritten on every save.
    discriminatorKey: 'brand',
  },
);

// The business key. Replaces the old global-unique index on skuCode alone.
// Also serves the default list (filter by brand, sort by skuCode).
productSchema.index({ brand: 1, skuCode: 1 }, { unique: true });
// Search and the bulk-import prefetch both hit msilCode; sparse because most
// products in BIX and IMADA have none.
productSchema.index({ msilCode: 1 }, { sparse: true });
productSchema.index({ category: 1 });
productSchema.index({ status: 1 });

// The inventory list offers sorting by stock and by recency, both filtered by
// brand. Without these the brand prefix is indexed but the sort is not, so
// Mongo loads the matching set and sorts it in memory — around 7,700 documents
// for Koken alone. Sort direction is irrelevant to index usability; Mongo walks
// a compound index in either direction.
//
// These live on the product for now because balances still do. Module M3 moves
// on-hand/reserved into `stockbalances`, at which point the stock sort moves
// with them and this index is dropped.
productSchema.index({ brand: 1, availableForSale: -1 });
productSchema.index({ brand: 1, updatedAt: -1 });

/**
 * Base model — queries every brand at once. Use this for cross-brand reads
 * (the inventory list, category lookups) instead of iterating three models.
 */
export const Product = mongoose.models.Product
  ? mongoose.models.Product
  : mongoose.model('Product', productSchema, 'products');

// Canonical brand names. The discriminator VALUE is what lands in the document,
// so these strings are the stored representation and must not drift.
export const BRAND_VALUES = {
  koken: 'Koken',
  bix: 'BIX',
  imada: 'IMADA',
};

/**
 * Brand-scoped model. Kept with the same name and signature as before so
 * existing imports continue to resolve.
 */
export const createProductModel = (brand) => {
  const key = String(brand).trim().toLowerCase();
  const modelName = `Product_${key}`;

  // Re-registering a discriminator throws, and this module is imported from many
  // entry points (server, scripts, tests).
  if (mongoose.models[modelName]) return mongoose.models[modelName];

  return Product.discriminator(
    modelName,
    new mongoose.Schema({}),
    BRAND_VALUES[key] ?? brand,
  );
};

export const ProductKoken = createProductModel('koken');
export const ProductBIX = createProductModel('bix');
export const ProductIMADA = createProductModel('imada');

export default productSchema;
