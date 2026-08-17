/**
 * What an imported Box No cell means.
 *
 * Two rules, both pure, both used by more than one caller — the template
 * validator that accepts or rejects a row, and the writer that decides what to
 * save. Expressed separately in each place they would eventually disagree, and
 * the direction that disagreement fails in is silent data loss across the whole
 * catalogue.
 *
 * Deliberately NOT in import.templates.js: that file states it contains no
 * inventory logic, and deciding which SKUs move box is inventory logic.
 */

/**
 * Does this row actually supply a box number?
 *
 * A BLANK CELL MEANS "LEAVE THE EXISTING MAPPING ALONE" — never "clear it". So
 * does a file with no Box No column at all, which is the common case: box
 * numbers are set once in a while, and the sheets carrying the column are
 * uploaded constantly for their quantities. There is deliberately no way to
 * unmap a box through an import, because an empty column is far more often an
 * empty column than an instruction to erase thousands of mappings.
 *
 * A box literally named "0" is a real box, so the test is against null, undefined
 * and empty — never falsiness.
 */
export const suppliesBoxNo = (row) =>
  row?.boxNo !== undefined && row?.boxNo !== null && row?.boxNo !== '';

/** Identity of a product. The same SKU code under two brands is two products. */
export const boxRowKey = (skuCode, brand) => `${skuCode}::${brand}`;

/**
 * Which of these rows actually MOVE a SKU to a different box.
 *
 * A supplied box number REPLACES whatever is on file — that is the whole point
 * of putting the column on the sheet. What this filters out is the row that
 * supplies the value already stored: re-uploading an exported sheet must not
 * count as thousands of changes, or every such upload would write the catalogue
 * back over itself and post an audit entry claiming it had re-boxed everything.
 *
 * @param {Array}  rows    staged rows, each { rowNumber, data: { skuCode, brand, boxNo } }
 * @param {Map}    before  boxRowKey → the box number currently on file (null if unmapped)
 * @returns {Array} [{ skuCode, brand, from, to }] — only genuine changes
 */
export const boxNumberChanges = (rows, before) =>
  rows
    .map((r) => ({
      skuCode: r.data.skuCode,
      brand: r.data.brand,
      // Absent from the map means the product was not found at all. Treated as
      // "no box on file", so a first mapping still reads as a change.
      from: before.get(boxRowKey(r.data.skuCode, r.data.brand)) ?? null,
      to: r.data.boxNo,
    }))
    .filter((c) => c.from !== c.to);

export default { suppliesBoxNo, boxRowKey, boxNumberChanges };
