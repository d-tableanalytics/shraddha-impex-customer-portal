/**
 * The search rule shared by Booking History and Indent History.
 *
 * BOTH SCREENS SHOW GROUPS, NOT LINES. A booking row is every order line
 * sharing one booking id; an indent row is every pending line sharing one
 * indent number. The screens were then filtering on the group's own fields —
 * its number, its PO, its customer — which meant a SKU that was plainly there
 * on screen, one click into the row, matched nothing.
 *
 * So a search term is tested against the GROUP AND EVERY LINE INSIDE IT, and a
 * hit on any line returns the whole group. That is what "the search should not
 * be restricted to a single group" means in practice: type a SKU and you get
 * every booking and every indent that SKU appears in, whichever group it sits
 * in and wherever in that group it sits.
 *
 * One definition for both screens, because two would eventually disagree about
 * whether an MSIL code counts — and the customer typing it into one box and
 * then the other is the same person expecting the same answer.
 */

/** Case-insensitive "contains", tolerant of null, numbers and undefined. */
const contains = (value, needle) =>
  String(value ?? '').toLowerCase().includes(needle);

/**
 * Does this search term match any code on any of a group's lines?
 *
 * MSIL codes are matched as well as SKU codes. An MSIL customer knows their
 * parts by the MSIL code and nothing else, so a search box that only understood
 * SKU codes was unusable for exactly the people who had the most rows to search.
 * Matching it for everyone is harmless: a non-MSIL user simply never types one.
 *
 * @param {Array}  lines  the group's line items, in whatever shape the screen holds
 * @param {string} needle already lower-cased
 */
export const linesMatch = (lines, needle) =>
  (Array.isArray(lines) ? lines : []).some((line) => {
    // The two screens hold a line differently — Booking History keeps the codes
    // flat on the line, Indent History nests them under `product`. Both shapes
    // are read rather than one being normalised into the other, because the
    // stores each have their own reasons for the shape they hold.
    const code = line?.skuCode ?? line?.product?.code ?? line?.code;
    const msil = line?.msilCode ?? line?.product?.msilCode;
    return contains(code, needle) || contains(msil, needle);
  });

/**
 * Does this group match the term, by its own fields or by any of its lines?
 *
 * @param {object}   group
 * @param {string[]} groupFields  values off the group itself (number, PO, customer)
 * @param {Array}    lines        the group's lines
 * @param {string}   query        the raw search box contents
 */
export const groupMatches = (groupFields, lines, query) => {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  return groupFields.some((f) => contains(f, needle)) || linesMatch(lines, needle);
};

export default { linesMatch, groupMatches };
