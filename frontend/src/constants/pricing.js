/**
 * The price types, and how to print money.
 *
 * MIRRORS backend/config/pricing.js. The keys are the contract — they are what
 * the PO dialog posts and what the server stores on the order — so they must
 * stay identical on both sides. The server never trusts this file: it resolves
 * the rate itself from the type it is sent, so a stale copy here can only
 * produce a rejected request, never a wrong price.
 *
 * The tier LABELS are internal. They belong on the sales desk, in the PO dialog
 * and on the desk's own copy of the picklist — never on the customer's, where
 * naming a tier advertises that other tiers exist.
 */

export const PRICE_TYPES = [
  {
    key: "venusAutomation",
    // Spelled as the pricelist workbook spells it.
    label: "Venus Automation",
    description: "Venus Automation rate",
  },
  { key: "trader", label: "Trader", description: "Trade / distributor rate" },
  { key: "endUser", label: "End User", description: "End customer list rate" },
  { key: "msil", label: "MSIL", description: "Maruti Suzuki contracted rate" },
];

export const PRICE_TYPE_KEYS = PRICE_TYPES.map((t) => t.key);

export const labelForPriceType = (key) =>
  PRICE_TYPES.find((t) => t.key === key)?.label ?? null;

/**
 * A number, or null.
 *
 * Zero and below are NOT prices — they are the absence of one. Keeping that
 * distinction here is what lets every screen print an em dash for "no rate on
 * file" instead of a confident ₹0.00.
 */
export const asPrice = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/** '₹1,23,456.00' — Indian grouping. Null in, em dash out. */
export const formatRupees = (value, { dash = "—" } = {}) => {
  const n = asPrice(value);
  if (n === null) return dash;
  return n.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

/**
 * GST on a picklist / purchase order.
 *
 * ONE RATE FOR THE WHOLE DOCUMENT, applied to the subtotal rather than per
 * line. The portal holds no HSN code and no per-SKU tax rate — only the
 * customer's GSTIN, which is an identifier — so a line-level rate would be an
 * invention. A single document-level rate is not: it is the rate the business
 * bills at, stated once here so the on-screen document, the printed page and
 * the PDF cannot quote three different numbers.
 */
export const GST_RATE = 0.18;

/** How the rate is named on the paper. Derived, so it can never contradict it. */
export const GST_LABEL = `GST @ ${Math.round(GST_RATE * 1000) / 10}%`;

/**
 * A subtotal, its GST and the payable total.
 *
 * GST is rounded to paise BEFORE being added, so the printed grand total is
 * exactly subtotal + the printed GST. Computing the total from the unrounded
 * tax would leave a document whose own three numbers do not add up.
 *
 * A null subtotal — nothing on this document has a rate — yields nulls rather
 * than zeroes: no tax is due on an amount that does not exist, and every
 * formatter here prints null as an em dash.
 */
export const withGst = (subtotal) => {
  const base = asPrice(subtotal);
  if (base === null) {
    return { subtotal: null, gstRate: GST_RATE, gstAmount: null, grandTotal: null };
  }
  const gstAmount = Math.round(base * GST_RATE * 100) / 100;
  return {
    subtotal: base,
    gstRate: GST_RATE,
    gstAmount,
    grandTotal: Math.round((base + gstAmount) * 100) / 100,
  };
};

/** Rate x quantity, or null when there is no rate. */
export const lineAmount = (unitPrice, quantity) => {
  const price = asPrice(unitPrice);
  const qty = Number(quantity);
  if (price === null || !Number.isFinite(qty) || qty <= 0) return null;
  return Math.round(price * qty * 100) / 100;
};

export default {
  PRICE_TYPES,
  PRICE_TYPE_KEYS,
  labelForPriceType,
  asPrice,
  formatRupees,
  lineAmount,
  GST_RATE,
  GST_LABEL,
  withGst,
};
