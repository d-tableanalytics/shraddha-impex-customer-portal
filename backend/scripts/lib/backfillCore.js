/**
 * Phase 3 backfill — the reconstruction logic, separated from the command line.
 *
 * Kept apart from backfill-ledger.js so the plan, the apply and the rollback
 * can be tested against an in-memory database without going through argv, and
 * so the CLI cannot seal the connection a test is trying to write to.
 */
export const BACKFILL_WORKFLOW = 'ledger-backfill';

/** `backfill:<orderId>:<sku>:<type>` — derived from what identifies the movement. */
export const backfillKey = (orderId, skuCode, movementType) =>
  `backfill:${orderId}:${skuCode}:${movementType}`;

/**
 * The movements an order line implies, each with the date it happened.
 *
 * Emitted in the order the events ran: the RESERVE that created the
 * commitment, then whatever settled it.
 */
/**
 * How many confirm/cancel cycles a line went through, from the evidence.
 *
 * `stockState` records only where a line ENDED. A booking confirmed, cancelled
 * and confirmed again has `stockState: 'reserved'` and looks, from that field
 * alone, exactly like one confirmed once. Reconstructing from it would compress
 * three events into one.
 *
 * `bookingstatusevents` and the audit log both record the transitions, so they
 * are what the cycle count comes from.
 *
 * WHY THE NET IS STILL RECONSTRUCTED, NOT EVERY CYCLE. A completed cycle is a
 * RESERVE and a matching RELEASE: it nets to zero and changes no balance. The
 * figures are therefore correct either way, and inventing dated pairs for
 * cycles whose timestamps are not recorded per line would be writing fiction
 * into a ledger to make it look complete. So the net position is reconstructed
 * and the compression is REPORTED — which is the same rule the rest of this
 * file follows: report what cannot be known, never guess it.
 */
export const cycleEvidence = async (db, orderIds) => {
  const ids = [...new Set(orderIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const byOrder = new Map();
  const bump = (orderId, kind) => {
    if (!byOrder.has(orderId)) byOrder.set(orderId, { confirms: 0, cancels: 0 });
    byOrder.get(orderId)[kind] += 1;
  };

  for (const e of await db.collection('bookingstatusevents').find(
    { orderId: { $in: ids } }, { projection: { orderId: 1, status: 1, previousStatus: 1 } },
  ).toArray()) {
    if (e.status === 'Cancelled') bump(e.orderId, 'cancels');
    else if (e.previousStatus === 'Cancelled') bump(e.orderId, 'confirms');
  }

  for (const a of await db.collection('auditlogs').find(
    { action: { $in: ['Booking Cancelled', 'Booking Auto-Cancelled (No PO)'] } },
    { projection: { action: 1, remarks: 1 } },
  ).toArray()) {
    const hit = ids.find((id) => typeof a.remarks === 'string' && a.remarks.includes(id));
    if (hit) bump(hit, 'cancels');
  }

  const out = new Map();
  for (const [orderId, c] of byOrder) {
    // More than one cancellation, or a confirmation after one, means the line
    // held stock more than once.
    const cycles = 1 + Math.max(0, Math.min(c.cancels, Math.max(c.confirms, c.cancels > 1 ? c.cancels - 1 : 0)));
    if (cycles > 1) out.set(orderId, { ...c, cycles });
  }
  return out;
};

export const impliedMovements = (line) => {
  const bookedAt = line.orderTimestamp || line.createdAt || line.date || null;
  const settledAt = line.stockSettledAt || line.cancelledAt || line.poGeneratedAt || bookedAt;
  const qty = line.confirmedQty ?? 0;
  if (qty <= 0) return [];

  const out = [{ movementType: 'RESERVE', quantity: qty, effectiveDate: bookedAt }];
  if (line.stockState === 'consumed') {
    out.push({ movementType: 'RELEASE', quantity: -qty, effectiveDate: settledAt });
    out.push({ movementType: 'ISSUE', quantity: -qty, effectiveDate: settledAt });
  } else if (line.stockState === 'released') {
    out.push({ movementType: 'RELEASE', quantity: -qty, effectiveDate: settledAt });
  }
  return out;
};

/**
 * Work out what is missing. Pure read; used by the plan, the apply and the
 * verify, so all three agree by construction.
 */
export const buildPlan = async (db, { skuCode = null, orderId = null } = {}) => {
  const filter = { $or: [{ confirmedQty: { $gt: 0 } }, { stockState: { $ne: null } }] };
  if (skuCode) filter.skuCode = skuCode;
  if (orderId) filter.orderId = orderId;

  const lines = await db.collection('orders').find(filter)
    .sort({ orderTimestamp: 1, _id: 1 }).toArray();

  const existing = new Set();
  for await (const m of db.collection('stockmovements').find(
    {}, { projection: { referenceId: 1, skuCode: 1, movementType: 1 } },
  )) {
    existing.add(`${m.referenceId}::${m.skuCode}::${m.movementType}`);
  }

  const brandOf = new Map(
    (await db.collection('products').find({}, { projection: { skuCode: 1, brand: 1 } }).toArray())
      .map((p) => [p.skuCode, p.brand]),
  );

  // Lines whose history shows more than one hold. See cycleEvidence().
  const cycles = await cycleEvidence(db, lines.map((l) => l.orderId));

  const plan = [];
  const ambiguous = [];
  const compressed = [];
  for (const line of lines) {
    for (const m of impliedMovements(line)) {
      if (existing.has(`${line.orderId}::${line.skuCode}::${m.movementType}`)) continue;

      const brand = brandOf.get(line.skuCode) ?? line.brand ?? null;
      if (!brand) {
        ambiguous.push({ orderId: line.orderId, skuCode: line.skuCode, movementType: m.movementType, why: 'no brand resolvable' });
        continue;
      }
      if (!m.effectiveDate) {
        ambiguous.push({ orderId: line.orderId, skuCode: line.skuCode, movementType: m.movementType, why: 'no date to stamp the movement with' });
        continue;
      }
      if (new Date(m.effectiveDate) > new Date()) {
        ambiguous.push({ orderId: line.orderId, skuCode: line.skuCode, movementType: m.movementType, why: 'implied date is in the future' });
        continue;
      }
      plan.push({
        idempotencyKey: backfillKey(line.orderId, line.skuCode, m.movementType),
        orderId: line.orderId,
        skuCode: line.skuCode,
        brand,
        movementType: m.movementType,
        quantity: m.quantity,
        effectiveDate: new Date(m.effectiveDate),
        derivedFrom: { confirmedQty: line.confirmedQty, stockState: line.stockState ?? null, status: line.status },
        // > 1 means the net position is reconstructed, not every cycle.
        cycles: cycles.get(line.orderId)?.cycles ?? 1,
      });
    }
  }
  // Oldest first, so the reconstructed history reads in the real order.
  plan.sort((a, b) => a.effectiveDate - b.effectiveDate
    || String(a.orderId).localeCompare(String(b.orderId))
    || a.movementType.localeCompare(b.movementType));
  for (const p of plan) {
    if (p.cycles > 1 && !compressed.some((c) => c.orderId === p.orderId && c.skuCode === p.skuCode)) {
      compressed.push({ orderId: p.orderId, skuCode: p.skuCode, cycles: p.cycles });
    }
  }
  return { plan, ambiguous, compressed, linesExamined: lines.length };
};

/**
 * Refuse to apply while the outbox still has work.
 *
 * A pending row is a movement that happened and has not reached the ledger
 * yet. Backfilling around it would either duplicate it or leave a gap the
 * verify step then reports as a failure, so the right answer is to wait.
 */
export const outboxBlockers = async (db) => {
  try {
    return await db.collection('stockoutboxes').countDocuments({ state: { $in: ['pending', 'claimed'] } });
  } catch {
    // The collection does not exist yet — nothing is queued.
    return 0;
  }
};

/**
 * Post the planned movements.
 *
 * Goes through postBatch — the same path every other posting uses — so the
 * movements are validated, numbered and audited exactly like a live one, and
 * the idempotency key makes a second run a no-op.
 */
export const applyPlan = async (plan, { runId, limit = Infinity, onProgress = null } = {}) => {
  const { postBatch } = await import('../../modules/inventory/ledger.service.js');
  const posted = [];
  const failed = [];

  for (const [i, m] of plan.entries()) {
    if (i >= limit) break;
    try {
      const result = await postBatch({
        idempotencyKey: m.idempotencyKey,
        workflowType: BACKFILL_WORKFLOW,
        referenceType: 'booking',
        referenceId: m.orderId,
        effectiveDate: m.effectiveDate,
        note: `Backfilled by ${runId}: movement implied by order line but never recorded.`,
        lines: [{
          movementType: m.movementType,
          skuCode: m.skuCode,
          brand: m.brand,
          quantity: m.quantity,
          effectiveDate: m.effectiveDate,
          // Deliberately null: a reconstructed running balance would be
          // fiction wherever the sequence has a gap. The Activity Log already
          // renders a null pair as "no recorded balance".
          beforeQuantity: null,
          afterQuantity: null,
          reasonCode: 'RECONCILIATION',
        }],
      });
      posted.push({ ...m, batchId: result.batch.batchId, replayed: result.replayed });
    } catch (error) {
      failed.push({ ...m, error: error.message });
    }
    if (onProgress && i % 100 === 0) onProgress(i, plan.length);
  }
  return { posted, failed };
};

/**
 * Rebuild the balance projection for the SKUs the backfill touched.
 *
 * A full replay from the ledger, not an incremental fold: the projection is
 * now derived from a materially different history, and replaying is the
 * operation that is correct regardless of what it held before.
 *
 * It writes `stockbalances` only. Product quantities are untouched — which is
 * why the two can be sequenced independently.
 */
export const rebuildFor = async (skuCodes, { db = null, attempts = 3 } = {}) => {
  const { rebuildBalances } = await import('../../modules/inventory/balance.service.js');
  const skus = [...new Set(skuCodes)];
  const results = [];
  const unsettled = [];

  for (const skuCode of skus) {
    /**
     * A REBUILD IS A READ FOLLOWED BY A WRITE, AND BOOKINGS DO NOT STOP.
     *
     * rebuildBalances() sums the ledger for a SKU and writes the total. A
     * booking confirmed between the sum and the write posts a movement the
     * sum never saw, and the write then overwrites a balance that was briefly
     * correct with one that is short by that booking.
     *
     * Nothing customer-facing depends on it — availability is served from
     * `products` — but leaving a knowingly stale projection behind after a
     * repair is the exact habit that produced this work. So the movement
     * count is taken before and after, and a SKU that moved underneath the
     * rebuild is simply rebuilt again. Bounded, because a SKU being booked
     * continuously would otherwise spin: after `attempts` it is REPORTED, and
     * the next scheduled reconciliation picks it up.
     */
    let settled = false;
    for (let i = 0; i < attempts && !settled; i += 1) {
      const before = db ? await db.collection('stockmovements').countDocuments({ skuCode }) : null;
      const result = await rebuildBalances({ skuCode });
      const after = db ? await db.collection('stockmovements').countDocuments({ skuCode }) : null;
      settled = before === null || before === after;
      if (settled) results.push(result);
    }
    if (!settled) unsettled.push(skuCode);
  }
  return { rebuilt: skus.length - unsettled.length, unsettled, results };
};

/**
 * Undo a run: remove the movements and batches it created, then rebuild the
 * projection for the SKUs involved.
 *
 * Safe against later activity. It deletes only batches whose workflow is the
 * backfill's own and whose note names this run, so a genuine movement posted
 * afterwards — by a booking, a PO, anything — is untouched, and the rebuild
 * that follows reconstructs the projection from whatever legitimately remains.
 */
export const rollbackRun = async (db, runId) => {
  const batches = await db.collection('stockbatches').find({
    workflowType: BACKFILL_WORKFLOW,
    note: new RegExp(`^Backfilled by ${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`),
  }).toArray();

  if (batches.length === 0) return { batches: 0, movements: 0, skus: [] };

  const batchIds = batches.map((b) => b.batchId);
  const movements = await db.collection('stockmovements')
    .find({ batchId: { $in: batchIds } }, { projection: { skuCode: 1 } }).toArray();
  const skus = [...new Set(movements.map((m) => m.skuCode))];

  const delMovements = await db.collection('stockmovements').deleteMany({ batchId: { $in: batchIds } });
  const delBatches = await db.collection('stockbatches').deleteMany({ batchId: { $in: batchIds } });
  await rebuildFor(skus);

  return { batches: delBatches.deletedCount, movements: delMovements.deletedCount, skus };
};

