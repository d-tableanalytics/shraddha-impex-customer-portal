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

/**
 * Band presentation, taken from the source workbook's own legend fills.
 *
 * The workbook colours the "Available in %" column against Max Level:
 *
 *     Below 33%          FF0000  red
 *     33 to 66%          FFFF00  yellow
 *     66 to 100%         00FF00  green
 *     Greater then 100%  D5A6BD  dusty pink
 *
 * Those exact values are unreadable behind text at UI size — pure yellow in
 * particular — so each is toned down while keeping the same hue and the same
 * mapping. A row that is red in the spreadsheet is red here.
 *
 * Out of Stock shares red with Critical, as the workbook does; it is given the
 * deeper shade because a stock-out is a different conversation from "very low".
 * No Planning Data is neutral grey: a missing input is a data gap, not a
 * shortage, and colouring it red would drown the 453 SKUs that need attention
 * under 7,900 that merely need a number typed in.
 */
export const BAND_STYLES = {
  // Solid fills, as the workbook has them. A pale tint with a small dot is
  // invisible at a glance across a dense table, which defeats the point of
  // colouring the column at all — the whole reason it exists is to be readable
  // without reading.
  //
  // Text colour is chosen per band for contrast, not by rule: white sits well
  // on the reds and green, but not on yellow or the muted pink, where a dark
  // tone of the same hue is legible and a white one is not.
  "Out of Stock": { chip: "bg-red-600 text-white", dot: "bg-white/80" },
  Critical: { chip: "bg-red-500 text-white", dot: "bg-white/80" },
  Low: { chip: "bg-amber-400 text-amber-950", dot: "bg-amber-900/70" },
  Healthy: { chip: "bg-green-600 text-white", dot: "bg-white/80" },
  Overstock: { chip: "bg-[#c48aa6] text-[#3d1a2b]", dot: "bg-[#3d1a2b]/60" },
  Unknown: { chip: "bg-slate-200 text-slate-600", dot: "bg-slate-400" },
};

export const bandStyle = (band) => BAND_STYLES[band] ?? BAND_STYLES.Unknown;
