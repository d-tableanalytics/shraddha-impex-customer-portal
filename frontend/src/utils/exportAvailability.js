/**
 * Live "Available Quantity" for the Booking History export, fetched when the
 * export is made and only for the SKUs in it.
 *
 * WHAT THIS REPLACES. The page used to download the product catalogue on every
 * visit — three brands at `limit=2000` each — just in case an export followed.
 * That was slow and also WRONG: Ko-ken alone has more than 7,700 products, so any
 * booked SKU past the first 2,000 alphabetically exported as "—". And because a
 * brand the user could not access answered 403, one restricted brand made the
 * whole download fail, leaving every row at "—".
 *
 * THE FIGURE IS UNCHANGED. It is still the product's `availableForSale`, which
 * is what the export always meant by "Available Quantity". The stock ledger's
 * own balance differs from it for some SKUs; which of the two is authoritative
 * is an open question and deliberately NOT decided here.
 *
 * Source: `POST /products/lookup`, which resolves a list of SKU codes within the
 * user's permitted brands. Its `available` is `availableForSale` floored at 0;
 * no product holds a negative figure (guarded writes prevent it), so it reads
 * the same value the catalogue download did.
 *
 * KNOWN LIMIT OF THAT ENDPOINT: it returns at most ONE product per SKU code.
 * If the same code existed under two brands, the line for the brand it did not
 * return reads "—" rather than borrowing the other brand's stock. No such code
 * exists today.
 */

// The lookup endpoint's own cap (LOOKUP_MAX in product.controller.js). Larger
// exports are split into requests of this size rather than truncated.
export const LOOKUP_CHUNK = 5000;

/** The value written when a line's stock cannot be determined. */
export const UNKNOWN_AVAILABILITY = "—";

const norm = (v) => String(v ?? "").trim();
const brandKey = (v) => norm(v).toLowerCase();

/** The unique, non-placeholder SKU codes across the given export lines. */
export const skusForLines = (lines) => {
  const out = new Set();
  for (const line of lines) {
    const sku = norm(line?.skuCode);
    if (sku && sku !== UNKNOWN_AVAILABILITY) out.add(sku);
  }
  return [...out];
};

/**
 * Index lookup results by SKU and brand.
 *
 * Only rows that were found AND whose own `skuCode` is the code asked for are
 * kept: for MSIL-enabled users the endpoint also matches MSIL codes, and a code
 * that matched another product's MSIL code must not lend it that product's stock.
 */
export const buildAvailabilityIndex = (rows = []) => {
  const index = new Map(); // sku -> Map(brandKey -> available)
  for (const row of rows) {
    if (!row?.found) continue;
    const sku = norm(row.skuCode);
    if (!sku || (row.lookupCode !== undefined && norm(row.lookupCode) !== sku)) continue;
    if (!index.has(sku)) index.set(sku, new Map());
    index.get(sku).set(brandKey(row.brand), row.available);
  }
  return index;
};

/**
 * The available quantity for one export line, or "—".
 *
 * Matched on SKU AND brand. A line with no brand (legacy rows) is matched only
 * when the SKU resolved to exactly one product, so it cannot pick between two.
 */
export const availabilityFor = (index, line) => {
  const byBrand = index.get(norm(line?.skuCode));
  if (!byBrand) return UNKNOWN_AVAILABILITY;
  let value;
  if (norm(line?.brand)) {
    value = byBrand.get(brandKey(line.brand));
  } else if (byBrand.size === 1) {
    [value] = byBrand.values();
  }
  return typeof value === "number" && Number.isFinite(value) ? value : UNKNOWN_AVAILABILITY;
};

/**
 * Fetch availability for every SKU in `lines`, in chunks the endpoint accepts.
 *
 * `lookup` is `(skuCodes) => Promise<{ data }>` — productsApi.lookupSkus.
 * A failed chunk REJECTS: an export that quietly printed "—" for stock it could
 * not read is the defect this replaces, so the caller reports the failure.
 */
export const fetchExportAvailability = async (lines, lookup) => {
  const skus = skusForLines(lines);
  if (skus.length === 0) return new Map();
  const chunks = [];
  for (let i = 0; i < skus.length; i += LOOKUP_CHUNK) chunks.push(skus.slice(i, i + LOOKUP_CHUNK));
  const results = await Promise.all(chunks.map((chunk) => lookup(chunk)));
  return buildAvailabilityIndex(results.flatMap((r) => r?.data || []));
};
