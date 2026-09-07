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
};
