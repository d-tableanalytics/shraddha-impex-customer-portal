import { Product } from '../models/Product.js';

/**
 * Normalisers for product fields that carry a schema enum.
 *
 * The valid values are read from the schema itself, so the model stays the
 * single source of truth and an import can never write something the model
 * would reject.
 *
 * Why this exists: `currentSeason` used to be a free string, and the importers
 * wrote whatever the spreadsheet contained. Now that it is enum-constrained,
 * the two importers would fail differently on a bad value — `insertMany` runs
 * validators and throws mid-import, while `bulkWrite` skips them and writes an
 * invalid document. Neither is acceptable, so both now validate up front and
 * report before anything is written.
 */

const SEASONS = Product.schema.path('currentSeason').enumValues.filter(Boolean);
const STATUSES = Product.schema.path('status').enumValues;

export const VALID_SEASONS = SEASONS;
export const VALID_STATUSES = STATUSES;

/**
 * Map a spreadsheet season cell onto the schema enum.
 *
 * Blank is legitimate — it means "not classified" and stores as null. Casing
 * and surrounding whitespace are normalised, because "normal" and " Normal "
 * are obviously the same value and failing an import over that would be
 * pedantic. Anything else is reported rather than guessed at.
 *
 * @returns {{ ok: boolean, value: string|null, raw: string|null }}
 */
export const normaliseSeason = (input) => {
  if (input === null || input === undefined) return { ok: true, value: null, raw: null };

  const raw = String(input).trim();
  if (raw === '') return { ok: true, value: null, raw: null };

  const match = SEASONS.find((s) => s.toLowerCase() === raw.toLowerCase());
  return match
    ? { ok: true, value: match, raw }
    : { ok: false, value: null, raw };
};

/**
 * Map a spreadsheet status cell onto the schema enum. Unlike season this has
 * always been lenient — blank means Active and prefixes are matched — so the
 * behaviour is preserved exactly and only the valid set is now schema-derived.
 */
export const normaliseStatus = (input) => {
  const raw = input === null || input === undefined ? '' : String(input).trim();
  if (raw === '') return 'Active';
  const l = raw.toLowerCase();
  if (l.startsWith('inact')) return 'Inactive';
  if (l.startsWith('discont')) return 'Discontinued';
  return 'Active';
};

/**
 * Report helper — formats the rejected season values an importer collected.
 * Returns null when there is nothing to report.
 */
export const describeSeasonIssues = (issues) => {
  if (!issues.length) return null;
  const distinct = [...new Set(issues.map((i) => i.raw))];
  return (
    `${issues.length} row(s) carry a "Current Season" value that is not one of ` +
    `${SEASONS.join(' / ')}: ${distinct.map((d) => `"${d}"`).join(', ')}. ` +
    `Correct the source sheet, or add the value to the Product schema enum.`
  );
};

export default {
  VALID_SEASONS,
  VALID_STATUSES,
  normaliseSeason,
  normaliseStatus,
  describeSeasonIssues,
};
