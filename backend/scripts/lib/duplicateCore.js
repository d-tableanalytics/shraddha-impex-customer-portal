/**
 * Over-counted ledger movements — detection and correction.
 *
 * Before the posting deferral existed, a booking transaction that retried left
 * a posting behind on every attempt. 52 reference/SKU/type groups now hold more
 * movements than the events they describe: BO-2026-000129 carries the same
 * RESERVE ten times.
 *
 * THE HARD PART IS NOT FINDING THEM, IT IS TELLING THEM APART
 * -----------------------------------------------------------
 * A booking confirmed, cancelled and confirmed again produces two honest
 * RESERVE movements under one booking id. A booking whose transaction retried
 * produces two as well. Counted naively the two are identical, which is why
 * the first pass over this data reported 52 problems where only 34 exist.
 *
 * What separates them is the rest of the history. Every genuine cycle leaves a
 * matching counter-movement: a RESERVE that was cancelled has a RELEASE, an
 * ISSUE that was returned has a RECEIPT. So the number of movements a line
 * SHOULD carry is
 *
 *     expected = offsetting movements + (1 if the line still holds stock)
 *
 * and anything beyond that is a duplicate. A line reserved, cancelled and
 * reserved again holds stock and has one RELEASE, so it should have two
 * RESERVEs — and two is what it has. A line that retried four times has no
 * RELEASE at all, so it should have one, and three are surplus.
 *
 * NOTHING IS DELETED
 * ------------------
 * The ledger is immutable by design, and a historical record that can be
 * deleted is not a record. A surplus movement is corrected the way the ledger
 * already corrects anything — `reverseMovement()` posts a REVERSAL contra-entry
 * inheriting the original's class, and stamps `reversedBy` on the original so
 * the pair reads as what it is. The original stays, visible, forever.
 *
 * That also makes the correction idempotent for free: a reversed movement is
 * excluded from the next count, so a second run finds no surplus.
 */

/** What cancels out what. Used to tell a cycle from a duplicate. */
const OPPOSITE = {
  RESERVE: 'RELEASE',
  RELEASE: 'RESERVE',
  ISSUE: 'RECEIPT',
  RECEIPT: 'ISSUE',
};

/** A line still holding stock is one neither cancelled nor settled. */
const stillHolding = (line) => Boolean(line)
  && line.status !== 'Cancelled'
  && (line.stockState === 'reserved' || line.stockState === null || line.stockState === undefined);

/**
 * Find groups carrying more movements than their history accounts for.
 *
 * Only movements that have NOT been reversed are counted, which is what makes
 * running this twice a no-op.
 *
 * @returns {Promise<Array>} one entry per over-counted group, newest-first
 *          surplus listed in `surplus` — the rows a correction would reverse.
 */
export const findOverCounted = async (db, { skuCode = null } = {}) => {
  const match = { referenceId: { $ne: null }, reversedBy: null, movementType: { $in: Object.keys(OPPOSITE) } };
  if (skuCode) match.skuCode = skuCode;

  const groups = await db.collection('stockmovements').aggregate([
    { $match: match },
    {
      $group: {
        _id: { referenceId: '$referenceId', skuCode: '$skuCode', movementType: '$movementType' },
        n: { $sum: 1 },
        rows: {
          $push: {
            transactionId: '$transactionId',
            quantity: '$quantity',
            effectiveDate: '$effectiveDate',
            postedAt: '$postedAt',
            batchId: '$batchId',
          },
        },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  if (groups.length === 0) return [];

  // The order lines these reference, so "does it still hold stock?" can be
  // answered from the commitment document rather than guessed.
  const refs = [...new Set(groups.map((g) => g._id.referenceId))];
  const skus = [...new Set(groups.map((g) => g._id.skuCode))];
  const lines = await db.collection('orders').find(
    { orderId: { $in: refs }, skuCode: { $in: skus } },
    { projection: { orderId: 1, skuCode: 1, stockState: 1, status: 1, confirmedQty: 1 } },
  ).toArray();
  const lineOf = new Map(lines.map((l) => [`${l.orderId}::${l.skuCode}`, l]));

  // Counter-movements, also excluding reversed ones.
  const counters = await db.collection('stockmovements').aggregate([
    { $match: { referenceId: { $in: refs }, skuCode: { $in: skus }, reversedBy: null } },
    { $group: { _id: { referenceId: '$referenceId', skuCode: '$skuCode', movementType: '$movementType' }, n: { $sum: 1 } } },
  ]).toArray();
  const counterOf = new Map(counters.map((c) => [`${c._id.referenceId}::${c._id.skuCode}::${c._id.movementType}`, c.n]));

  const out = [];
  for (const g of groups) {
    const { referenceId, skuCode: sku, movementType } = g._id;
    const line = lineOf.get(`${referenceId}::${sku}`);
    const offsets = counterOf.get(`${referenceId}::${sku}::${OPPOSITE[movementType]}`) ?? 0;

    // An allocation that is still held needs one live movement; a settled or
    // cancelled one needs none beyond the cycles its counters already prove.
    const holdsOne = movementType === 'RESERVE' ? (stillHolding(line) ? 1 : 0)
      : movementType === 'ISSUE' ? 1
        : movementType === 'RELEASE' ? ((line && !stillHolding(line)) ? 1 : 0)
          : 1;
    const expected = Math.max(1, offsets + holdsOne);
    const surplusCount = g.n - expected;
    if (surplusCount <= 0) continue;

    // Keep the OLDEST as the genuine record and reverse the later copies: the
    // first posting is the one the rest of the history was written against.
    const ordered = [...g.rows].sort((a, b) =>
      new Date(a.postedAt ?? a.effectiveDate) - new Date(b.postedAt ?? b.effectiveDate));
    const surplus = ordered.slice(expected);

    out.push({
      referenceId,
      skuCode: sku,
      movementType,
      actual: g.n,
      offsets,
      expected,
      surplusCount,
      surplusQuantity: surplus.reduce((n, r) => n + (r.quantity ?? 0), 0),
      orderState: line ? { stockState: line.stockState ?? null, status: line.status } : null,
      surplus,
      keep: ordered.slice(0, expected).map((r) => r.transactionId),
    });
  }
  out.sort((a, b) => b.surplusCount - a.surplusCount);
  return out;
};

/**
 * Post a REVERSAL against every surplus movement.
 *
 * Idempotent twice over: `reverseMovement` refuses a movement already reversed,
 * and the detector above excludes reversed movements from the next count.
 */
export const correctOverCounted = async (groups, { runId }) => {
  const { reverseMovement } = await import('../../modules/inventory/ledger.service.js');
  const reversed = [];
  const failed = [];

  for (const g of groups) {
    for (const row of g.surplus) {
      try {
        await reverseMovement({
          transactionId: row.transactionId,
          idempotencyKey: `dupfix:${runId}:${row.transactionId}`,
          reasonCode: 'REVERSAL',
          note: `Duplicate correction ${runId}: ${g.movementType} recorded ${g.actual} time(s) for `
            + `${g.referenceId}/${g.skuCode}; history accounts for ${g.expected}.`,
        });
        reversed.push({ ...g, transactionId: row.transactionId, quantity: row.quantity });
      } catch (error) {
        failed.push({ transactionId: row.transactionId, skuCode: g.skuCode, error: error.message });
      }
    }
  }
  return { reversed, failed, skus: [...new Set(reversed.map((r) => r.skuCode))] };
};

export default { findOverCounted, correctOverCounted };
