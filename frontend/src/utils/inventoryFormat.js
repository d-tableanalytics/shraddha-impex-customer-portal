/**
 * Display helpers for inventory figures.
 */

/**
 * Format the Available % figure for a table cell — a bare number.
 *
 * The "%" sign is deliberately omitted: the column header carries the unit, so
 * repeating it on every row only crowds the value. Not capped either — this is
 * the true ratio of stock to target, so it can exceed 100.
 *
 * `exactPercent` below keeps the sign, for the places that spell out the
 * arithmetic rather than tabulate it.
 */
export const formatAvailablePercent = (value, { decimals = 1 } = {}) => {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const factor = 10 ** decimals;
  // No "%" sign: the column header already names the unit, and repeating it on
  // every cell only crowds the number.
  return `${Math.round(value * factor) / factor}`;
};

/**
 * Display label for a health band.
 *
 * "Unknown" reads as though the system is confused about the stock. It is not:
 * it knows the stock exactly and cannot compute a TARGET, because the SKU has
 * no daily consumption rate. "No Planning Data" says which of those two it is,
 * and points at the thing that fixes it.
 *
 * THE STORED VALUE IS UNCHANGED. `band` is still "Unknown" in the projection,
 * in exports, in the ?band= query parameter and in the alert engine — renaming
 * it there would mean migrating 7,924 rows and re-keying live alerts to change
 * a word on a screen. This maps at the point of display only.
 */
export const BAND_LABELS = {
  Unknown: "No Planning Data",
};

export const bandLabel = (band) => BAND_LABELS[band] ?? band ?? "—";

/** The uncapped figure, for places that are explaining the arithmetic itself. */
export const exactPercent = (value, { decimals = 1 } = {}) => {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const factor = 10 ** decimals;
  return `${Math.round(value * factor) / factor}%`;
};

export default { formatAvailablePercent, exactPercent };
