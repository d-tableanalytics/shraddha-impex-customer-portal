import mongoose from 'mongoose';
import StockMovement, {
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_NAMES,
  MOVEMENT_CLASS,
  DERIVED_TYPES,
} from '../../models/StockMovement.js';
import StockBatch from '../../models/StockBatch.js';
import Location from '../../models/Location.js';
import { Product } from '../../models/Product.js';
import { nextSequence, nextSequenceBlock } from '../../models/Counter.js';
import { recordAudit } from '../../utils/auditLog.js';
import { isTransactionUnsupported, isDuplicateKeyError } from '../../utils/mongoSession.js';

/**
 * Ledger Service (IMS Module M2).
 *
 * The only way movements enter the system. Responsibilities, and nothing beyond
 * them:
 *
 *   • validate the movement payload
 *   • enforce idempotency at the batch boundary
 *   • allocate transaction ids
 *   • append the batch and its movements atomically
 *   • write the audit entry
 *   • return the posting result
 *
 * It does NOT compute balances, availability, health or targets. Those are
 * Module M3/M4. `beforeQuantity`/`afterQuantity` are supplied by the caller from
 * whatever balance source it holds; this service only checks that the pair is
 * internally consistent.
 *
 * DUAL-WRITE POSTURE: nothing in the existing ERP calls this yet. The booking,
 * sales and settlement flows continue to mutate stock exactly as before. Module
 * M3 translates those nine call sites onto this service, at which point the
 * ledger begins recording alongside the legacy fields. Until then this is
 * additive infrastructure and cannot affect any existing flow.
 */

// ─── Errors ──────────────────────────────────────────────────────────────────
/** Carries an HTTP status so a route can map it without re-deriving intent. */
export class LedgerError extends Error {
  constructor(message, status = 400, code = 'LEDGER_VALIDATION_FAILED', details = null) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (message, status = 400, code = 'LEDGER_VALIDATION_FAILED', details = null) => {
  throw new LedgerError(message, status, code, details);
};

/**
 * Placeholder written to `reversedBy` while a reversal is being posted, so the
 * claim is visible to a concurrent caller before the contra-entry exists. A
 * fixed sentinel id rather than a boolean, because the field is typed as an
 * ObjectId reference; it is always replaced with the real id, or cleared if the
 * posting fails.
 */
const PENDING_REVERSAL = new mongoose.Types.ObjectId('000000000000000000000000');

// ─── Validation ──────────────────────────────────────────────────────────────

/** Whole number, not NaN, not Infinity. Fractional stock is never valid. */
const isWholeNumber = (v) => typeof v === 'number' && Number.isInteger(v);

/**
 * Check one line against the movement-type registry.
 * Returns a normalised line; throws LedgerError on the first problem so the
 * caller gets the offending line index rather than a generic failure.
 */
const validateLine = (line, index, { allowDerivedTypes = false } = {}) => {
  const where = `line ${index + 1}`;

  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    fail(`${where}: each line must be an object.`);
  }

  const movementType = String(line.movementType || '').trim().toUpperCase();
  if (!MOVEMENT_TYPE_NAMES.includes(movementType)) {
    fail(
      `${where}: unknown movement type "${line.movementType}". ` +
      `Valid types: ${MOVEMENT_TYPE_NAMES.join(', ')}.`,
      400,
      'INVALID_MOVEMENT_TYPE',
    );
  }

  // REVERSAL is produced by reverseMovement(), never by a direct post — its
  // class and sign are inherited from the movement being reversed.
  if (!allowDerivedTypes && DERIVED_TYPES.includes(movementType)) {
    fail(
      `${where}: ${movementType} movements are created by reversing an existing ` +
      'movement, not by posting directly.',
      400,
      'INVALID_MOVEMENT_TYPE',
    );
  }

  const spec = MOVEMENT_TYPES[movementType];

  const quantity = line.quantity;
  if (!isWholeNumber(quantity)) {
    fail(`${where}: quantity must be a whole number.`, 400, 'INVALID_QUANTITY');
  }
  if (quantity === 0) {
    fail(`${where}: quantity may not be zero.`, 400, 'INVALID_QUANTITY');
  }
  if (spec.sign === 'positive' && quantity < 0) {
    fail(`${where}: ${movementType} requires a positive quantity.`, 400, 'INVALID_QUANTITY');
  }
  if (spec.sign === 'negative' && quantity > 0) {
    fail(`${where}: ${movementType} requires a negative quantity.`, 400, 'INVALID_QUANTITY');
  }

  const skuCode = String(line.skuCode || '').trim();
  if (!skuCode) fail(`${where}: skuCode is required.`);

  // Self-verification: when the caller supplies both figures they must agree
  // with the quantity. This is the check that makes a corrupted chain
  // detectable at the exact row rather than only in aggregate.
  const before = line.beforeQuantity;
  const after = line.afterQuantity;
  const hasBefore = before !== undefined && before !== null;
  const hasAfter = after !== undefined && after !== null;

  if (hasBefore && !isWholeNumber(before)) fail(`${where}: beforeQuantity must be a whole number.`);
  if (hasAfter && !isWholeNumber(after)) fail(`${where}: afterQuantity must be a whole number.`);
  if (hasBefore && hasAfter && after !== before + quantity) {
    fail(
      `${where}: afterQuantity (${after}) must equal beforeQuantity (${before}) ` +
      `plus quantity (${quantity}).`,
      400,
      'INCONSISTENT_BALANCE',
    );
  }

  // The class is DERIVED from the type, never taken from the caller — otherwise
  // a RECEIPT could be posted as an ALLOCATION and would project into the wrong
  // balance in M3, which is the one mistake the class exists to prevent.
  // REVERSAL is the sole exception: it has no class of its own and inherits the
  // one belonging to the movement it reverses.
  let movementClass = spec.class;
  if (movementType === 'REVERSAL') {
    movementClass = line.movementClass;
    if (!Object.values(MOVEMENT_CLASS).includes(movementClass)) {
      fail(`${where}: a reversal must inherit a valid movement class.`, 400, 'INVALID_MOVEMENT_CLASS');
    }
  }

  return {
    movementType,
    movementClass,
    quantity,
    skuCode,
    beforeQuantity: hasBefore ? before : null,
    afterQuantity: hasAfter ? after : null,
    locationCode: line.locationCode ? String(line.locationCode).trim().toUpperCase() : null,
    reasonCode: line.reasonCode ? String(line.reasonCode).trim().toUpperCase() : null,
    note: line.note ? String(line.note) : null,
    // Cost may be fractional, unlike quantity — but NaN and Infinity are not
    // numbers anyone meant to record.
    unitCost: Number.isFinite(line.unitCost) ? line.unitCost : null,
    currency: line.currency ? String(line.currency) : null,
    meta: line.meta ?? null,
    effectiveDate: line.effectiveDate ? new Date(line.effectiveDate) : null,
  };
};

// ─── Reference data resolution ───────────────────────────────────────────────

/**
 * Resolve every SKU and location referenced by the batch in ONE query each,
 * rather than per line. A 500-line posting therefore costs two lookups, not
 * a thousand.
 */
const resolveReferences = async (lines, session) => {
  const opts = session ? { session } : {};

  const skus = [...new Set(lines.map((l) => l.skuCode))];
  const products = await Product.find({ skuCode: { $in: skus } }, 'skuCode brand', opts).lean();

  // A SKU may legitimately exist under more than one brand, so key by SKU and
  // keep the matches; the caller must disambiguate when that happens.
  const bySku = new Map();
  for (const p of products) {
    if (!bySku.has(p.skuCode)) bySku.set(p.skuCode, []);
    bySku.get(p.skuCode).push(p);
  }

  const codes = [...new Set(lines.map((l) => l.locationCode).filter(Boolean))];
  const locationQuery = codes.length ? { $or: [{ code: { $in: codes } }, { isDefault: true }] } : { isDefault: true };
  const locations = await Location.find(locationQuery, 'code name active isDefault', opts).lean();

  const byCode = new Map(locations.map((l) => [l.code, l]));
  const defaultLocation = locations.find((l) => l.isDefault) || null;

  return { bySku, byCode, defaultLocation };
};

// ─── Posting ─────────────────────────────────────────────────────────────────

/** Shape a batch document for the API / caller. */
const shapeBatch = (batch, movements = null) => ({
  batchId: batch.batchId,
  idempotencyKey: batch.idempotencyKey,
  workflowType: batch.workflowType,
  status: batch.status,
  lineCount: batch.lineCount,
  totalQuantity: batch.totalQuantity,
  transactionIds: batch.transactionIds,
  referenceType: batch.referenceType,
  referenceId: batch.referenceId,
  postedAt: batch.postedAt,
  createdAt: batch.createdAt,
  ...(movements ? { movements } : {}),
});

/**
 * Post a batch of movements.
 *
 * @param {object}   input
 * @param {string}   input.idempotencyKey  Caller-supplied. Required — a replay
 *                                         with the same key returns the original
 *                                         batch and writes nothing.
 * @param {string}   input.workflowType    What produced this posting.
 * @param {Array}    input.lines           One entry per movement.
 * @param {object}  [input.actor]          User document. Omit for system posts.
 * @param {string}  [input.referenceType]  Source document type.
 * @param {string}  [input.referenceId]    Source document id.
 * @param {Date}    [input.effectiveDate]  Batch-level default for its lines.
 * @param {object}  [req]                  Express request, for the audit entry.
 *
 * @returns {{ batch: object, replayed: boolean }}
 */
export const postBatch = async (input, req = null) => {
  const {
    idempotencyKey,
    workflowType,
    lines,
    actor = null,
    referenceType = null,
    referenceId = null,
    effectiveDate = null,
    note = null,
    allowDerivedTypes = false,
  } = input || {};

  // ── Shape validation ──────────────────────────────────────────────────────
  const key = String(idempotencyKey || '').trim();
  if (!key) {
    fail('An idempotency key is required for every stock posting.', 400, 'IDEMPOTENCY_KEY_MISSING');
  }
  if (!workflowType || typeof workflowType !== 'string') {
    fail('workflowType is required.');
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    fail('At least one movement line is required.');
  }
  if (lines.length > 5000) {
    fail('A single batch may not exceed 5000 lines.', 413, 'BATCH_TOO_LARGE');
  }

  // ── Replay check, before any work ─────────────────────────────────────────
  const existing = await StockBatch.findOne({ idempotencyKey: key }).lean();
  if (existing) {
    return { batch: shapeBatch(existing), replayed: true };
  }

  const validated = lines.map((l, i) => validateLine(l, i, { allowDerivedTypes }));

  // ── Effective dates ───────────────────────────────────────────────────────
  const now = new Date();
  const batchEffective = effectiveDate ? new Date(effectiveDate) : now;
  if (Number.isNaN(batchEffective.getTime())) fail('effectiveDate is not a valid date.');
  // Future-dating would make the current balance disagree with the ledger sum.
  if (batchEffective.getTime() > now.getTime() + 60_000) {
    fail('effectiveDate cannot be in the future.', 400, 'INVALID_EFFECTIVE_DATE');
  }

  for (const line of validated) {
    const eff = line.effectiveDate || batchEffective;
    if (Number.isNaN(eff.getTime())) fail('A line carries an invalid effectiveDate.');
    if (eff.getTime() > now.getTime() + 60_000) {
      fail('A line effectiveDate cannot be in the future.', 400, 'INVALID_EFFECTIVE_DATE');
    }
    line.effectiveDate = eff;
    line.backdated = eff.getTime() < now.getTime() - 60_000;
  }

  // ── Resolve SKUs and locations ────────────────────────────────────────────
  const { bySku, byCode, defaultLocation } = await resolveReferences(validated, null);

  for (const [i, line] of validated.entries()) {
    const where = `line ${i + 1}`;
    const matches = bySku.get(line.skuCode);
    if (!matches || matches.length === 0) {
      fail(`${where}: SKU ${line.skuCode} does not exist.`, 400, 'UNKNOWN_SKU');
    }
    if (matches.length > 1 && !line.brand) {
      fail(
        `${where}: SKU ${line.skuCode} exists under more than one brand ` +
        `(${matches.map((m) => m.brand).join(', ')}) — specify which.`,
        400,
        'AMBIGUOUS_SKU',
      );
    }
    const product = line.brand
      ? matches.find((m) => m.brand === line.brand)
      : matches[0];
    if (!product) {
      fail(`${where}: SKU ${line.skuCode} does not exist under brand ${line.brand}.`, 400, 'UNKNOWN_SKU');
    }
    line.product = product._id;
    line.brand = product.brand;

    const location = line.locationCode ? byCode.get(line.locationCode) : defaultLocation;
    if (!location) {
      fail(
        line.locationCode
          ? `${where}: location ${line.locationCode} does not exist.`
          : `${where}: no default stock location is configured.`,
        400,
        'UNKNOWN_LOCATION',
      );
    }
    if (!location.active) {
      fail(`${where}: location ${location.code} is inactive.`, 409, 'LOCATION_INACTIVE');
    }
    line.location = location._id;
    line.locationCode = location.code;
  }

  // ── Allocate identifiers ──────────────────────────────────────────────────
  // One increment for the whole block rather than one per line.
  const year = now.getFullYear();
  const [batchSeq] = await nextSequenceBlock(`stock-batch-${year}`, 1);
  const txnSeqs = await nextSequenceBlock(`stock-txn-${year}`, validated.length);

  const batchId = `BAT-${year}-${String(batchSeq).padStart(6, '0')}`;
  const totalQuantity = validated.reduce((sum, l) => sum + l.quantity, 0);
  const transactionIds = txnSeqs.map((s) => `TXN-${year}-${String(s).padStart(6, '0')}`);

  // ── Write ─────────────────────────────────────────────────────────────────
  const runPost = async (session) => {
    const opts = session ? { session } : {};

    // The batch goes in FIRST, pending. Its unique idempotencyKey is the
    // concurrency control: a simultaneous request with the same key loses this
    // insert and is handled as a replay.
    const [batch] = await StockBatch.create([{
      batchId,
      idempotencyKey: key,
      workflowType,
      status: 'pending',
      lineCount: validated.length,
      totalQuantity,
      transactionIds,
      user: actor?._id || null,
      actorType: actor ? 'user' : 'system',
      referenceType,
      referenceId,
      note,
    }], opts);

    const docs = validated.map((line, i) => ({
      transactionId: transactionIds[i],
      batch: batch._id,
      batchId,
      skuCode: line.skuCode,
      product: line.product,
      brand: line.brand,
      location: line.location,
      locationCode: line.locationCode,
      movementClass: line.movementClass,
      movementType: line.movementType,
      quantity: line.quantity,
      beforeQuantity: line.beforeQuantity,
      afterQuantity: line.afterQuantity,
      effectiveDate: line.effectiveDate,
      postedAt: now,
      backdated: line.backdated,
      reasonCode: line.reasonCode,
      note: line.note,
      user: actor?._id || null,
      actorType: actor ? 'user' : 'system',
      referenceType,
      referenceId,
      reversalOf: line.reversalOf || null,
      unitCost: line.unitCost,
      currency: line.currency,
      meta: line.meta,
    }));

    await StockMovement.insertMany(docs, opts);

    // Promote only once the movements are safely in. A crash before this point
    // leaves a `pending` batch — visibly incomplete rather than silently
    // half-applied.
    await StockBatch.updateOne(
      { _id: batch._id },
      { $set: { status: 'posted', postedAt: now } },
      opts,
    );

    return { ...batch.toObject(), status: 'posted', postedAt: now };
  };

  let batchDoc;
  const session = await mongoose.startSession();
  try {
    try {
      session.startTransaction();
      batchDoc = await runPost(session);
      await session.commitTransaction();
    } catch (txErr) {
      await session.abortTransaction().catch(() => {});
      if (isDuplicateKeyError(txErr)) {
        // Lost the idempotency race — the winner's batch is authoritative.
        const winner = await StockBatch.findOne({ idempotencyKey: key }).lean();
        if (winner) return { batch: shapeBatch(winner), replayed: true };
        throw txErr;
      }
      if (!isTransactionUnsupported(txErr)) throw txErr;

      // Standalone MongoDB. Nothing was committed, so re-running without a
      // session is safe. The batch status is what makes a partial failure here
      // identifiable, which is why it exists.
      console.warn('[LedgerService] Transactions unsupported — posting without one.');
      try {
        batchDoc = await runPost(null);
      } catch (plainErr) {
        if (isDuplicateKeyError(plainErr)) {
          const winner = await StockBatch.findOne({ idempotencyKey: key }).lean();
          if (winner) return { batch: shapeBatch(winner), replayed: true };
        }
        // Mark the batch failed so an incomplete posting explains itself.
        await StockBatch.updateOne(
          { idempotencyKey: key, status: 'pending' },
          { $set: { status: 'failed', failureReason: plainErr.message } },
        ).catch(() => {});
        throw plainErr;
      }
    }
  } finally {
    session.endSession();
  }

  await recordAudit(
    actor,
    'Stock Movements Posted',
    `Batch ${batchId}: ${validated.length} movement(s) posted by ${workflowType}.`,
    req,
    {
      meta: {
        batchId,
        workflowType,
        lineCount: validated.length,
        totalQuantity,
        referenceType,
        referenceId,
        transactionIds,
      },
    },
  );

  return { batch: shapeBatch(batchDoc), replayed: false };
};

/**
 * Reverse a previously posted movement with a contra-entry.
 *
 * The ledger is append-only, so a correction is a new movement rather than an
 * edit. The reversal inherits the original's class, SKU, location and brand,
 * and carries the opposite quantity.
 */
export const reverseMovement = async ({ transactionId, idempotencyKey, reasonCode, note, actor }, req = null) => {
  const original = await StockMovement.findOne({ transactionId }).lean();
  if (!original) {
    fail(`Movement ${transactionId} not found.`, 404, 'NOT_FOUND');
  }
  if (original.movementType === 'REVERSAL') {
    fail('A reversal cannot itself be reversed.', 409, 'ALREADY_REVERSAL');
  }
  if (original.reversedBy) {
    fail(`Movement ${transactionId} has already been reversed.`, 409, 'ALREADY_REVERSED');
  }

  // Claim the original BEFORE posting the contra-entry.
  //
  // The stamp cannot share postBatch's transaction without leaking session
  // handling across the API, so the ordering is what makes this safe instead:
  // the guarded update is atomic, so exactly one caller can win the claim. A
  // crash after the claim leaves a movement marked reversed with no reversal —
  // detectable and repairable — whereas claiming afterwards would allow two
  // concurrent callers to both post a reversal, which is not.
  const claimed = await StockMovement.updateOne(
    { _id: original._id, reversedBy: null },
    { $set: { reversedBy: PENDING_REVERSAL } },
    { allowLedgerLink: true },
  );
  if (claimed.modifiedCount !== 1) {
    fail(`Movement ${transactionId} has already been reversed.`, 409, 'ALREADY_REVERSED');
  }

  let result;
  try {
    result = await postBatch({
    idempotencyKey,
    workflowType: 'reversal',
    referenceType: 'system',
    referenceId: original.transactionId,
    actor,
    note,
    allowDerivedTypes: true,
    lines: [{
      movementType: 'REVERSAL',
      movementClass: original.movementClass,
      skuCode: original.skuCode,
      brand: original.brand,
      locationCode: original.locationCode,
      quantity: -original.quantity,
      reasonCode: reasonCode || 'REVERSAL',
      note: note || `Reversal of ${original.transactionId}`,
      reversalOf: original._id,
      meta: { reversalOf: original.transactionId },
    }],
    }, req);
  } catch (err) {
    // Release the claim so a corrected retry is possible. Without this a failed
    // reversal would permanently block the movement from ever being reversed.
    await StockMovement.updateOne(
      { _id: original._id, reversedBy: PENDING_REVERSAL },
      { $set: { reversedBy: null } },
      { allowLedgerLink: true },
    ).catch(() => {});
    throw err;
  }

  // Replace the placeholder with the real reversal id. This is the one
  // permitted write to an existing movement — a field that goes from null to
  // set exactly once — and it is gated behind an explicit option so a generic
  // update cannot reach it.
  const reversal = await StockMovement.findOne({
    transactionId: result.batch.transactionIds[0],
  }).lean();
  await StockMovement.updateOne(
    { _id: original._id },
    { $set: { reversedBy: reversal._id } },
    { allowLedgerLink: true },
  );

  return result;
};

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Batch lookup by batchId or idempotency key. */
export const findBatch = async (identifier) => {
  const batch = await StockBatch.findOne({
    $or: [{ batchId: identifier }, { idempotencyKey: identifier }],
  }).populate('user', 'user email').lean();
  if (!batch) return null;

  const movements = await StockMovement.find({ batchId: batch.batchId })
    .sort({ transactionId: 1 })
    .lean();

  return { ...shapeBatch(batch), user: batch.user || null, movements };
};

export default { postBatch, reverseMovement, findBatch, LedgerError };
