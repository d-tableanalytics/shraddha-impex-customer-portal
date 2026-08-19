/**
 * Search-term handling for product lookups.
 *
 * Two rules, both learned the hard way:
 *
 * 1. ANCHOR THE PATTERN. An unanchored `{ $regex: term }` cannot use an index,
 *    so every debounced keystroke became a full collection scan across ~8,600
 *    products. A prefix-anchored pattern lets the {brand, skuCode} index serve
 *    the query.
 *
 * 2. ESCAPE THE INPUT. A raw user string in a regex is a denial-of-service
 *    vector (catastrophic backtracking) and produces wrong matches for SKUs,
 *    which are full of regex metacharacters — `13012M.52-10` contains a `.`
 *    that would otherwise match any character.
 *
 * TRADE-OFF: prefix matching means searching "52-10" no longer finds
 * "13012M.52-10". This is a deliberate product decision — both inventory
 * screens now behave the same way, and the alternative was an unindexed scan.
 * If mid-string search is needed later, the right answer is a text index or a
 * dedicated search field, not removing the anchor.
 *
 * ── UPDATE: that trade-off does not hold for the $or search ────────────────
 * The booking dropdown asks `$or: [{skuCode}, {msilCode}]`, and MEASURED
 * against the live catalogue (8,585 products) the anchor buys nothing there:
 *
 *   term "13012"  prefix   80ms  keysExamined 7713
 *                 contains 69ms  keysExamined 7713
 *   term "52-10"  prefix   67ms  keysExamined 7713  ->  0 results
 *                 contains 66ms  keysExamined 7713  ->  3 results
 *
 * Both walk the whole index because the msilCode branch of the $or cannot be
 * served by the {brand, skuCode} index anyway. The anchor was therefore paying
 * the full cost of a scan while still refusing mid-string matches. containsMatch()
 * below is for that query; prefixMatch() stays for the paged list screens,
 * where the query shape is different and the anchor still earns its keep.
 */

/** Escape every regex metacharacter so the term is matched literally. */
const escapeRegex = (term) => String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive prefix matcher, or null when there is nothing to search for.
 * Returns null rather than an empty regex so callers can skip the clause
 * entirely instead of adding one that matches everything.
 */
export const prefixMatch = (term) => {
  if (typeof term !== 'string') return null;
  const trimmed = term.trim();
  if (!trimmed) return null;
  return new RegExp(`^${escapeRegex(trimmed)}`, 'i');
};

/**
 * Case-insensitive CONTAINS matcher, or null when there is nothing to search.
 *
 * For the SKU picker, where a buyer knows a fragment of the code rather than
 * how it starts — "52-10" has to find "13012M.52-10". Escaped for the same two
 * reasons prefixMatch escapes: a raw term is a backtracking DoS vector, and SKU
 * codes are full of regex metacharacters that would otherwise match the wrong
 * part ("115.100" must not match "115X100").
 */
export const containsMatch = (term) => {
  if (typeof term !== 'string') return null;
  const trimmed = term.trim();
  if (!trimmed) return null;
  return new RegExp(escapeRegex(trimmed), 'i');
};

/**
 * Escaped term for building a "starts with" test inside an aggregation, where
 * a JS RegExp cannot be used as a $regexMatch pattern.
 */
export const escapedTerm = (term) => escapeRegex(String(term ?? '').trim());

export default { prefixMatch, containsMatch, escapedTerm };
