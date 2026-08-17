/**
 * Escape a value for insertion into HTML text.
 *
 * Inventory data is full of characters HTML treats as markup. A SKU like
 * `A<B>C` dropped straight into a `<td>` loses "<B>" to the parser and prints
 * as "AC" — the value silently changes meaning in the one artefact somebody
 * carries onto the warehouse floor. `&` is just as bad: it opens an entity, so
 * "Nut & Bolt" is at the mercy of what follows it.
 *
 * Escaping is what makes the printed cell show the value that is stored. It is
 * not a transformation of the data — the entity is how HTML spells that exact
 * character — and nothing here is ever written back to the database.
 *
 * `&` must be replaced FIRST, or the ampersands introduced by the later
 * replacements get escaped a second time and `<` prints as "&amp;lt;".
 */
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export default escapeHtml;
