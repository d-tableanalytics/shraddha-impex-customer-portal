/**
 * The pricing vocabulary: what price types exist, and how to read one.
 *
 * A leaf module on purpose — it imports nothing, so the product master, the
 * sales desk, the import script and the tests can all share one definition of
 * "the four price types" without any of them importing each other. The same
 * reason config/permissions.js sits where it does.
 *
 * WHY FOUR NUMBERS ON THE PRODUCT RATHER THAN A PRICE COLLECTION
 *
 * Every SKU has at most one price per type, that price has no history the
 * business tracks, and nothing looks a price up except by SKU. A separate
 * `prices` collection would be a second document to join, keep in step and
 * delete alongside the SKU, in exchange for nothing. What DOES need history is
 * the price a specific customer was given, and that is snapshotted onto the
 * order row when the PO is raised — see unitPrice on models/Order.js.
 *
 * `key` is the field name under Product.prices. `sheet` is the tab it comes
 * from in the Ko-ken pricelist workbook, which is what scripts/import-pricelist.js
 * reads. Both are part of the contract; renaming a key is a migration.
 */

export const PRICE_TYPES = [
  {
    key: 'venusAutomation',
    // The workbook spells it VENUS AUTOMATION. Kept verbatim rather than
    // corrected to anything that looks more likely — the pricelist is the
    // source of truth for its own tier names.
    label: 'Venus Automation',
    sheet: 'VENUS AUTOMATION',
    description: 'Venus Automation rate',
  },
  {
    key: 'trader',
    label: 'Trader',
    sheet: 'TRADER',
    description: 'Trade / distributor rate',
  },
  {
    key: 'endUser',
    label: 'End User',
    sheet: 'END USER',
    description: 'End customer list rate',
  },
  {
    key: 'msil',
    label: 'MSIL',
    sheet: 'MSIL',
    description: 'Maruti Suzuki contracted rate',
  },
];

export const PRICE_TYPE_KEYS = PRICE_TYPES.map((t) => t.key);

/** The four keys, as a Mongoose-friendly enum that still allows "not priced". */
export const PRICE_TYPE_ENUM = [...PRICE_TYPE_KEYS, null];

const BY_KEY = new Map(PRICE_TYPES.map((t) => [t.key, t]));

/** 'trader' -> 'Trader'. Unknown or absent -> null, never a raw key. */
export const labelForPriceType = (key) => BY_KEY.get(key)?.label ?? null;

/**
 * Accept what a caller might plausibly send and return a canonical key.
 *
 * Deliberately liberal about spelling — 'MSIL', 'msil', 'End User', 'end_user'
 * and 'endUser' all resolve — because this value crosses a form, an HTTP body
 * and a spreadsheet, and each of those has its own idea of capitalisation.
 * Anything it does not recognise returns null, which callers treat as "no price
 * type chosen" rather than guessing.
 */
export const normalisePriceType = (raw) => {
  if (raw === null || raw === undefined) return null;
  const flat = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!flat) return null;
  for (const type of PRICE_TYPES) {
    if (flat === type.key.toLowerCase()) return type.key;
    if (flat === type.label.toLowerCase().replace(/[\s_-]+/g, '')) return type.key;
  }
  return null;
};

/**
 * Money, to the paisa.
 *
 * Prices arrive from a spreadsheet where a cell may be 83765, 130.5 or a string
 * with a stray space. Anything that is not a positive finite number is NOT a
 * price — it is a blank, and a blank is null so the picklist can say "no price
 * on file" instead of printing 0.00 and looking like a free line.
 */
export const asPrice = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
};

/** The unit price a product carries for one type, or null if it has none. */
export const priceOf = (product, type) => {
  const key = normalisePriceType(type);
  if (!key) return null;
  return asPrice(product?.prices?.[key]);
};

/** qty x unit price, to the paisa. Null unit price means null total, not zero. */
export const lineAmount = (unitPrice, quantity) => {
  const price = asPrice(unitPrice);
  const qty = Number(quantity);
  if (price === null || !Number.isFinite(qty) || qty <= 0) return null;
  return Math.round(price * qty * 100) / 100;
};

/** '₹1,23,456.00' — Indian grouping, which is what every other rupee figure uses. */
export const formatRupees = (value) => {
  const n = asPrice(value);
  if (n === null) return null;
  return n.toLocaleString('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
};

export default {
  PRICE_TYPES,
  PRICE_TYPE_KEYS,
  PRICE_TYPE_ENUM,
  labelForPriceType,
  normalisePriceType,
  asPrice,
  priceOf,
  lineAmount,
  formatRupees,
};
