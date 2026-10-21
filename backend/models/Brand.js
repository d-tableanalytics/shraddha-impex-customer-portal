import mongoose from 'mongoose';

/**
 * The brands the business sells — the ONE list every brand dropdown, brand
 * filter and brand-access rule in both portals is built from.
 *
 * SHARED CONTRACT. Both portals read this collection (it is how a user's
 * `brandAccess` flags are interpreted), so this file is byte-identical in both
 * repositories and listed in shared-contract.manifest.json.
 *
 * `name` is the stored representation: it is what lands in Product.brand,
 * Order.brand, StockBalance.brand and every other brand-carrying document. It
 * is therefore never renamed — a brand created by mistake is deleted while
 * nothing refers to it yet, and created again correctly.
 *
 * `key` is `name` lower-cased with everything but letters and digits removed.
 * It is the field name under User.brandAccess, and the suffix of the product
 * discriminator (Product_<key>). Unique, so "Ko-ken" cannot be created beside
 * "Koken" as a second, near-identical brand.
 */
const brandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, lowercase: true, trim: true },
    /**
     * MSIL customers never see this brand, whatever their brandAccess says.
     * The rule that used to be written as "MSIL customers never carry IMADA";
     * IMADA is seeded with it set, and a new brand can opt in.
     */
    hiddenFromMsil: { type: Boolean, default: false },
    // One of the brands the system shipped with. Cannot be deleted.
    system: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

brandSchema.index({ key: 1 }, { unique: true });
brandSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const Brand = mongoose.models.Brand || mongoose.model('Brand', brandSchema);

export default Brand;
