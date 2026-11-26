import mongoose from 'mongoose';
/**
 * Phase 4 reconciliation — the decisions, separated from the command line.
 *
 * Kept apart from reconcile-stock.js so the classification and the correction
 * can be tested against an in-memory database without going through argv, and
 * so the dry run and the apply are provably the same logic rather than two
 * implementations that are supposed to agree.
 *
 * NEITHER SIDE IS ASSUMED CORRECT
 * -------------------------------
 * The 14305M-19 investigation found the legacy fields and the ledger wrong in
 * opposite directions at different moments. So four sources are read and
 * AGREEMENT, not provenance, is the evidence:
 *
 *   LEGACY      products.{totalAvailableQuantity,bookedQuantity,availableForSale}
 *   LEDGER      the sum of stockmovements
 *   PROJECTION  stockbalances (a fold of the ledger — inherits its gaps)
 *   REGISTER    orders — what a customer was actually promised. The only
 *               source no stock bug can rewrite, and therefore the one
 *               `bookedQuantity` is measured against.
 *
 * A customer commitment is never a figure to be corrected. Where commitments
 * exceed physical stock the SKU is reported as genuinely oversold: availability
 * shows zero, an OversoldException is raised, and a person decides. No booking
 * is ever reduced, cancelled, reallocated or fulfilled here.
 */

export const CLASS = {
  CLEAN: 'clean',
  LEDGER_INCOMPLETE: 'ledger-incomplete',
  BOOKED_CORRUPTED: 'booked-corrupted',
  PHANTOM_STOCK: 'phantom-stock',
  NEGATIVE_FIELD: 'negative-field',
  GENUINELY_OVERSOLD: 'genuinely-oversold',
  PHYSICAL_AMBIGUOUS: 'physical-ambiguous',
  MALFORMED: 'malformed',
};

export const DESCRIPTION = {
  [CLASS.CLEAN]: 'All sources agree. Nothing to do.',
  [CLASS.LEDGER_INCOMPLETE]: 'Legacy correct, ledger missing movements. Phase 3 fixes this; no product write.',
  [CLASS.BOOKED_CORRUPTED]: 'bookedQuantity disagrees with the commitment register. Restore from the register.',
  [CLASS.PHANTOM_STOCK]: 'availableForSale exceeds physical stock. Customer-visible reduction.',
  [CLASS.NEGATIVE_FIELD]: 'A stock field is negative. Correctable, but inspect each one.',
  [CLASS.GENUINELY_OVERSOLD]: 'Commitments exceed stock. NOT auto-correctable — a person decides.',
  [CLASS.PHYSICAL_AMBIGUOUS]: 'Legacy and ledger disagree on physical stock. Needs a client count.',
  [CLASS.MALFORMED]: 'Missing skuCode or brand. Quarantined, never touched.',
};

/** The classifications a correction may be applied to without a human decision. */
export const AUTO_FIXABLE = new Set([
  CLASS.BOOKED_CORRUPTED, CLASS.PHANTOM_STOCK, CLASS.NEGATIVE_FIELD,
]);

/**
 * Read every source once and classify every product.
 *
 * @param {object} db                     a connected driver Db
 * @param {object} [opts]
 * @param {Map<string,number>} [opts.verifiedCounts]  SKU -> counted physical stock.
 *        A verified count OUTRANKS both the legacy figure and the ledger: it is
 *        the only one a person actually looked at. It is what turns a
 *        physical-ambiguous SKU into a correctable one.
 */
export const classifyAll = async (db, { verifiedCounts = new Map(), skuCode = null, brand = null } = {}) => {
  const productFilter = {};
  if (skuCode) productFilter.skuCode = skuCode;
  if (brand) productFilter.brand = brand;

  const products = await db.collection('products').find(productFilter).project({
    skuCode: 1, brand: 1, totalAvailableQuantity: 1, bookedQuantity: 1,
    availableForSale: 1, inTransitQty: 1, updatedAt: 1,
  }).toArray();

  const ledger = new Map((await db.collection('stockmovements').aggregate([
    { $group: {
      _id: '$skuCode',
      onHand: { $sum: { $cond: [{ $eq: ['$movementClass', 'PHYSICAL'] }, '$quantity', 0] } },
      reserved: { $sum: { $cond: [{ $eq: ['$movementClass', 'ALLOCATION'] }, '$quantity', 0] } },
      movements: { $sum: 1 },
    } },
  ]).toArray()).map((r) => [r._id, r]));

  const projection = new Map((await db.collection('stockbalances').aggregate([
    { $group: { _id: '$skuCode', onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
  ]).toArray()).map((r) => [r._id, r]));

  // THE COMMITMENT REGISTER. A line still holding stock is one that is neither
  // cancelled nor settled; `stockState: null` covers rows written before that
  // field existed, which settleBooking also treats as reserved.
  const register = new Map((await db.collection('orders').aggregate([
    { $match: { status: { $ne: 'Cancelled' }, stockState: { $in: ['reserved', null] } } },
    { $group: {
      _id: '$skuCode',
      committed: { $sum: { $ifNull: ['$confirmedQty', 0] } },
      lines: { $push: { orderId: '$orderId', qty: { $ifNull: ['$confirmedQty', 0] }, company: '$company' } },
    } },
  ]).toArray()).map((r) => [r._id, r]));

  const indents = new Map();
  for (const r of await db.collection('reservations').find(
    { status: { $in: ['Pending', 'Partially Confirmed'] }, indentNumber: { $ne: null } },
    { projection: { indentNumber: 1, skuCode: 1, quantity: 1, status: 1 } },
  ).toArray()) {
    if (!indents.has(r.skuCode)) indents.set(r.skuCode, []);
    indents.get(r.skuCode).push(r);
  }

  const results = [];
  for (const p of products) {
    const sku = p.skuCode;
    if (!sku || !p.brand) {
      results.push({
        sku: sku ?? null, brand: p.brand ?? null, classification: CLASS.MALFORMED,
        before: null, proposed: null, deltas: null,
        ledger: { onHand: 0, reserved: 0, movements: 0 },
        projection: { onHand: 0, reserved: 0 },
        register: { committed: 0, lines: [] },
        // Same shape as every other row, so no caller has to special-case a
        // quarantined document.
        openIndents: [], indentsUnblocked: [],
        verifiedCount: null, productId: p._id, updatedAt: p.updatedAt ?? null,
      });
      continue;
    }

    const before = {
      total: p.totalAvailableQuantity ?? 0,
      booked: p.bookedQuantity ?? 0,
      afs: p.availableForSale ?? 0,
    };
    const led = ledger.get(sku) ?? { onHand: 0, reserved: 0, movements: 0 };
    const proj = projection.get(sku) ?? { onHand: 0, reserved: 0 };
    const reg = register.get(sku) ?? { committed: 0, lines: [] };
    const verified = verifiedCounts.has(sku) ? verifiedCounts.get(sku) : null;

    // PHYSICAL. A verified count wins outright; otherwise the two sources must
    // agree, and if they do not nothing here can settle it.
    const physical = verified !== null ? verified
      : (before.total === led.onHand ? before.total : null);

    const committed = reg.committed;
    const proposed = physical === null ? null : {
      total: physical,
      booked: committed,
      afs: Math.max(0, physical - committed),
      oversoldBy: Math.max(0, committed - physical),
    };

    const negative = before.total < 0 || before.booked < 0 || before.afs < 0;
    const phantom = before.afs > before.total;
    const invariantOk = before.afs + before.booked === before.total;

    let classification;
    if (negative) classification = CLASS.NEGATIVE_FIELD;
    else if (phantom) classification = CLASS.PHANTOM_STOCK;
    else if (physical === null) classification = CLASS.PHYSICAL_AMBIGUOUS;
    else if (committed > physical) classification = CLASS.GENUINELY_OVERSOLD;
    else if (before.booked !== committed || !invariantOk || before.afs !== proposed.afs) {
      classification = CLASS.BOOKED_CORRUPTED;
    } else if (led.reserved !== committed || led.onHand !== before.total) {
      classification = CLASS.LEDGER_INCOMPLETE;
    } else classification = CLASS.CLEAN;

    const open = indents.get(sku) ?? [];
    results.push({
      sku, brand: p.brand, classification, productId: p._id, updatedAt: p.updatedAt ?? null,
      before,
      ledger: { onHand: led.onHand, reserved: led.reserved, movements: led.movements },
      projection: { onHand: proj.onHand, reserved: proj.reserved },
      register: { committed, lines: reg.lines },
      verifiedCount: verified,
      proposed,
      deltas: proposed ? {
        total: proposed.total - before.total,
        booked: proposed.booked - before.booked,
        afs: proposed.afs - before.afs,
      } : null,
      openIndents: open.map((r) => ({ indentNumber: r.indentNumber, quantity: r.quantity, status: r.status })),
      indentsUnblocked: proposed
        ? open.filter((r) => before.afs < r.quantity && proposed.afs >= r.quantity)
          .map((r) => ({ indentNumber: r.indentNumber, quantity: r.quantity }))
        : [],
    });
  }
  return results;
};

/** The rows an apply run would actually change. */
export const correctable = (results) => results.filter((r) => {
  if (!r.proposed) return false;
  if (r.classification === CLASS.MALFORMED) return false;
  // A verified count makes a formerly ambiguous SKU correctable.
  const eligible = AUTO_FIXABLE.has(r.classification)
    || (r.verifiedCount !== null && r.classification !== CLASS.GENUINELY_OVERSOLD);
  if (!eligible) return false;
  return r.deltas.total !== 0 || r.deltas.booked !== 0 || r.deltas.afs !== 0;
});

/**
 * Apply one SKU's correction.
 *
 * CONCURRENCY. The update is conditional on the three figures still holding
 * the values the plan was computed from. A booking confirmed between the dry
 * run and the apply changes them, the condition fails, and the SKU is skipped
 * and reported rather than overwritten — which is the whole reason the
 * correction is expressed as a compare-and-set and not a `$set`.
 *
 * AUDITABILITY. The correction is also written to the ledger as an ADJUSTMENT
 * carrying the run id, so the repair itself appears in the stock history
 * rather than silently changing a number. That is what makes it reversible.
 */
export const applyCorrection = async (db, row, { runId }) => {
  const filter = {
    _id: row.productId,
    totalAvailableQuantity: row.before.total,
    bookedQuantity: row.before.booked,
    availableForSale: row.before.afs,
  };
  const res = await db.collection('products').updateOne(filter, {
    $set: {
      totalAvailableQuantity: row.proposed.total,
      bookedQuantity: row.proposed.booked,
      availableForSale: row.proposed.afs,
    },
  });
  if (res.modifiedCount !== 1) {
    return { ok: false, skipped: 'changed since the plan was computed' };
  }
  return { ok: true, runId };
};

/**
 * Record the correction in the ledger, so the repair is part of the history.
 *
 * Posted as an ADJUSTMENT with reasonCode RECONCILIATION rather than as a
 * receipt or an issue: nothing arrived and nothing shipped, a recorded figure
 * was corrected. The quantity is the change to PHYSICAL stock; a correction
 * that only moves `booked`/`afs` posts nothing, because no goods moved.
 */
export const recordCorrection = async (row, { runId }) => {
  if (!row.deltas || row.deltas.total === 0) return null;
  const { postBatch } = await import('../../modules/inventory/ledger.service.js');
  const result = await postBatch({
    idempotencyKey: `reconcile:${runId}:${row.sku}`,
    workflowType: 'stock-reconciliation',
    referenceType: 'system',
    referenceId: runId,
    note: `Reconciliation ${runId}: physical ${row.before.total} -> ${row.proposed.total}`
      + (row.verifiedCount !== null ? ' (client-verified count)' : ''),
    lines: [{
      movementType: 'ADJUSTMENT',
      skuCode: row.sku,
      brand: row.brand,
      quantity: row.deltas.total,
      beforeQuantity: row.before.total,
      afterQuantity: row.proposed.total,
      reasonCode: 'RECONCILIATION',
    }],
  });
  return result.batch.batchId;
};

/**
 * Read the client's verified physical counts.
 *
 * VALIDATION IS NOT OPTIONAL. This file comes back from a warehouse, filled in
 * by hand, and it is about to become the authority for physical stock. Every
 * row is checked and a bad one is REFUSED rather than coerced: a blank is not
 * zero, "12 approx" is not 12, and a SKU that is not in the catalogue is a
 * transcription error, not a new product.
 */
export const readVerifiedCounts = async (file, db) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0];

  const header = {};
  sheet.getRow(1).eachCell((cell, col) => {
    header[String(cell.value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')] = col;
  });
  const skuCol = header['sku code'];
  const countCol = Object.entries(header).find(([k]) => k.includes('verified physical stock'))?.[1];
  if (!skuCol || !countCol) {
    throw new Error('The workbook needs a "SKU Code" column and a "VERIFIED PHYSICAL STOCK" column.');
  }

  const known = new Set(await db.collection('products').distinct('skuCode'));
  const counts = new Map();
  const rejected = [];
  const blank = [];

  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const sku = String(sheet.getRow(r).getCell(skuCol).value ?? '').trim();
    if (!sku) continue;
    const raw = sheet.getRow(r).getCell(countCol).value;
    const value = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;

    if (value === null || value === undefined || String(value).trim() === '') { blank.push(sku); continue; }
    if (!known.has(sku)) { rejected.push({ row: r, sku, why: 'SKU is not in the catalogue' }); continue; }

    const n = Number(value);
    if (!Number.isFinite(n)) { rejected.push({ row: r, sku, why: `"${value}" is not a number` }); continue; }
    if (!Number.isInteger(n)) { rejected.push({ row: r, sku, why: `${n} is not a whole number` }); continue; }
    if (n < 0) { rejected.push({ row: r, sku, why: `${n} is negative` }); continue; }
    if (counts.has(sku) && counts.get(sku) !== n) {
      rejected.push({ row: r, sku, why: `counted twice with different figures (${counts.get(sku)} and ${n})` });
      continue;
    }
    counts.set(sku, n);
  }
  return { counts, rejected, blank };
};

/**
 * Which SKUs a person has explicitly approved for correction.
 *
 * WHY AN APPLY RUN REQUIRES THIS. Every correction here changes a figure a
 * customer can see. "Correct the thirteen the script worked out" is a decision
 * nobody made; "correct these eleven, not those two" is. The proposed-
 * corrections workbook already carries an `Approved? (Y/N)` column for exactly
 * that purpose, and until now nothing read it — so --apply would have applied
 * the lot regardless of what was written in it.
 *
 * Anything other than an affirmative is a refusal. A blank cell is not consent,
 * and neither is a question mark: the only way to be corrected is to be
 * approved in writing.
 */
const AFFIRMATIVE = new Set(['y', 'yes', 'approve', 'approved', 'ok', 'true', '1']);
const NEGATIVE = new Set(['n', 'no', 'reject', 'rejected', 'hold', 'false', '0']);

export const readApprovals = async (file) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheet = wb.worksheets[0];

  const header = {};
  sheet.getRow(1).eachCell((cell, col) => {
    header[String(cell.value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')] = col;
  });
  const skuCol = header['sku code'];
  const approvedCol = Object.entries(header).find(([k]) => k.startsWith('approved'))?.[1];
  if (!skuCol || !approvedCol) {
    throw new Error('The workbook needs a "SKU Code" column and an "Approved? (Y/N)" column.');
  }

  const approved = new Set();
  const rejected = [];
  const undecided = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const sku = String(sheet.getRow(r).getCell(skuCol).value ?? '').trim();
    if (!sku) continue;
    const raw = sheet.getRow(r).getCell(approvedCol).value;
    const value = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
    const token = String(value ?? '').trim().toLowerCase();

    if (AFFIRMATIVE.has(token)) approved.add(sku);
    else if (NEGATIVE.has(token)) rejected.push(sku);
    else undecided.push({ sku, value: token || '(blank)' });
  }
  return { approved, rejected, undecided };
};

/** Snapshot the stock fields of everything an apply run would touch. */
export const takeBackup = (rows, runId) => ({
  runId,
  takenAt: new Date().toISOString(),
  rows: rows.map((r) => ({
    productId: String(r.productId),
    sku: r.sku,
    brand: r.brand,
    before: r.before,
    proposed: r.proposed,
  })),
});

/**
 * Restore from a backup, without undoing anything that happened since.
 *
 * Each row is restored only if the product still holds the values this run
 * wrote. A booking, PO or adjustment afterwards changes them, the condition
 * fails, and that SKU is left alone and reported — so a rollback can never
 * erase a legitimate transaction made after the reconciliation.
 */
export const restoreBackup = async (db, backup) => {
  const restored = [];
  const skipped = [];
  for (const row of backup.rows) {
    const res = await db.collection('products').updateOne(
      {
        _id: new mongoose.Types.ObjectId(row.productId),
        totalAvailableQuantity: row.proposed.total,
        bookedQuantity: row.proposed.booked,
        availableForSale: row.proposed.afs,
      },
      {
        $set: {
          totalAvailableQuantity: row.before.total,
          bookedQuantity: row.before.booked,
          availableForSale: row.before.afs,
        },
      },
    );
    if (res.modifiedCount === 1) restored.push(row.sku);
    else skipped.push({ sku: row.sku, why: 'changed since the reconciliation — left as it is' });
  }
  return { restored, skipped };
};


export default {
  CLASS, DESCRIPTION, AUTO_FIXABLE, classifyAll, correctable, applyCorrection,
  recordCorrection, readVerifiedCounts, takeBackup, restoreBackup,
};
