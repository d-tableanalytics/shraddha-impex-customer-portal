/**
 * Split booking lines into what can be booked from stock now and what becomes
 * an indent.
 *
 * Shared by Individual Booking and Bulk Upload. It lived inside the individual
 * flow while bulk had no review step at all; now both show the same popup, and
 * two copies of this arithmetic would eventually disagree about how many units
 * a customer is actually getting.
 *
 * @param {Array} lines  [{ product: { code, availableStock }, orderQuantity }]
 */
export const computeReview = (lines = []) => {
  const available = [];
  const pending = [];

  lines.forEach((item) => {
    const avl = item.product?.availableStock ?? 0;
    const req = item.orderQuantity ?? 0;
    const bookNow = Math.min(req, avl);
    const short = Math.max(0, req - avl);

    if (bookNow > 0) {
      available.push({ code: item.product?.code, requested: req, bookable: bookNow });
    }
    if (short > 0) {
      pending.push({ code: item.product?.code, requested: req, available: avl, pending: short });
    }
  });

  return { available, pending };
};

/**
 * Bulk-upload rows in the shape computeReview expects.
 *
 * A bulk row already carries the validated product and its quantity; this only
 * renames the fields, so both flows are reviewed against the same stock figure
 * by the same code.
 */
export const linesFromBulkRows = (rows = []) =>
  rows
    .filter((r) => r.product)
    .map((r) => ({
      product: { code: r.product.code ?? r.skuCode, availableStock: r.product.availableStock ?? 0 },
      orderQuantity: Number(r.quantity) || 0,
    }));

export default { computeReview, linesFromBulkRows };
