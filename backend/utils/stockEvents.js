/**
 * Broadcast that stock changed, so open screens re-read instead of showing a
 * figure that is now wrong.
 *
 * Lives apart from the balance service on purpose: that service is pure
 * projection logic and should not know an HTTP layer exists. The callers that
 * already hold a request pass it in here.
 *
 * NEVER THROWS. A socket that is missing, or a request whose app is gone
 * because the work outlived the response, must not fail the stock posting that
 * has already succeeded — the change is durable either way, and the worst case
 * is a screen that updates on its next fetch rather than instantly.
 */
export const emitStockUpdated = (req, skuCodes, extra = {}) => {
  try {
    const io = req?.app?.get?.('io');
    if (!io) return;

    const skus = [...new Set((skuCodes || []).filter(Boolean))];
    if (skus.length === 0) return;

    io.emit('inventory:stock-updated', {
      skuCodes: skus,
      // A bulk posting carries the count rather than every SKU's new figure —
      // a listener that wants numbers refetches, and one that only needs to
      // know something moved does not pay for a payload it will discard.
      count: skus.length,
      ...extra,
    });
  } catch {
    // Deliberately swallowed — see above.
  }
};

export default { emitStockUpdated };
