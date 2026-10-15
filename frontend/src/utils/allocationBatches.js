/**
 * A booking's INWARD ALLOCATIONS, as the batches they were made in.
 *
 * When stock arrives, everything it covers for one booking is allocated in one
 * run — several indents, several SKUs. That run is one inward allocation: one
 * number, one pick list, one status, picked and dispatched together. Its entries
 * are stored on the lines they belong to and share the moment they were made
 * (`at`), which is how they are found again here. A later run is a separate
 * allocation.
 *
 * @param {object[]} lines  The booking's lines: { lineId, skuCode, allocations: [{ seq, quantity, indentNumber, at, status }] }.
 * @returns {object[]} oldest first:
 *   { key, at, number, entries: [{ line, allocation }], quantity, skuCount, status }
 *   `status` is the batch's stage, or 'mixed' for older data whose entries
 *   were moved one at a time.
 */
export const allocationBatches = (lines) => {
  const byAt = new Map();
  for (const line of lines || []) {
    for (const allocation of line.allocations || []) {
      const key = new Date(allocation.at).toISOString();
      if (!byAt.has(key)) byAt.set(key, { key, at: allocation.at, entries: [] });
      byAt.get(key).entries.push({ line, allocation });
    }
  }

  return [...byAt.values()]
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .map((batch, i) => {
      const statuses = new Set(batch.entries.map((e) => e.allocation.status || "PO Received"));
      return {
        ...batch,
        number: i + 1,
        quantity: batch.entries.reduce((n, e) => n + (e.allocation.quantity || 0), 0),
        skuCount: new Set(batch.entries.map((e) => e.line.skuCode)).size,
        status: statuses.size === 1 ? [...statuses][0] : "mixed",
      };
    });
};

export default allocationBatches;
