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

export default { prefixMatch };
