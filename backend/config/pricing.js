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

/**
 * Rates typed in by the sales desk, line by line, instead of read from a tier.
 *
 * NOT one of PRICE_TYPES: there is no column for it in the pricelist and no
 * product carries a "manual" price, so nothing that walks the tiers (the quote,
 * the import, the selector cards) should ever see it. It is a marker on the
 * order rows saying "these unit prices were entered by hand — keep them".
 */
export const MANUAL_PRICE_TYPE = 'manual';
export const MANUAL_PRICE_LABEL = 'Manual';

/** 'trader' -> 'Trader'. Unknown or absent -> null, never a raw key. */
export const labelForPriceType = (key) => BY_KEY.get(key)?.label
  ?? (key === MANUAL_PRICE_TYPE ? MANUAL_PRICE_LABEL : null);

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
  if (flat === MANUAL_PRICE_TYPE) return MANUAL_PRICE_TYPE;
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

/** The highest price a SKU may carry: ₹10 crore. Anything above is a typo. */
export const MAX_PRICE = 100_000_000;

// Plain digits, or digits grouped the Western (1,250,000) or Indian (12,50,000)
// way. Anything else with a comma — "12,5", "1.250,50" — is a European decimal
// that a comma-stripping read would silently turn into a different amount.
const PLAIN = /^\d+(\.\d+)?$/;
const WESTERN = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const INDIAN = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;

/**
 * Read a price someone TYPED (a form, an API body, a spreadsheet cell).
 *
 * Stricter than asPrice(), which reads prices already on file: an input is
 * refused, not reinterpreted, when it is not unambiguously an amount — a
 * European decimal, hex or exponent notation, an amount that rounds to ₹0.00,
 * or one beyond MAX_PRICE. A leading ₹ / Rs / INR is allowed.
 *
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export const parsePriceInput = (raw) => {
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else {
    const text = String(raw ?? '').trim().replace(/^(₹|rs\.?|inr)\s*/i, '');
    if (!(PLAIN.test(text) || WESTERN.test(text) || INDIAN.test(text))) {
      return { ok: false, error: `"${raw}" is not an amount. Use digits, e.g. 1250.50 or 1,250.50` };
    }
    n = Number(text.replace(/,/g, ''));
  }
  if (!Number.isFinite(n)) return { ok: false, error: `"${raw}" is not an amount` };
  const value = Math.round(n * 100) / 100;
  if (value <= 0) return { ok: false, error: 'must be at least ₹0.01' };
  if (value > MAX_PRICE) return { ok: false, error: `must be at most ₹${MAX_PRICE.toLocaleString('en-IN')}` };
  return { ok: true, value };
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
