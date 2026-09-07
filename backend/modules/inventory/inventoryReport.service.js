import StockHealth, { HEALTH_BANDS } from '../../models/StockHealth.js';
import { Product } from '../../models/Product.js';
import { classify } from './health.service.js';
import { resolveConfig } from './config.service.js';

/**
 * The data behind the weekly inventory health report.
 *
 * READS THE PROJECTION, CALCULATES NOTHING. The bands come from `stockhealth`,
 * which Module M4 maintains and which the Inventory Health screen reads. That is
 * the whole point: a report that recomputed its own bands would eventually
 * disagree with the screen, and the disagreement would surface as an argument
 * about which number is right rather than as a bug anyone could find.
 *
 * The one exception is a deliberate one. When the operator sets report-specific
 * thresholds, the rows are re-banded — using M4's own `classify()`, never a
 * second copy of it — and the report states on its summary page that it is not
 * using the configured thresholds. One classifier, two possible inputs, and the
 * reader is told which was used.
 */

/**
 * The four statuses the report colours, in the order it presents them.
 *
 * Overstock and Unknown are NOT invented away: they are real bands a SKU can be
 * in, and folding them into "healthy" would overstate how much of the catalogue
 * is fine. They are reported in their own right, below the four the requirement
 * names, and coloured neutrally.
 */
export const REPORT_BANDS = [
  {
    band: HEALTH_BANDS.OUT_OF_STOCK,
    key: 'outOfStock',
    label: 'Out of Stock',
    // Red. Nothing on the shelf — the most urgent thing on the page.
    argb: 'FFDC2626',
    fill: 'FFFEE2E2',
    rgb: [220, 38, 38],
    note: 'No stock on hand',
  },
  {
    band: HEALTH_BANDS.CRITICAL,
    key: 'critical',
    label: 'Critical',
    // Orange. Close to running out; needs ordering now.
    argb: 'FFEA580C',
    fill: 'FFFFEDD5',
    rgb: [234, 88, 12],
    note: 'At or below the reorder level',
  },
  {
    band: HEALTH_BANDS.LOW,
    key: 'low',
    label: 'Low',
    // Amber. Below the low-stock threshold but not yet urgent.
    argb: 'FFCA8A04',
    fill: 'FFFEF9C3',
    rgb: [202, 138, 4],
    note: 'Below the low-stock threshold',
  },
  {
    band: HEALTH_BANDS.HEALTHY,
    key: 'healthy',
    label: 'Healthy',
    // Green. Sufficient cover.
    argb: 'FF16A34A',
    fill: 'FFDCFCE7',
    rgb: [22, 163, 74],
    note: 'Sufficient stock against the target level',
  },
  {
    band: HEALTH_BANDS.OVERSTOCK,
    key: 'overstock',
    label: 'Overstock',
    argb: 'FF2563EB',
    fill: 'FFDBEAFE',
    rgb: [37, 99, 235],
    note: 'Above the target level',
  },
  {
    band: HEALTH_BANDS.UNKNOWN,
    key: 'unknown',
    label: 'Not planned',
    argb: 'FF64748B',
    fill: 'FFF1F5F9',
    rgb: [100, 116, 139],
    note: 'Missing consumption, lead time or safety factor — no band can be derived',
  },
];

const BAND_BY_NAME = new Map(REPORT_BANDS.map((b) => [b.band, b]));

/** The presentation record for a band. Never undefined — Unknown is the floor. */
export const bandStyle = (band) => BAND_BY_NAME.get(band) ?? BAND_BY_NAME.get(HEALTH_BANDS.UNKNOWN);

/**
 * Order rows worst-first.
 *
 * A support team reading this on a Monday morning wants the things that need
 * doing at the top. Alphabetical by SKU would bury every out-of-stock line among
 * seven thousand healthy ones.
 */
const BAND_SEVERITY = new Map(REPORT_BANDS.map((b, i) => [b.band, i]));

/**
 * Which week this report is FOR, and the key that makes it unrepeatable.
 *
 * ISO week numbering, in the report's own timezone. Two attempts at the same
 * occurrence — a restart, an overlapping deploy, a manual run on the same day —
 * derive the same key and the second is refused by the unique index.
 */
export const occurrenceOf = (when = new Date(), timezone = 'Asia/Kolkata') => {
  // Read the wall-clock date in the configured zone, so a job firing at 08:00
  // IST is not attributed to the previous day because the server runs in UTC.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));

  // ISO-8601 week: Thursday decides the year, weeks start on Monday.
  const thursday = new Date(local);
  const dayNum = (local.getUTCDay() + 6) % 7;          // Mon=0 … Sun=6
  thursday.setUTCDate(local.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));

  const isoYear = thursday.getUTCFullYear();
  const label = `${isoYear}-W${String(week).padStart(2, '0')}`;

  return {
    isoYear,
    week,
    label,
    // The Monday of this week, in the report's zone, for the header.
    weekStart: new Date(local.getTime() - dayNum * 24 * 3600 * 1000),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
};

/**
 * Gather every row the report shows, plus the summary counts.
 *
 * One pass over the health projection and one lookup of the product names it
 * references — not a product query per row, which for a 7,000-SKU catalogue is
 * 7,000 round trips for a column of text.
 */
export const gatherInventoryHealthReport = async ({
  brands = [],
  thresholdOverrides = null,
  timezone = 'Asia/Kolkata',
  generatedAt = new Date(),
} = {}) => {
  const filter = {};
  if (Array.isArray(brands) && brands.length) filter.brand = { $in: brands };

  const health = await StockHealth.find(filter).lean();

  // Names come from the product master; the projection carries codes and
  // numbers only. Fetched in one query keyed by the codes actually present.
  const codes = [...new Set(health.map((h) => h.skuCode))];
  const products = codes.length
    ? await Product.find({ skuCode: { $in: codes } }, 'skuCode brand description msilCode uom status').lean()
    : [];
  const productBy = new Map(products.map((p) => [`${p.skuCode}::${p.brand}`, p]));

  /**
   * The thresholds the report is banding against, and whether they are the
   * system's own. Resolved once — the global scope is what the report covers,
   * and per-SKU scopes would make the summary counts unexplainable.
   */
  const config = await resolveConfig({});
  const configured = {
    critical: config?.thresholds?.critical ?? 33,
    low: config?.thresholds?.low ?? 66,
    healthy: config?.thresholds?.healthy ?? 100,
  };
  const usingOverrides = Boolean(thresholdOverrides);
  const thresholds = usingOverrides
    ? {
      critical: thresholdOverrides.critical ?? configured.critical,
      low: thresholdOverrides.low ?? configured.low,
      healthy: configured.healthy,
    }
    : configured;

  const rows = health.map((h) => {
    const product = productBy.get(`${h.skuCode}::${h.brand}`);
    // Re-banded ONLY when the operator asked for different thresholds, and then
    // through M4's own classifier rather than a second implementation.
    const band = usingOverrides
      ? classify({
        plannable: h.plannable,
        onHand: h.onHand,
        percent: h.replenishmentPercent,
        thresholds,
      })
      : h.band;

    return {
      skuCode: h.skuCode,
      brand: h.brand,
      // The catalogue has never had a display name for most SKUs, so the code
      // is the honest fallback rather than a blank cell.
      name: product?.description || h.skuCode,
      msilCode: product?.msilCode || null,
      uom: product?.uom || 'PCS',
      status: product?.status || null,
      onHand: h.onHand ?? 0,
      reserved: h.reserved ?? 0,
      available: h.available ?? 0,
      // Null, not zero, when it cannot be derived — a zero reorder level reads
      // as "never reorder" and is indistinguishable from a real one.
      reorderLevel: h.reorderLevel ?? null,
      maxLevel: h.maxLevel ?? null,
      replenishmentPercent: h.replenishmentPercent ?? null,
      coverageDays: h.coverageDays ?? null,
      band,
      // What the projection last recomputed this row, which is the honest
      // answer to "how current is this line".
      lastUpdated: h.computedAt || h.updatedAt || null,
    };
  });

  rows.sort((a, b) => {
    const severity = (BAND_SEVERITY.get(a.band) ?? 99) - (BAND_SEVERITY.get(b.band) ?? 99);
    if (severity !== 0) return severity;
    // Within a band, least cover first — the same "worst first" idea one level
    // down, so the top of the Critical block is the most critical of them.
    const pa = a.replenishmentPercent ?? Number.POSITIVE_INFINITY;
    const pb = b.replenishmentPercent ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return String(a.skuCode).localeCompare(String(b.skuCode));
  });

  const summary = { total: rows.length };
  for (const b of REPORT_BANDS) summary[b.key] = 0;
  for (const r of rows) {
    const style = bandStyle(r.band);
    summary[style.key] += 1;
  }
  // The four the requirement names, called what it calls them, so a caller does
  // not have to know the band vocabulary to write the email.
  summary.needsAttention = summary.outOfStock + summary.critical + summary.low;

  const occurrence = occurrenceOf(generatedAt, timezone);

  return {
    rows,
    summary,
    occurrence,
    generatedAt,
    timezone,
    thresholds,
    usingOverrides,
    configuredThresholds: configured,
    brands: Array.isArray(brands) && brands.length ? brands : null,
  };
};

export default { gatherInventoryHealthReport, REPORT_BANDS, bandStyle, occurrenceOf };
