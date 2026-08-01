import StockCount, { COUNT_TRANSITIONS } from '../../models/StockCount.js';
import StockCountLine from '../../models/StockCountLine.js';
import StockAdjustment from '../../models/StockAdjustment.js';
import OversoldException from '../../models/OversoldException.js';
import StockBalance from '../../models/StockBalance.js';
import StockMovement from '../../models/StockMovement.js';
import Location from '../../models/Location.js';
import Order from '../../models/Order.js';
import { Product } from '../../models/Product.js';
import { nextSequence } from '../../models/Counter.js';
import { postBatch } from './ledger.service.js';
import { applyMovements, syncLegacyStock } from './balance.service.js';
import { emitStockUpdated } from '../../utils/stockEvents.js';
import { recomputeHealthForSkus } from './health.service.js';
import { resolveConfig } from './config.service.js';
import { recordAudit } from '../../utils/auditLog.js';
import { isDuplicateKeyError } from '../../utils/mongoSession.js';
import { emitEvent, EVENTS } from '../../utils/eventBus.js';

/**
 * Stock Count Service (IMS Module M7).
 *
 * Physical verification that NEVER writes an inventory balance. The only
 * arithmetic here is
 *
 *     difference = countedQuantity − expectedQuantity
 *
 * and the expected side is read from the balance projection, not derived. Every
 * approved variance becomes an immutable COUNT movement through the existing
 * LedgerService; balances and health then update from those movements through
 * the existing services. There is no second inventory mechanism.
 *
 *     count sheet ──► variance ──► approval ──► LedgerService.postBatch()
 *                                                      │
 *                                    ┌─────────────────┴─────────────────┐
 *                              applyMovements()              recomputeHealthForSkus()
 *                              (affected SKUs only)             (affected SKUs only)
 */

export class CountError extends Error {
  constructor(message, status = 400, code = 'COUNT_VALIDATION_FAILED') {
    super(message);
    this.name = 'CountError';
    this.status = status;
    this.code = code;
  }
}
const fail = (m, s = 400, c = 'COUNT_VALIDATION_FAILED') => { throw new CountError(m, s, c); };

/** Reject any transition the state machine does not allow. */
const assertTransition = (from, to) => {
  const allowed = COUNT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    fail(
      `A count in "${from}" cannot move to "${to}".` +
      (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' It is in a terminal state.'),
      409,
      'INVALID_TRANSITION',
    );
  }
};

const sameUser = (a, b) => a && b && String(a) === String(b);

// ─── Session creation ────────────────────────────────────────────────────────

/**
 * Create a session and freeze its expected quantities.
 *
 * The sheet is generated from `stockbalances` in one pass. Every line captures
 * the balance AS IT IS NOW and never refreshes it — that freeze is what makes a
 * variance meaningful.
 */
export const createCount = async ({
  scope = 'spot', brand = null, locationCode = null, category = null,
  skuCodes = null, includeZeroStock = false, notes = null, actor, req,
} = {}) => {
  if (!['full', 'cycle', 'spot'].includes(scope)) fail('Scope must be full, cycle or spot.');

  const location = locationCode
    ? await Location.findOne({ code: locationCode.toUpperCase() }).lean()
    : await Location.findOne({ isDefault: true }).lean();
  if (!location) fail('No stock location found for this count.', 400, 'UNKNOWN_LOCATION');
  if (!location.active) fail(`Location ${location.code} is inactive.`, 409, 'LOCATION_INACTIVE');

  // ── Which SKUs ──────────────────────────────────────────────────────────
  const balanceFilter = { location: location._id };
  if (brand) balanceFilter.brand = brand;

  if (scope === 'spot') {
    if (!Array.isArray(skuCodes) || skuCodes.length === 0) {
      fail('A spot count needs an explicit list of SKUs.');
    }
    if (skuCodes.length > 1000) fail('A spot count may not exceed 1000 SKUs.', 413, 'TOO_MANY_LINES');
    balanceFilter.skuCode = { $in: [...new Set(skuCodes.map((s) => String(s).trim()))] };
  } else if (category) {
    // Category lives on the product master, not the balance — resolved once,
    // not joined per row.
    const skus = await Product.distinct('skuCode', { category, ...(brand ? { brand } : {}) });
    if (skus.length === 0) fail(`No SKUs found in category "${category}".`);
    balanceFilter.skuCode = { $in: skus };
  }

  // A full count normally covers only stock that exists; counting 7,000 empty
  // rows to confirm they are still empty is not a use of anyone's morning.
  if (!includeZeroStock) balanceFilter.onHand = { $gt: 0 };

  const balances = await StockBalance.find(balanceFilter).lean();
  if (balances.length === 0) {
    fail('No stock matches this scope, so there is nothing to count.', 400, 'EMPTY_SCOPE');
  }

  const year = new Date().getFullYear();
  const seq = await nextSequence(`stockcount-${year}`);
  const countId = `CNT-${year}-${String(seq).padStart(6, '0')}`;
  const now = new Date();

  const count = await StockCount.create({
    countId,
    scope,
    brand: brand ?? null,
    location: location._id,
    locationCode: location.code,
    category: category ?? null,
    status: 'Draft',
    createdBy: actor._id,
    lineCount: balances.length,
    notes,
  });

  // Product metadata in one query, so the sheet is readable without an N+1.
  const products = await Product.find(
    { skuCode: { $in: balances.map((b) => b.skuCode) } },
    'skuCode brand description boxNo',
  ).lean();
  const byKey = new Map(products.map((p) => [`${p.skuCode}::${p.brand}`, p]));

  const lines = balances.map((b) => {
    const p = byKey.get(`${b.skuCode}::${b.brand}`);
    return {
      count: count._id,
      countId,
      skuCode: b.skuCode,
      brand: b.brand,
      product: b.product ?? p?._id ?? null,
      location: location._id,
      locationCode: location.code,
      description: p?.description ?? null,
      boxNo: p?.boxNo ?? null,
      // FROZEN. Never refreshed for the life of the session.
      expectedQuantity: b.onHand ?? 0,
      expectedAt: now,
      verificationStatus: 'Pending',
      openLock: true,
    };
  });

  try {
    await StockCountLine.insertMany(lines, { ordered: false });
  } catch (error) {
    // BR-45 — the partial unique index refused a SKU already inside another
    // open count. Two overlapping counts would both post the same variance.
    if (isDuplicateKeyError(error)) {
      const written = await StockCountLine.countDocuments({ countId });
      await StockCountLine.deleteMany({ countId });
      await StockCount.updateOne(
        { _id: count._id },
        { $set: { status: 'Cancelled', cancelReason: 'Overlapping open count' } },
      );
      fail(
        'One or more of these SKUs is already inside another open count. ' +
        `Close it first. (${written} of ${lines.length} lines were free.)`,
        409,
        'COUNT_IN_PROGRESS',
      );
    }
    throw error;
  }

  await recordAudit(actor, 'Stock Count Created',
    `Count ${countId} created at ${location.code}: ${lines.length} line(s), scope ${scope}.`,
    req, { meta: { countId, scope, brand, locationCode: location.code, lineCount: lines.length } });

  return { countId, lineCount: lines.length, status: 'Draft', locationCode: location.code };
};

// ─── Counting ────────────────────────────────────────────────────────────────

/** Move Draft → Counting. */
export const startCount = async ({ countId, actor, req }) => {
  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  assertTransition(count.status, 'Counting');

  count.status = 'Counting';
  count.startedAt = new Date();
  count.counter = actor._id;
  await count.save();

  await recordAudit(actor, 'Stock Count Started', `Counting began on ${countId}.`, req,
    { meta: { countId } });
  return count.toObject();
};

/**
 * Record counted quantities.
 *
 * The only calculation in the module. Expected comes from the frozen line;
 * nothing is recomputed and no balance is touched.
 */
export const recordCounts = async ({ countId, lines, actor, req }) => {
  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  // BR-46 — entries are only accepted while the session is open for counting.
  if (count.status !== 'Counting') {
    fail(`Counts can only be entered while the session is in "Counting" (it is "${count.status}").`,
      409, 'INVALID_STATE');
  }
  if (!Array.isArray(lines) || lines.length === 0) fail('At least one line is required.');
  if (lines.length > 5000) fail('A single submission may not exceed 5000 lines.', 413, 'TOO_MANY_LINES');

  const config = await resolveConfig({ brand: count.brand });
  const validCodes = new Set((config?.reasonCodes || []).filter((r) => r.active).map((r) => r.code));

  const skus = [...new Set(lines.map((l) => String(l.skuCode || '').trim()).filter(Boolean))];
  const existing = await StockCountLine.find({ countId, skuCode: { $in: skus } }).lean();
  const byKey = new Map(existing.map((l) => [l.skuCode, l]));

  const ops = [];
  const errors = [];
  const now = new Date();

  for (const [i, raw] of lines.entries()) {
    const where = `line ${i + 1}`;
    const skuCode = String(raw.skuCode || '').trim();
    const line = byKey.get(skuCode);
    if (!line) { errors.push(`${where}: ${skuCode || '(blank)'} is not part of this count.`); continue; }

    const counted = raw.countedQuantity;
    if (!Number.isInteger(counted) || counted < 0) {
      errors.push(`${where}: counted quantity must be a whole number of zero or more.`);
      continue;
    }

    const difference = counted - line.expectedQuantity;

    // BR-22 — a variance must be explained. A matching count needs no reason.
    const reasonCode = raw.reasonCode ? String(raw.reasonCode).trim().toUpperCase() : null;
    if (difference !== 0) {
      if (!reasonCode) {
        errors.push(`${where}: ${skuCode} differs by ${difference} and needs a reason code.`);
        continue;
      }
      if (validCodes.size > 0 && !validCodes.has(reasonCode)) {
        errors.push(`${where}: "${reasonCode}" is not an active reason code.`);
        continue;
      }
    }

    ops.push({
      updateOne: {
        filter: { _id: line._id, adjustmentPosted: false },
        update: {
          $set: {
            countedQuantity: counted,
            difference,
            reasonCode: difference === 0 ? null : reasonCode,
            note: raw.note ? String(raw.note) : null,
            verificationStatus: difference === 0 ? 'Matched' : 'Variance',
            adjustmentRequired: difference !== 0,
            countedBy: actor._id,
            countedAt: now,
          },
        },
      },
    });
  }

  if (errors.length) {
    fail(errors.slice(0, 20).join(' '), 400, 'LINE_VALIDATION_FAILED');
  }

  if (ops.length) await StockCountLine.bulkWrite(ops, { ordered: false });
  await refreshRollup(countId);

  return { countId, updated: ops.length };
};

/** Recompute the session's line roll-up from its lines. */
const refreshRollup = async (countId) => {
  const [agg] = await StockCountLine.aggregate([
    { $match: { countId } },
    {
      $group: {
        _id: null,
        lineCount: { $sum: 1 },
        countedLines: { $sum: { $cond: [{ $ne: ['$countedQuantity', null] }, 1, 0] } },
        varianceLines: { $sum: { $cond: [{ $eq: ['$verificationStatus', 'Variance'] }, 1, 0] } },
        netVariance: { $sum: { $ifNull: ['$difference', 0] } },
      },
    },
  ]);
  await StockCount.updateOne(
    { countId },
    { $set: {
      lineCount: agg?.lineCount ?? 0,
      countedLines: agg?.countedLines ?? 0,
      varianceLines: agg?.varianceLines ?? 0,
      netVariance: agg?.netVariance ?? 0,
    } },
  );
  return agg;
};

// ─── Submission ──────────────────────────────────────────────────────────────

/**
 * Submit for review.
 *
 * Detects stock that moved WHILE the count was open by comparing the live
 * balance against the frozen expectation. Flagged lines are surfaced for
 * explicit review — never silently absorbed, which is exactly what the previous
 * overwrite-based script did.
 */
export const submitCount = async ({ countId, allowUncounted = false, actor, req }) => {
  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  assertTransition(count.status, 'Submitted');

  const uncounted = await StockCountLine.countDocuments({ countId, countedQuantity: null });
  // BR-47 — every line accounted for, or explicitly skipped.
  if (uncounted > 0 && !allowUncounted) {
    fail(
      `${uncounted} line(s) have not been counted. Enter them, or resubmit with ` +
      'allowUncounted to mark them skipped.',
      400,
      'INCOMPLETE_COUNT',
    );
  }
  if (uncounted > 0) {
    await StockCountLine.updateMany(
      { countId, countedQuantity: null },
      { $set: { verificationStatus: 'Skipped', adjustmentRequired: false } },
    );
  }

  // BR-48 — concurrency detection against live balances.
  const lines = await StockCountLine.find({ countId, countedQuantity: { $ne: null } }).lean();
  const balances = await StockBalance.find({
    location: count.location,
    skuCode: { $in: lines.map((l) => l.skuCode) },
  }, 'skuCode brand onHand').lean();
  const liveByKey = new Map(balances.map((b) => [`${b.skuCode}::${b.brand}`, b.onHand ?? 0]));

  const moved = [];
  const ops = [];
  for (const line of lines) {
    const live = liveByKey.get(`${line.skuCode}::${line.brand}`) ?? 0;
    if (live !== line.expectedQuantity) {
      moved.push({ skuCode: line.skuCode, expected: line.expectedQuantity, now: live });
      ops.push({
        updateOne: {
          filter: { _id: line._id },
          update: { $set: { movedDuringCount: true, balanceAtSubmit: live } },
        },
      });
    }
  }
  if (ops.length) await StockCountLine.bulkWrite(ops, { ordered: false });

  const rollup = await refreshRollup(countId);
  count.status = 'Submitted';
  count.submittedAt = new Date();
  count.submittedBy = actor._id;
  await count.save();

  await recordAudit(actor, 'Stock Count Submitted',
    `Count ${countId} submitted: ${rollup?.varianceLines ?? 0} variance(s), ` +
    `net ${rollup?.netVariance ?? 0}. ${moved.length} line(s) moved during the count.`,
    req, { meta: { countId, varianceLines: rollup?.varianceLines, netVariance: rollup?.netVariance, movedDuringCount: moved.length } });

  emitEvent(EVENTS.COUNT_SUBMITTED, {
    countId,
    brand: count.brand ?? null,
    locationCode: count.locationCode ?? null,
    varianceLines: rollup?.varianceLines ?? 0,
    netVariance: rollup?.netVariance ?? 0,
    submittedBy: String(actor._id),
  });

  return {
    countId,
    status: 'Submitted',
    varianceLines: rollup?.varianceLines ?? 0,
    netVariance: rollup?.netVariance ?? 0,
    skipped: uncounted,
    movedDuringCount: moved,
  };
};

// ─── Approval ────────────────────────────────────────────────────────────────

/**
 * Approve or reject.
 *
 * BR-27 — the approver may not be the person who counted or submitted. This is
 * checked against the RECORD, not just the permission: Inventory Manager holds
 * both perform_count and approve_count, so a permission check alone would let
 * one person count and approve their own work.
 */
export const reviewCount = async ({ countId, decision, reason, actor, req }) => {
  if (!['approve', 'reject'].includes(decision)) fail('Decision must be approve or reject.');

  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  assertTransition(count.status, decision === 'approve' ? 'Approved' : 'Rejected');

  if (decision === 'approve') {
    if (sameUser(count.submittedBy, actor._id) || sameUser(count.counter, actor._id)) {
      fail(
        'You cannot approve a count you performed or submitted. ' +
        'Another authorised user must review it.',
        403,
        'SELF_APPROVAL_BLOCKED',
      );
    }
    count.status = 'Approved';
    count.approvedBy = actor._id;
  } else {
    if (!reason) fail('A rejection needs a reason.');
    count.status = 'Rejected';
    count.rejectionReason = String(reason);
  }
  count.reviewedAt = new Date();
  await count.save();

  await recordAudit(actor,
    decision === 'approve' ? 'Stock Count Approved' : 'Stock Count Rejected',
    `Count ${countId} ${decision === 'approve' ? 'approved' : `rejected: ${reason}`}.`,
    req, { meta: { countId, decision, reason: reason ?? null } });

  emitEvent(
    decision === 'approve' ? EVENTS.COUNT_APPROVED : EVENTS.COUNT_REJECTED,
    {
      countId,
      brand: count.brand ?? null,
      locationCode: count.locationCode ?? null,
      reason: reason ?? null,
      reviewedBy: String(actor._id),
    },
  );

  return count.toObject();
};

// ─── Posting ─────────────────────────────────────────────────────────────────

/**
 * Post approved variances to the ledger.
 *
 * DOUBLE-POSTING IS STRUCTURALLY IMPOSSIBLE, by two independent mechanisms:
 *
 *   1. The state machine — only an Approved count may post, and posting moves
 *      it to Posted, which is terminal.
 *   2. A DETERMINISTIC idempotency key (`count-<countId>-post`). Even if the
 *      status guard were somehow bypassed, LedgerService recognises the key and
 *      returns the original batch without writing a second movement.
 *
 * Posts the VARIANCE (BR-52), never an absolute overwrite — so the ledger
 * explains the change rather than merely recording a new number.
 */
export const postCount = async ({ countId, actor, req }) => {
  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  assertTransition(count.status, 'Posted');

  const variances = await StockCountLine.find({
    countId, adjustmentRequired: true, adjustmentPosted: false,
  }).lean();

  const now = new Date();

  // An approved count with no variance is a valid, useful outcome: it is
  // positive confirmation that the system was right.
  if (variances.length === 0) {
    count.status = 'Posted';
    count.postedAt = now;
    count.completedAt = now;
    count.postedBy = actor._id;
    count.postedMovementCount = 0;
    await count.save();
    await releaseLocks(countId);

    await recordAudit(actor, 'Stock Count Posted',
      `Count ${countId} posted with no variances — system quantities confirmed.`,
      req, { meta: { countId, movementCount: 0 } });

    return { countId, status: 'Posted', movementCount: 0, adjustmentId: null, oversold: [] };
  }

  // ── Ledger ────────────────────────────────────────────────────────────────
  const result = await postBatch({
    idempotencyKey: `count-${countId}-post`,
    workflowType: 'stock-count',
    referenceType: 'count',
    referenceId: countId,
    actor,
    note: `Physical count ${countId} at ${count.locationCode}`,
    lines: variances.map((l) => ({
      // COUNT is the registry's signed PHYSICAL type, labelled "Count
      // Variance" — exactly this operation. Direction lives in the sign, so
      // separate IN/OUT types would be redundant and would mean modifying the
      // ledger's closed type set.
      movementType: 'COUNT',
      skuCode: l.skuCode,
      brand: l.brand,
      locationCode: l.locationCode,
      quantity: l.difference,
      beforeQuantity: l.expectedQuantity,
      afterQuantity: l.countedQuantity,
      reasonCode: l.reasonCode,
      note: l.note,
    })),
  }, req);

  const txnByIndex = result.batch.transactionIds || [];

  // ── Projections — affected SKUs only ─────────────────────────────────────
  // Never a full rebuild. The existing incremental services are used exactly as
  // the booking flow uses them.
  const posted = await StockMovement.find({ batchId: result.batch.batchId }).lean();
  if (!result.replayed && posted.length) {
    await applyMovements(posted);
  }
  const affectedSkus = [...new Set(variances.map((l) => l.skuCode))];
  await recomputeHealthForSkus(affectedSkus, { brand: count.brand ?? undefined });
  await syncLegacyStock(affectedSkus);
  emitStockUpdated(req, affectedSkus, { source: 'count', countId });

  // ── Stamp the lines ──────────────────────────────────────────────────────
  const txnBySku = new Map(posted.map((m) => [`${m.skuCode}::${m.brand}`, m.transactionId]));
  await StockCountLine.bulkWrite(
    variances.map((l) => ({
      updateOne: {
        filter: { _id: l._id },
        update: { $set: {
          adjustmentPosted: true,
          ledgerTransactionId: txnBySku.get(`${l.skuCode}::${l.brand}`) ?? null,
          ledgerBatchId: result.batch.batchId,
        } },
      },
    })),
    { ordered: false },
  );

  // ── Adjustment record ────────────────────────────────────────────────────
  const year = now.getFullYear();
  const adjSeq = await nextSequence(`stockadjustment-${year}`);
  const adjustmentId = `ADJ-${year}-${String(adjSeq).padStart(6, '0')}`;

  const increases = variances.filter((l) => l.difference > 0).reduce((n, l) => n + l.difference, 0);
  const decreases = variances.filter((l) => l.difference < 0).reduce((n, l) => n + l.difference, 0);

  await StockAdjustment.create({
    adjustmentId,
    source: 'count',
    count: count._id,
    countId,
    brand: count.brand ?? null,
    location: count.location,
    locationCode: count.locationCode,
    status: 'posted',
    lineCount: variances.length,
    netQuantity: increases + decreases,
    increases,
    decreases,
    ledgerBatchId: result.batch.batchId,
    transactionIds: txnByIndex,
    lines: variances.map((l) => ({
      skuCode: l.skuCode,
      brand: l.brand,
      locationCode: l.locationCode,
      beforeQuantity: l.expectedQuantity,
      countedQuantity: l.countedQuantity,
      difference: l.difference,
      reasonCode: l.reasonCode,
      transactionId: txnBySku.get(`${l.skuCode}::${l.brand}`) ?? null,
    })),
    submittedBy: count.submittedBy,
    approvedBy: count.approvedBy,
    postedBy: actor._id,
    postedAt: now,
  });

  // ── Oversold detection ───────────────────────────────────────────────────
  const oversold = await detectOversold({ countId, skus: affectedSkus, location: count.location, actor });

  count.status = 'Posted';
  count.postedAt = now;
  count.completedAt = now;
  count.postedBy = actor._id;
  count.ledgerBatchId = result.batch.batchId;
  count.adjustmentId = adjustmentId;
  count.postedMovementCount = posted.length;
  await count.save();

  await releaseLocks(countId);

  await recordAudit(actor, 'Stock Adjustment Posted',
    `Count ${countId} posted as ${adjustmentId}: ${variances.length} adjustment(s), ` +
    `net ${increases + decreases}, ledger batch ${result.batch.batchId}.` +
    (oversold.length ? ` ${oversold.length} oversold exception(s) raised.` : ''),
    req, {
      meta: {
        countId, adjustmentId, ledgerBatchId: result.batch.batchId,
        lineCount: variances.length, increases, decreases,
        transactionIds: txnByIndex, oversoldCount: oversold.length,
        lines: variances.map((l) => ({
          skuCode: l.skuCode,
          beforeQuantity: l.expectedQuantity,
          countedQuantity: l.countedQuantity,
          difference: l.difference,
          reasonCode: l.reasonCode,
          transactionId: txnBySku.get(`${l.skuCode}::${l.brand}`) ?? null,
        })),
      },
    });

  emitEvent(EVENTS.COUNT_POSTED, {
    countId,
    adjustmentId,
    brand: count.brand ?? null,
    locationCode: count.locationCode,
    lineCount: variances.length,
    netQuantity: increases + decreases,
    skuCodes: affectedSkus,
    oversoldCount: oversold.length,
  });

  return {
    countId,
    status: 'Posted',
    adjustmentId,
    ledgerBatchId: result.batch.batchId,
    movementCount: posted.length,
    replayed: result.replayed,
    increases,
    decreases,
    oversold,
  };
};

/** Release the SKU locks so the counted SKUs can be counted again. */
const releaseLocks = (countId) =>
  StockCountLine.updateMany({ countId }, { $unset: { openLock: '' } });

/**
 * Raise an exception wherever a posted count left AVAILABLE negative.
 *
 * The count is not blocked — refusing to record a true count would be worse,
 * because the stock genuinely is not there. The shortfall is surfaced with the
 * bookings holding the reserved units, oldest confirmation first, so a person
 * can decide which to reduce or cancel.
 */
const detectOversold = async ({ countId, skus, location, actor }) => {
  const balances = await StockBalance.find({
    location, skuCode: { $in: skus },
    $expr: { $lt: [{ $subtract: ['$onHand', '$reserved'] }, 0] },
  }).lean();
  if (balances.length === 0) return [];

  const raised = [];
  for (const b of balances) {
    const shortfall = b.reserved - b.onHand;

    // Bookings still holding these units, oldest confirmation first.
    const bookings = await Order.find({
      skuCode: b.skuCode,
      brand: b.brand,
      stockState: 'reserved',
      status: { $nin: ['Cancelled'] },
    }, 'orderId company skuCode confirmedQty createdAt')
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    const exception = await OversoldException.create({
      skuCode: b.skuCode,
      brand: b.brand,
      location: b.location,
      locationCode: b.locationCode,
      onHand: b.onHand,
      reserved: b.reserved,
      shortfall,
      source: 'count',
      countId,
      affectedBookings: bookings.map((o) => ({
        orderId: o.orderId,
        company: o.company,
        skuCode: o.skuCode,
        confirmedQty: o.confirmedQty,
        confirmedAt: o.createdAt,
      })),
    });

    raised.push({
      skuCode: b.skuCode, brand: b.brand, onHand: b.onHand,
      reserved: b.reserved, shortfall, exceptionId: String(exception._id),
      affectedBookings: bookings.length,
    });
  }

  await recordAudit(actor, 'Oversold Exception Raised',
    `Count ${countId} left ${raised.length} SKU(s) with stock promised but absent.`,
    null, { meta: { countId, exceptions: raised } });

  // One event per exception — an oversold SKU is an individually actionable
  // condition, and collapsing them into one alert would hide which SKU is
  // affected behind a count reference.
  for (const r of raised) {
    emitEvent(EVENTS.OVERSOLD_RAISED, { countId, ...r });
  }

  return raised;
};

// ─── Cancellation ────────────────────────────────────────────────────────────

export const cancelCount = async ({ countId, reason, actor, req }) => {
  const count = await StockCount.findOne({ countId });
  if (!count) fail(`Count ${countId} not found.`, 404, 'NOT_FOUND');
  assertTransition(count.status, 'Cancelled');
  if (!reason) fail('A cancellation needs a reason.');

  count.status = 'Cancelled';
  count.cancelReason = String(reason);
  count.completedAt = new Date();
  await count.save();
  await releaseLocks(countId);

  await recordAudit(actor, 'Stock Count Cancelled', `Count ${countId} cancelled: ${reason}.`,
    req, { meta: { countId, reason } });

  return count.toObject();
};

/** Resolve an oversold exception once the shortfall has been settled. */
export const resolveOversold = async ({ exceptionId, resolution, note, actor, req }) => {
  const allowed = ['bookings-reduced', 'bookings-cancelled', 'stock-found', 'recounted', 'other'];
  if (!allowed.includes(resolution)) {
    fail(`Resolution must be one of: ${allowed.join(', ')}.`);
  }
  const exception = await OversoldException.findById(exceptionId);
  if (!exception) fail('Exception not found.', 404, 'NOT_FOUND');
  if (exception.status === 'Resolved') fail('This exception is already resolved.', 409, 'ALREADY_RESOLVED');

  exception.status = 'Resolved';
  exception.resolution = resolution;
  exception.resolutionNote = note ?? null;
  exception.resolvedBy = actor._id;
  exception.resolvedAt = new Date();
  await exception.save();

  await recordAudit(actor, 'Oversold Exception Resolved',
    `Oversold on ${exception.skuCode} resolved as "${resolution}".`,
    req, { meta: { skuCode: exception.skuCode, resolution, note } });

  return exception.toObject();
};

export default {
  createCount, startCount, recordCounts, submitCount,
  reviewCount, postCount, cancelCount, resolveOversold, CountError,
};
