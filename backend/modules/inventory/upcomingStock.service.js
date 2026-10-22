/**
 * UPCOMING STOCK — stock that is ordered but not yet received, and how much of
 * it the open indents would take (FIFO), for internal analysis.
 *
 *   Upcoming  = Σ outstanding of the SKU's open shipment lines
 *   Reserved  = what a FIFO allocation of Upcoming to the SKU's open indents
 *               would cover (allocateFifo) — calculated, never stored
 *   Remaining = Upcoming − Reserved
 *   Actual    = on hand, read live from the stock balances (the ledger's
 *               projection) — the same figure Inventory Master shows
 *
 * LINKED TO THE INVENTORY, NOT TYPED IN TWICE (decided 2026-10-21). Nobody
 * "receives" a shipment on this screen. Stock arrives the way it always has —
 * Inventory Import, Update Stock, a count — and every stock INCREASE the ledger
 * records for a SKU after its shipment line was loaded is counted as that much
 * of the shipment arriving, earliest ETA first (syncUpcoming). Decreases never
 * put quantity back: upcoming only goes down.
 *
 * What counts as an arrival: a positive RECEIPT, OPENING, ADJUSTMENT or COUNT
 * movement posted by a receipt, an adjustment, an import or a count. Not
 * transfers between locations (nothing arrived), and not stock coming back
 * from a booking (referenceType booking / order / reservation — it was ours
 * already).
 *
 * RESERVED IS A FIFO CALCULATION, NOT A RECORD (decided 2026-10-22). Nobody
 * reserves anything here. Every time the screen is read, each SKU's upcoming
 * quantity is shared out over its open indents, OLDEST INDENT FIRST (the order
 * the FIFO pass serves them in), taking upcoming stock earliest arrival first —
 * see allocateFifo. Each indent shows how much would be covered and by which
 * shipment; Remaining is what is left after every indent.
 *
 * INTERNAL ANALYSIS ONLY. The allocation is a simulation for planning: it is
 * not stored, never touches a booking, an indent or the stock, and nothing is
 * emailed or notified to anyone. Where stock actually goes when it arrives is
 * decided by Indent Stock Assignment (FIFO, or manual), exactly as without
 * this module — and since that changes the indents, the next read reflects it.
 *
 * Errors carry `statusCode`; the error handler turns them into the response.
 */

import mongoose from 'mongoose';

import { Product } from '../../models/Product.js';
import StockBalance from '../../models/StockBalance.js';
import StockMovement from '../../models/StockMovement.js';
import Reservation from '../../models/Reservation.js';
import UpcomingShipment, {
  OPEN_SHIPMENT_STATUSES, outstandingOf, shipmentStatusOf, refKeyFor, byEta,
} from '../../models/UpcomingShipment.js';
import UpcomingStockItem from '../../models/UpcomingStockItem.js';
import UpcomingArrival from '../../models/UpcomingArrival.js';
import { runInTransaction } from '../../utils/transaction.js';
import { recordAudit } from '../../utils/auditLog.js';
import { allowedBrands, canAccessBrand } from '../../utils/brandAccess.js';
import { canonicalBrand } from '../../utils/brandRegistry.js';
import { hasPermission, PERMISSIONS } from '../../middlewares/rbac.js';
import { istDayStart, parseIstDay } from '../../utils/businessDay.js';
import { createSku } from './sku.service.js';

const OPEN_INDENT = ['Pending', 'Partially Confirmed'];

/** Ledger movements that mean "stock came in". */
export const ARRIVAL_MOVEMENT_TYPES = ['RECEIPT', 'OPENING', 'ADJUSTMENT', 'COUNT'];
export const ARRIVAL_REFERENCE_TYPES = ['receipt', 'adjustment', 'import', 'count'];

/**
 * How far behind the last movement already looked at each pass looks again.
 * A movement is stamped when it is built, not when its transaction commits, so
 * a slow commit can land "in the past". The unique index on UpcomingArrival
 * makes looking at the same movement twice harmless.
 */
const LOOKBACK_MS = 15 * 60 * 1000;

/** Same threshold the screen states: 20 % or less of upcoming still free. */
const LOW_REMAINING_SHARE = 0.2;

export const MAX_IMPORT_ROWS = 2000;
const SKU_MAX = 64;

const fail = (status, message, code) => Object.assign(new Error(message), { statusCode: status, ...(code ? { code } : {}) });

const pairKey = (brand, skuCode) => `${brand}\u0000${skuCode}`;
const userName = (u) => u?.user || u?.name || u?.email || null;
const customerLabel = (c) => c?.customerName || c?.company || c?.user || c?.name || c?.email || '—';
const cleanText = (v, max) => String(v ?? '').trim().slice(0, max);
const sessionOpts = (session) => (session ? { session } : {});
const isObjectId = (v) => mongoose.isValidObjectId(v) && String(new mongoose.Types.ObjectId(String(v))) === String(v);

const lockItem = (brand, skuCode, session, setOnInsert = {}) => UpcomingStockItem.findOneAndUpdate(
  { brand, skuCode },
  { $inc: { version: 1 }, ...(Object.keys(setOnInsert).length ? { $setOnInsert: setOnInsert } : {}) },
  { new: true, upsert: Object.keys(setOnInsert).length > 0, ...sessionOpts(session) },
);

// ─────────────────────────────────────────────────────────────────────────────
// Arrivals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count these ledger movements against one SKU's open shipment lines.
 * One transaction per SKU; returns the units that went against shipments.
 */
const applyArrivals = async (brand, skuCode, movements) => {
  try {
    return await runInTransaction(async (session) => {
      const opts = sessionOpts(session);
      const item = await lockItem(brand, skuCode, session);
      if (!item) return 0;

      const ids = movements.map((m) => m._id);
      const done = new Set(
        (await UpcomingArrival.find({ movement: { $in: ids } }, 'movement', opts).lean()).map((a) => String(a.movement)),
      );
      const todo = movements.filter((m) => !done.has(String(m._id)));
      if (todo.length === 0) return 0;

      const lines = await UpcomingShipment.find(
        { brand, skuCode, status: { $in: OPEN_SHIPMENT_STATUSES } },
        null,
        opts,
      );
      // Earliest ETA first; a line with no date yet is filled after every dated one.
      lines.sort(byEta);

      const changed = new Set();
      const arrivals = [];
      let total = 0;
      for (const m of todo) {
        let left = m.quantity;
        const allocations = [];
        for (const line of lines) {
          if (left <= 0) break;
          // A line only receives stock that arrived after it was recorded.
          if (new Date(line.createdAt) > new Date(m.createdAt)) continue;
          const out = outstandingOf(line);
          if (out <= 0) continue;
          const take = Math.min(out, left);
          line.receivedQty += take;
          line.lastArrivalAt = m.createdAt;
          line.status = shipmentStatusOf(line);
          changed.add(line);
          allocations.push({ shipment: line._id, shipmentRef: line.shipmentRef, qty: take });
          left -= take;
        }
        const appliedQty = m.quantity - left;
        total += appliedQty;
        arrivals.push({
          movement: m._id,
          transactionId: m.transactionId ?? null,
          batchId: m.batchId ?? null,
          brand,
          skuCode,
          movementType: m.movementType,
          referenceType: m.referenceType ?? null,
          referenceId: m.referenceId ?? null,
          quantity: m.quantity,
          appliedQty,
          allocations,
          movedAt: m.createdAt,
        });
      }

      // Arrivals first: the unique index refuses a movement another pass has
      // just counted, before any shipment line has been touched.
      await UpcomingArrival.insertMany(arrivals, opts);
      for (const line of changed) await line.save(opts);

      const newest = todo.reduce((t, m) => Math.max(t, new Date(m.createdAt).getTime()), 0);
      const synced = item.syncedThrough ? new Date(item.syncedThrough).getTime() : 0;
      if (newest > synced) {
        await UpcomingStockItem.updateOne({ _id: item._id }, { $set: { syncedThrough: new Date(newest) } }, opts);
      }
      return total;
    }, { label: 'upcoming-arrival' });
  } catch (error) {
    // Another pass counted the same movement first — it is counted, once.
    if (error?.code === 11000) return 0;
    throw error;
  }
};

/**
 * Bring upcoming stock up to date with the ledger, for these SKUs (or every
 * SKU in these brands, or everything).
 *
 * Called at the top of processAvailableIndents — which every stock-in path
 * already calls — so arrivals are counted as soon as stock moves; and when the
 * screen is read, so the figures are current even if something posted stock by
 * another route. It only updates Upcoming Stock's own records.
 */
export const syncUpcoming = async ({ skuCodes = null, brands = null } = {}) => {
  const scope = {};
  if (skuCodes) {
    const skus = [...new Set(skuCodes.filter(Boolean))];
    if (skus.length === 0) return { applied: 0 };
    scope.skuCodes = skus;
  }
  if (brands) scope.brands = brands;

  const lineFilter = { status: { $in: OPEN_SHIPMENT_STATUSES } };
  if (scope.skuCodes) lineFilter.skuCode = { $in: scope.skuCodes };
  if (scope.brands) lineFilter.brand = { $in: scope.brands };
  const open = await UpcomingShipment.find(lineFilter, 'brand skuCode createdAt').lean();

  let applied = 0;
  if (open.length) {
    // Per SKU: from its earliest open line, or the last movement already seen.
    const first = new Map();
    for (const l of open) {
      const k = pairKey(l.brand, l.skuCode);
      const t = new Date(l.createdAt).getTime();
      if (!first.has(k) || t < first.get(k).t) first.set(k, { brand: l.brand, skuCode: l.skuCode, t });
    }
    const items = await UpcomingStockItem.find(
      { $or: [...first.values()].map(({ brand, skuCode }) => ({ brand, skuCode })) },
      'brand skuCode syncedThrough',
    ).lean();
    const synced = new Map(items.map((i) => [pairKey(i.brand, i.skuCode), i.syncedThrough]));
    const since = new Map([...first].map(([k, v]) => {
      const s = synced.get(k) ? new Date(synced.get(k)).getTime() : 0;
      return [k, Math.max(v.t, s) - LOOKBACK_MS];
    }));

    // Everything committed before this instant is seen by the read below (or,
    // if its commit was slow, by the next pass's lookback).
    const scanStartedAt = new Date();
    const movements = await StockMovement.find({
      skuCode: { $in: [...new Set(open.map((l) => l.skuCode))] },
      movementType: { $in: ARRIVAL_MOVEMENT_TYPES },
      referenceType: { $in: ARRIVAL_REFERENCE_TYPES },
      quantity: { $gt: 0 },
      createdAt: { $gte: new Date(Math.min(...since.values())) },
    }, '_id transactionId batchId skuCode brand movementType referenceType referenceId quantity createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    const relevant = movements.filter((m) => {
      const s = since.get(pairKey(m.brand, m.skuCode));
      return s !== undefined && new Date(m.createdAt).getTime() >= s;
    });
    if (relevant.length) {
      const seen = new Set(
        (await UpcomingArrival.find({ movement: { $in: relevant.map((m) => m._id) } }, 'movement').lean())
          .map((a) => String(a.movement)),
      );
      const bySku = new Map();
      for (const m of relevant) {
        if (seen.has(String(m._id))) continue;
        const k = pairKey(m.brand, m.skuCode);
        if (!bySku.has(k)) bySku.set(k, { brand: m.brand, skuCode: m.skuCode, movements: [] });
        bySku.get(k).movements.push(m);
      }
      for (const { brand, skuCode, movements: list } of bySku.values()) {
        applied += await applyArrivals(brand, skuCode, list);
      }
    }

    // Every SKU looked at is now up to date as of the scan. Without this, a SKU
    // whose stock never moves would be re-scanned from the day its shipment was
    // imported on every pass, over a ledger that only grows.
    await UpcomingStockItem.updateMany(
      { $or: [...first.values()].map(({ brand, skuCode }) => ({ brand, skuCode })) },
      [{ $set: { syncedThrough: { $max: ['$syncedThrough', scanStartedAt] } } }],
    );
  }

  return { applied };
};

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Share a SKU's upcoming stock out over its open indents, FIFO.
 *
 * Indents are served OLDEST FIRST — the order the real FIFO pass serves them
 * (indentAvailability.service.js) — and each takes what it is still waiting
 * for, until the upcoming stock runs out. Upcoming stock is used EARLIEST
 * ARRIVAL FIRST (undated shipments last), so each indent also says which
 * shipment(s) would cover it and when.
 *
 * Pure: a calculation for the screen, nothing is stored or changed.
 *
 * @param {Array<{id, ref, eta, qty}>}             shipments earliest first; qty = outstanding
 * @param {Array<{lineId, requiredQty, raisedAt}>} indents   oldest first
 * @returns {{ indents: object[], reserved: number, remaining: number }}
 */
export const allocateFifo = (shipments, indents) => {
  const pool = shipments.map((s) => ({ id: s.id, ref: s.ref ?? null, eta: s.eta ?? null, left: Math.max(0, s.qty || 0) }));
  let at = 0;
  let reserved = 0;
  const out = indents.map((indent, i) => {
    let need = Math.max(0, indent.requiredQty || 0);
    const coveredBy = [];
    while (need > 0 && at < pool.length) {
      const s = pool[at];
      if (s.left === 0) { at += 1; continue; }
      const take = Math.min(s.left, need);
      s.left -= take;
      need -= take;
      coveredBy.push({ shipmentId: s.id, ref: s.ref, eta: s.eta, qty: take });
    }
    const reservedQty = Math.max(0, indent.requiredQty || 0) - need;
    reserved += reservedQty;
    return { ...indent, fifoPosition: i + 1, reservedQty, shortQty: need, coveredBy };
  });
  const remaining = pool.reduce((t, s) => t + s.left, 0);
  return { indents: out, reserved, remaining };
};

const statusFor = ({ upcoming, remaining, nextEta, today }) => {
  if (upcoming === 0) return 'No Inbound';
  if (nextEta && istDayStart(nextEta).getTime() < today) return 'Delayed';
  if (remaining === 0) return 'Fully Reserved';
  if (remaining <= upcoming * LOW_REMAINING_SHARE) return 'Low Remaining';
  return 'Available';
};

/**
 * Every SKU with stock on its way, in the brands this user may see, with the
 * FIFO allocation of that stock to the SKU's open indents (allocateFifo).
 *
 * Indent customers are named only for users who already see them elsewhere
 * (the booking desk, view_all_bookings; the assignment screen,
 * assign_indent_stock). Anyone else gets the indent's number and quantities.
 */
export const listUpcoming = async ({ user }) => {
  const brands = allowedBrands(user);
  const scope = { brand: { $in: brands } };

  // A failed sync must not cost the user the screen: the figures are then as
  // of the last successful one, and the next read tries again.
  await syncUpcoming({ brands }).catch((e) => console.error('[UpcomingStock] sync failed:', e.message));

  const openLines = (await UpcomingShipment.find({ ...scope, status: { $in: OPEN_SHIPMENT_STATUSES } }).lean())
    .sort(byEta);
  const lastImportLine = await UpcomingShipment.findOne({ ...scope, importId: { $ne: null }, status: { $ne: 'Deleted' } }, 'source createdAt')
    .sort({ createdAt: -1 }).lean();
  const lastImport = lastImportLine ? { fileName: lastImportLine.source, importedAt: lastImportLine.createdAt } : null;

  const pairs = new Map();
  for (const x of openLines) pairs.set(pairKey(x.brand, x.skuCode), { brand: x.brand, skuCode: x.skuCode });
  if (pairs.size === 0) return { items: [], lastImport, generatedAt: new Date() };

  const pairList = [...pairs.values()];
  const skus = [...new Set(pairList.map((p) => p.skuCode))];
  const [products, balances] = await Promise.all([
    Product.find({ $or: pairList }, 'skuCode brand description category uom').lean(),
    StockBalance.aggregate([
      { $match: { skuCode: { $in: skus }, brand: { $in: brands } } },
      { $group: { _id: { skuCode: '$skuCode', brand: '$brand' }, onHand: { $sum: '$onHand' } } },
    ]),
  ]);
  const productByPair = new Map(products.map((p) => [pairKey(p.brand, p.skuCode), p]));
  const pairByProduct = new Map(products.map((p) => [String(p._id), pairKey(p.brand, p.skuCode)]));
  const onHand = new Map(balances.map((b) => [pairKey(b._id.brand, b._id.skuCode), b.onHand]));

  const seesCustomers = hasPermission(user, PERMISSIONS.VIEW_ALL_BOOKINGS)
    || hasPermission(user, PERMISSIONS.ASSIGN_INDENT_STOCK);

  // Oldest first, ties by creation — the order the real FIFO pass uses.
  const indents = await Reservation.find({ skuCode: { $in: skus }, status: { $in: OPEN_INDENT } })
    .populate('customerId', 'user name email company customerName')
    .sort({ reservationDate: 1, createdAt: 1, _id: 1 })
    .lean();
  const indentsByPair = new Map();
  for (const i of indents) {
    // An indent is for one product; the SKU code alone can exist under two brands.
    const k = pairByProduct.get(String(i.productId));
    if (!k) continue;
    if (!indentsByPair.has(k)) indentsByPair.set(k, []);
    const po = String(i.poNumber ?? '').trim();
    indentsByPair.get(k).push({
      lineId: String(i._id),
      indentNumber: i.indentNumber || i.reservationId,
      skuCode: i.skuCode,
      customer: seesCustomers ? customerLabel(i.customerId) : '—',
      requiredQty: Number(i.quantity) || 0,
      status: i.status,
      poNumber: po && po !== '-' ? po : null,
      raisedAt: i.reservationDate || i.createdAt || null,
      scheduledDate: i.scheduledDate || null,
    });
  }

  const linesByPair = new Map();
  for (const l of openLines) {
    const k = pairKey(l.brand, l.skuCode);
    if (!linesByPair.has(k)) linesByPair.set(k, []);
    linesByPair.get(k).push(l);
  }

  const today = istDayStart(new Date()).getTime();
  const out = pairList.map(({ brand, skuCode }) => {
    const k = pairKey(brand, skuCode);
    const product = productByPair.get(k);
    const shipments = (linesByPair.get(k) || []).map((l) => ({
      id: String(l._id),
      ref: l.shipmentRef,
      supplier: l.supplier || '—',
      qty: outstandingOf(l),
      orderedQty: l.orderedQty,
      receivedQty: l.receivedQty || 0,
      eta: l.eta,
      etaRevised: (l.etaChanges || []).length > 0,
      status: l.status,
      source: l.source,
      importedAt: l.createdAt,
      lastArrivalAt: l.lastArrivalAt,
    }));
    const upcoming = shipments.reduce((s, x) => s + x.qty, 0);
    const fifo = allocateFifo(shipments, indentsByPair.get(k) || []);
    const actual = onHand.get(k) ?? 0;
    // Shipments are already earliest-first with undated ones last, so the first
    // dated one is the next arrival. None dated: no next arrival to show.
    const nextEta = shipments.find((s) => s.eta)?.eta ?? null;
    return {
      key: `${brand}::${skuCode}`,
      brand,
      skuCode,
      product: product?.description || skuCode,
      category: (product?.category || [])[0] || '—',
      uom: product?.uom || 'PCS',
      actual,
      shipments,
      indents: fifo.indents,
      demand: fifo.indents.reduce((s, i) => s + i.requiredQty, 0),
      upcoming,
      reserved: fifo.reserved,
      remaining: fifo.remaining,
      projected: actual + fifo.remaining,
      reservedShare: upcoming ? fifo.reserved / upcoming : 0,
      nextEta,
      shipmentCount: shipments.length,
      status: statusFor({ upcoming, remaining: fifo.remaining, nextEta, today }),
    };
  });

  out.sort((a, b) => a.key.localeCompare(b.key));
  return { items: out, lastImport, generatedAt: new Date() };
};

// ─────────────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check rows from an upcoming-stock file. The browser reads the sheet and maps
 * its columns; every rule is decided here, and checked again on commit.
 *
 * @param {Array<{row, skuCode, brand, product, qty, eta, ref, supplier}>} rows
 *        `eta` as 'YYYY-MM-DD' (an IST calendar day).
 * @returns {{ lines: object[] }} one per row: outcome 'existing' (adds to a SKU
 *        in Inventory Master), 'new' (the SKU will be created) or 'error'.
 */
export const validateImport = async ({ rows, user }) => ({ lines: (await checkImportRows({ rows, user })).lines });

/** validateImport, plus each row's product text (the description a new SKU is created with). */
const checkImportRows = async ({ rows, user }) => {
  if (!Array.isArray(rows) || rows.length === 0) throw fail(400, 'The file has no data rows.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw fail(413, `The file has ${rows.length} rows; import at most ${MAX_IMPORT_ROWS} at a time.`);
  }
  const mayUse = new Set(allowedBrands(user));

  const parsed = rows.map((r, i) => {
    const skuCode = cleanText(r?.skuCode, 200);
    const qtyText = String(r?.qty ?? '').trim().replace(/,/g, '');
    const qty = qtyText === '' ? Number.NaN : Number(qtyText);
    // Only SKU and quantity are required (decided 2026-10-22). Every other
    // column may be blank, and can be filled in after the import (Edit on the
    // entry). A date that IS given but cannot be read is still refused: taking
    // it as "no date" would quietly lose what the sheet said.
    const etaText = cleanText(r?.eta, 40);
    const etaDate = etaText ? parseIstDay(etaText) : null;
    const refText = cleanText(r?.ref, 80);
    const ref = refText && refText !== '—' ? refText : null;
    const problems = [];
    if (!skuCode) problems.push('SKU code is missing');
    else if (skuCode.length > SKU_MAX) problems.push(`SKU code is longer than ${SKU_MAX} characters`);
    else if (/[\r\n\t]/.test(skuCode)) problems.push('SKU code contains a line break or tab');
    if (!Number.isInteger(qty) || qty <= 0) problems.push(`Quantity "${String(r?.qty ?? '')}" is not a whole number above 0`);
    if (etaText && !etaDate) {
      problems.push(`Expected arrival "${etaText}" is not a date — use dd/mm/yyyy, or leave it blank`);
    }
    return {
      row: Number.isInteger(r?.row) ? r.row : i + 2,
      skuCode,
      brandRaw: cleanText(r?.brand, 80),
      productText: cleanText(r?.product, 200),
      qty,
      etaDate,
      ref,
      supplier: cleanText(r?.supplier, 120) || null,
      problems,
    };
  });

  const codes = [...new Set(parsed.map((p) => p.skuCode).filter(Boolean))];
  // Case-insensitive, like the catalogue's own duplicate check: "14405m-10"
  // is the part every human means by "14405M-10".
  const found = codes.length
    ? await Product.find({ skuCode: { $in: codes } }, 'skuCode brand description')
      .collation({ locale: 'en', strength: 2 }).lean()
    : [];
  const bySku = new Map();
  for (const p of found) {
    const k = p.skuCode.toLowerCase();
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(p);
  }

  const lines = parsed.map((p) => {
    const matches = p.skuCode ? bySku.get(p.skuCode.toLowerCase()) || [] : [];
    const brand = p.brandRaw ? canonicalBrand(p.brandRaw) : null;
    let existing = null;
    if (p.skuCode) {
      if (p.brandRaw && !brand) p.problems.push(`Brand "${p.brandRaw}" does not exist`);
      else if (brand) existing = matches.find((m) => m.brand === brand) || null;
      else if (matches.length === 1) [existing] = matches;
      else if (matches.length > 1) {
        // Brand is optional, but here it is the only way to say which SKU is meant.
        p.problems.push(`${p.skuCode} exists under ${matches.map((m) => m.brand).join(' and ')} — name the brand to say which`);
      } else {
        // Optional for a SKU already in Inventory Master (it is read from there);
        // a NEW SKU has to be created under some brand.
        p.problems.push(`${p.skuCode} is not in Inventory Master — give its brand so it can be created`);
      }
    }
    const finalBrand = existing?.brand || brand || null;
    if (finalBrand && !mayUse.has(finalBrand)) p.problems.push(`You do not have access to ${finalBrand}`);
    return {
      row: p.row,
      skuCode: existing?.skuCode || p.skuCode,
      brand: finalBrand || p.brandRaw || '—',
      product: existing?.description || p.productText || p.skuCode,
      productText: p.productText,
      qty: Number.isFinite(p.qty) ? p.qty : 0,
      eta: p.etaDate ? p.etaDate.toISOString() : null,
      ref: p.ref,
      supplier: p.supplier,
      outcome: p.problems.length ? 'error' : existing ? 'existing' : 'new',
      problems: p.problems,
    };
  });

  const merged = mergeDuplicateRows(lines);

  // The same PO line already on upcoming stock is refused, not merged into:
  // importing it again would double the quantity on its way, and quietly
  // changing an existing entry from a file is not what an import is for. Only
  // a line WITH a reference can be recognised; without one it is a new entry.
  const candidates = merged.filter((l) => l.outcome !== 'error' && l.ref);
  if (candidates.length) {
    const already = await UpcomingShipment.find({
      cancelled: false,
      $or: candidates.map((l) => ({ brand: l.brand, skuCode: l.skuCode, refKey: l.ref.toLowerCase() })),
    }, 'brand skuCode refKey shipmentRef orderedQty status').lean();
    const taken = new Map(already.map((s) => [`${s.brand}\u0000${s.skuCode.toLowerCase()}\u0000${s.refKey}`, s]));
    for (const l of candidates) {
      const hit = taken.get(`${l.brand}\u0000${l.skuCode.toLowerCase()}\u0000${l.ref.toLowerCase()}`);
      if (!hit) continue;
      // Matched on refKey, so the line found has the same (real) reference.
      l.problems.push(`Already on upcoming stock under ${hit.shipmentRef} (${hit.orderedQty} ordered, ${hit.status.toLowerCase()})`);
      l.outcome = 'error';
    }
  }

  return {
    lines: merged.map(({ productText: _p, ...l }) => l),
    productText: new Map(merged.map((l) => [l.row, l.productText])),
  };
};

/**
 * Duplicate rows in one file become ONE line with their quantities added
 * (decided 2026-10-22).
 *
 * Duplicate = same brand, same SKU and the same PO / shipment reference (case
 * ignored; two rows with no reference also match). Rows for one SKU under
 * different references are different shipments and stay apart. Rows with an
 * error are not merged — they are skipped, as the preview says.
 *
 * The first row is kept and takes the others' quantity. Its blank columns are
 * filled from the later rows; where rows give different dates the EARLIEST is
 * kept (stock is planned against the first arrival), and a different supplier
 * or description is noted rather than silently chosen.
 */
const mergeDuplicateRows = (lines) => {
  const keyOf = (l) => `${l.brand}\u0000${l.skuCode.toLowerCase()}\u0000${(l.ref || '').toLowerCase()}`;
  const groups = new Map();
  const out = [];
  for (const l of lines) {
    if (l.outcome === 'error') { out.push(l); continue; }
    const k = keyOf(l);
    const first = groups.get(k);
    if (!first) {
      const kept = { ...l, mergedRows: [l.row], mergedQtys: [l.qty], notes: [], dates: new Set(l.eta ? [l.eta] : []) };
      groups.set(k, kept);
      out.push(kept);
      continue;
    }
    first.mergedRows.push(l.row);
    first.mergedQtys.push(l.qty);
    first.qty += l.qty;
    if (l.eta) {
      first.dates.add(l.eta);
      if (!first.eta || new Date(l.eta) < new Date(first.eta)) first.eta = l.eta;
    }
    for (const [field, label] of [['supplier', 'supplier'], ['productText', 'description']]) {
      if (!l[field]) continue;
      if (!first[field]) first[field] = l[field];
      else if (first[field] !== l[field]) first.notes.push(`row ${l.row} had a different ${label}; kept "${first[field]}"`);
    }
    if (first.outcome === 'new' && first.productText && first.product === first.skuCode) first.product = first.productText;
  }
  for (const l of out) {
    if (!l.mergedRows) continue;
    const { dates, mergedQtys } = l;
    delete l.dates;
    delete l.mergedQtys;
    if (l.mergedRows.length < 2) { delete l.mergedRows; delete l.notes; continue; }
    if (dates.size > 1) l.notes.unshift('dates differed — kept the earliest');
    l.notes.unshift(`Merged rows ${l.mergedRows.join(', ')} (${mergedQtys.join(' + ')} = ${l.qty})`);
  }
  return out;
};

/**
 * Record the valid rows of an upcoming-stock file as shipment lines.
 *
 * Rows with errors are skipped, as the preview said they would be. SKUs not in
 * Inventory Master are created first, through the same createSku the Add SKU
 * form uses (decided 2026-10-21) — with zero stock: stock only ever arrives
 * through the inventory. The lines themselves are written in one transaction,
 * so a file is recorded whole or not at all.
 *
 * `importId` comes from the browser, once per file. A resubmission with the
 * same id (a double click, a retried request) returns the first result and
 * writes nothing.
 */
export const commitImport = async ({ importId, fileName, rows, user, req }) => {
  const id = cleanText(importId, 64);
  if (!id) throw fail(400, 'importId is required.');
  const source = cleanText(fileName, 200) || 'Upcoming stock import';

  const prior = await UpcomingShipment.find({ importId: id }, 'orderedQty source').lean();
  if (prior.length) {
    return {
      importId: id, replayed: true, lines: prior.length,
      qty: prior.reduce((s, l) => s + l.orderedQty, 0), created: 0, skipped: 0,
    };
  }

  const { lines, productText } = await checkImportRows({ rows, user });
  const valid = lines.filter((l) => l.outcome !== 'error');
  if (valid.length === 0) throw fail(400, 'No row in the file can be imported. Fix the errors and try again.');

  // ── New SKUs ──────────────────────────────────────────────────────────────
  let created = 0;
  const made = new Set();
  for (const l of valid.filter((x) => x.outcome === 'new')) {
    const k = pairKey(l.brand, l.skuCode);
    if (made.has(k)) continue;
    made.add(k);
    try {
      const text = productText.get(l.row);
      await createSku({
        payload: {
          skuCode: l.skuCode,
          brand: l.brand,
          ...(text ? { description: text } : {}),
          ...(l.supplier ? { vendorName: l.supplier } : {}),
        },
        actor: user,
        allowedBrandList: allowedBrands(user),
      });
      created += 1;
      await recordAudit(user, 'Inventory Master Updated', `SKU ${l.skuCode} created under ${l.brand} from upcoming stock file ${source}.`, req, {
        meta: { skuCode: l.skuCode, brand: l.brand, created: true, source: 'upcoming-import' },
      });
    } catch (error) {
      // Somebody created it a moment ago: it exists, which is all this needs.
      if (error?.code !== 'SKU_EXISTS') {
        for (const same of valid.filter((x) => pairKey(x.brand, x.skuCode) === k)) {
          same.outcome = 'error';
          same.problems.push(error.message);
        }
      }
    }
  }

  const toWrite = valid.filter((l) => l.outcome !== 'error');
  if (toWrite.length === 0) throw fail(400, 'No row in the file could be imported.');

  const products = await Product.find(
    { $or: toWrite.map((l) => ({ brand: l.brand, skuCode: l.skuCode })) },
    'brand skuCode',
  ).lean();
  const productId = new Map(products.map((p) => [pairKey(p.brand, p.skuCode), p._id]));

  const byName = userName(user);
  try {
    await runInTransaction(async (session) => {
      const opts = sessionOpts(session);
      for (const k of new Set(toWrite.map((l) => pairKey(l.brand, l.skuCode)))) {
        const l = toWrite.find((x) => pairKey(x.brand, x.skuCode) === k);
        await lockItem(l.brand, l.skuCode, session, { product: productId.get(k) ?? null });
      }
      await UpcomingShipment.insertMany(toWrite.map((l) => ({
        brand: l.brand,
        skuCode: l.skuCode,
        product: productId.get(pairKey(l.brand, l.skuCode)) ?? null,
        shipmentRef: l.ref,
        refKey: refKeyFor(l.ref),
        supplier: l.supplier,
        orderedQty: l.qty,
        eta: l.eta ? new Date(l.eta) : null,
        source,
        importId: id,
        createdBy: user?._id ?? null,
        createdByName: byName,
      })), opts);
    }, { label: 'upcoming-import' });
  } catch (error) {
    if (error?.code === 11000) {
      throw fail(409, 'A line in this file was recorded on upcoming stock a moment ago. Refresh, then import again.');
    }
    throw error;
  }

  const qty = toWrite.reduce((s, l) => s + l.qty, 0);
  await recordAudit(user, 'Upcoming Stock Imported', `${toWrite.length} line(s), ${qty} unit(s) from ${source}.`, req, {
    meta: { importId: id, lines: toWrite.length, qty, created, skipped: lines.length - toWrite.length, merged: rows.length - lines.length },
  });
  // `merged`: rows folded into another row of the file (their quantity is included).
  return {
    importId: id, replayed: false, lines: toWrite.length, qty, created,
    skipped: lines.length - toWrite.length, merged: rows.length - lines.length,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Shipment lines
// ─────────────────────────────────────────────────────────────────────────────

const loadLine = async (id, user) => {
  if (!isObjectId(id)) throw fail(400, 'Invalid shipment id.');
  const line = await UpcomingShipment.findById(id).lean();
  if (!line || !canAccessBrand(user, line.brand)) throw fail(404, 'Shipment line not found.');
  if (!OPEN_SHIPMENT_STATUSES.includes(line.status)) {
    throw fail(409, `This shipment line is already ${line.status.toLowerCase()}.`);
  }
  return line;
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);

/**
 * Edit an upcoming stock entry after import — every column of the file except
 * the SKU (the entry IS that SKU's; to move it, delete it and import again).
 *
 * Only the fields present in `changes` are touched; a blank optional field
 * clears it. All of:
 *
 *   orderedQty  whole, ≥ 1, and never below what has already arrived against
 *               the entry (checked under the SKU's lock).
 *   eta         'YYYY-MM-DD', or blank for "not known yet". Kept in etaChanges.
 *   ref         PO / shipment reference, or blank. Must not repeat another live
 *               entry of the same SKU.
 *   supplier    free text, or blank.
 *   product     the SKU's description — which belongs to Inventory Master, so
 *               it is written there (and shows wherever the SKU is shown).
 *
 * The inventory itself is never touched.
 */
export const updateShipment = async ({ id, changes, user, req }) => {
  const line = await loadLine(id, user);
  const set = {};
  const said = [];

  if (has(changes, 'orderedQty')) {
    const qty = Number(String(changes.orderedQty ?? '').replace(/,/g, '').trim() || Number.NaN);
    if (!Number.isInteger(qty) || qty < 1) throw fail(400, 'Quantity must be a whole number above 0.');
    if (qty < (line.receivedQty || 0)) {
      throw fail(409, `${line.receivedQty} have already arrived against this entry, so the quantity cannot be less than that.`);
    }
    if (qty !== line.orderedQty) { set.orderedQty = qty; said.push(`quantity ${line.orderedQty} → ${qty}`); }
  }

  let day;
  if (has(changes, 'eta')) {
    const text = cleanText(changes.eta, 40);
    day = text ? parseIstDay(text) : null;
    if (text && !day) throw fail(400, 'Expected arrival must be a date, or blank.');
    const before = line.eta ? istDayStart(line.eta).getTime() : null;
    if ((day ? day.getTime() : null) !== before) { set.eta = day; said.push(`expected ${day ? day.toISOString().slice(0, 10) : 'not set'}`); }
  }

  if (has(changes, 'ref')) {
    const text = cleanText(changes.ref, 80);
    const ref = text && text !== '—' ? text : null;
    if (ref !== (line.shipmentRef || null)) {
      if (ref) {
        const clash = await UpcomingShipment.findOne({
          _id: { $ne: line._id }, brand: line.brand, skuCode: line.skuCode, refKey: ref.toLowerCase(), cancelled: false,
        }, 'shipmentRef').lean();
        if (clash) throw fail(409, `${line.skuCode} already has an upcoming entry under ${clash.shipmentRef}.`);
      }
      set.shipmentRef = ref;
      set.refKey = refKeyFor(ref);
      said.push(`reference ${ref || 'cleared'}`);
    }
  }

  if (has(changes, 'supplier')) {
    const supplier = cleanText(changes.supplier, 120) || null;
    if (supplier !== (line.supplier || null)) { set.supplier = supplier; said.push(`supplier ${supplier || 'cleared'}`); }
  }

  let description;
  if (has(changes, 'product')) {
    const product = await Product.findOne({ brand: line.brand, skuCode: line.skuCode }, 'description').lean();
    const text = cleanText(changes.product, 200) || null;
    if (product && text !== (product.description || null)) description = { product, text };
  }

  if (Object.keys(set).length === 0 && !description) throw fail(409, 'Nothing was changed.');

  if (Object.keys(set).length) {
    try {
      await runInTransaction(async (session) => {
        const opts = sessionOpts(session);
        await lockItem(line.brand, line.skuCode, session);
        const fresh = await UpcomingShipment.findById(line._id, null, opts);
        if (!fresh || !OPEN_SHIPMENT_STATUSES.includes(fresh.status)) {
          throw fail(409, 'This entry was received, cancelled or deleted a moment ago.');
        }
        if (set.orderedQty !== undefined) {
          if (set.orderedQty < fresh.receivedQty) {
            throw fail(409, `${fresh.receivedQty} have already arrived against this entry, so the quantity cannot be less than that.`);
          }
        }
        Object.assign(fresh, set);
        if (has(set, 'eta')) {
          fresh.etaChanges.push({ from: line.eta ?? null, to: set.eta, by: user?._id ?? null, byName: userName(user), at: new Date() });
        }
        fresh.status = shipmentStatusOf(fresh);
        await fresh.save(opts);
      }, { label: 'upcoming-edit' });
    } catch (error) {
      if (error?.code === 11000) throw fail(409, `${line.skuCode} already has an upcoming entry under that reference.`);
      throw error;
    }
  }

  if (description) {
    await Product.updateOne({ _id: description.product._id }, { $set: { description: description.text } });
    said.push(`product description ${description.text ? `"${description.text}"` : 'cleared'}`);
    await recordAudit(user, 'Inventory Master Updated', `${line.skuCode} description set from Upcoming Stock.`, req, {
      meta: { skuCode: line.skuCode, brand: line.brand, from: description.product.description ?? null, to: description.text },
    });
  }

  await recordAudit(user, 'Upcoming Shipment Edited', `${line.shipmentRef || 'Entry without reference'} ${line.skuCode}: ${said.join('; ')}.`, req, {
    meta: { shipmentId: String(line._id), changes: { ...set, ...(description ? { product: description.text } : {}) } },
  });
  return { id: String(line._id), changed: said };
};

/**
 * Stop expecting what is left of a shipment line (the supplier cancelled, or
 * short-shipped).
 */
/**
 * Take what is still outstanding on a shipment line off upcoming stock, as
 * `status` ('Cancelled' or 'Deleted'). Shared by cancel and delete: the two
 * differ only in what the line is recorded as.
 *
 * Neither touches the inventory — nothing is posted to the ledger, and units
 * that already arrived against the line stay arrived. The FIFO allocation to
 * indents is recalculated on the next read, so nothing else needs undoing.
 */
const closeShipment = async ({ id, note, user, status }) => {
  const line = await loadLine(id, user);
  // Count anything that has already arrived first, so it is not taken away.
  await syncUpcoming({ skuCodes: [line.skuCode] });
  const verb = status === 'Deleted' ? 'deleted' : 'cancelled';

  return runInTransaction(async (session) => {
    const opts = sessionOpts(session);
    await lockItem(line.brand, line.skuCode, session);
    const fresh = await UpcomingShipment.findById(line._id, null, opts);
    if (!fresh || !OPEN_SHIPMENT_STATUSES.includes(fresh.status)) {
      throw fail(409, 'This shipment line was received, cancelled or deleted a moment ago.');
    }
    const out = outstandingOf(fresh);
    const now = new Date();
    const by = user?._id ?? null;
    const byName = userName(user);
    const reason = cleanText(note, 300) || null;
    fresh.cancelledQty += out;
    // Frees the reference, so a corrected line can be uploaded again.
    fresh.cancelled = true;
    fresh.status = status;
    if (status === 'Deleted') {
      Object.assign(fresh, { deletedAt: now, deletedBy: by, deletedByName: byName, deleteReason: reason });
    } else {
      Object.assign(fresh, { cancelledAt: now, cancelledBy: by, cancelledByName: byName, cancelNote: reason });
    }
    await fresh.save(opts);
    return { line, result: { id: String(fresh._id), removedQty: out, receivedQty: fresh.receivedQty || 0 }, reason };
  }, { label: `upcoming-${verb}` });
};

export const cancelShipment = async ({ id, note, user, req }) => {
  const { line, result, reason } = await closeShipment({ id, note, user, status: 'Cancelled' });
  await recordAudit(user, 'Upcoming Shipment Cancelled', `${line.shipmentRef || "Entry without reference"} ${line.skuCode}: ${result.removedQty} unit(s) no longer expected.`, req, {
    meta: { shipmentId: result.id, cancelledQty: result.removedQty, note: reason },
  });
  return { id: result.id, cancelledQty: result.removedQty };
};

/**
 * Delete an upcoming stock entry that is no longer required (entered in error,
 * or not wanted any more). It leaves the list and every total at once.
 *
 * Kept as a 'Deleted' record rather than removed from the database: the audit
 * trail, and any receipts already counted against it, still point at it.
 */
export const deleteShipment = async ({ id, note, user, req }) => {
  const { line, result, reason } = await closeShipment({ id, note, user, status: 'Deleted' });
  await recordAudit(
    user,
    'Upcoming Shipment Deleted',
    `${line.shipmentRef || "Entry without reference"} ${line.skuCode}: entry deleted (${result.removedQty} unit(s) were still expected). Inventory unchanged.`,
    req,
    { meta: { shipmentId: result.id, removedQty: result.removedQty, receivedQty: result.receivedQty, note: reason } },
  );
  return { id: result.id, deletedQty: result.removedQty };
};

/**
 * Delete EVERY upcoming entry of one SKU — the table row's Delete. The SKU
 * leaves the list; the inventory is not touched (no ledger posting), exactly as
 * for a single entry. All or nothing, in one transaction.
 */
export const deleteSkuEntries = async ({ body, user, req }) => {
  const { brand, skuCode } = resolveSku(body, user);
  const reason = cleanText(body?.note, 300) || null;
  await syncUpcoming({ skuCodes: [skuCode] });

  const result = await runInTransaction(async (session) => {
    const opts = sessionOpts(session);
    const item = await lockItem(brand, skuCode, session);
    if (!item) throw fail(404, `${skuCode} has no upcoming stock recorded.`);
    const lines = await UpcomingShipment.find({ brand, skuCode, status: { $in: OPEN_SHIPMENT_STATUSES } }, null, opts);
    if (lines.length === 0) throw fail(409, `${skuCode} has no upcoming stock entries left to delete.`);
    const now = new Date();
    let removed = 0;
    for (const line of lines) {
      removed += outstandingOf(line);
      line.cancelledQty += outstandingOf(line);
      line.cancelled = true;
      line.status = 'Deleted';
      Object.assign(line, { deletedAt: now, deletedBy: user?._id ?? null, deletedByName: userName(user), deleteReason: reason });
      await line.save(opts);
    }
    return { skuCode, entries: lines.length, deletedQty: removed, refs: lines.map((l) => l.shipmentRef || "no reference") };
  }, { label: 'upcoming-delete-sku' });

  await recordAudit(
    user,
    'Upcoming Shipment Deleted',
    `${skuCode}: all ${result.entries} upcoming entr${result.entries === 1 ? 'y' : 'ies'} deleted `
    + `(${result.refs.join(', ')}; ${result.deletedQty} unit(s) were still expected). Inventory unchanged.`,
    req,
    { meta: { brand, skuCode, entries: result.entries, deletedQty: result.deletedQty, note: reason } },
  );
  return result;
};

const resolveSku = (body, user) => {
  const brand = canonicalBrand(body?.brand);
  const skuCode = cleanText(body?.skuCode, SKU_MAX);
  if (!brand || !skuCode) throw fail(400, 'Choose a SKU.');
  if (!canAccessBrand(user, brand)) throw fail(404, `${skuCode} has no upcoming stock recorded.`);
  return { brand, skuCode };
};

export default {
  syncUpcoming, listUpcoming, allocateFifo,
  validateImport, commitImport, updateShipment, cancelShipment, deleteShipment, deleteSkuEntries,
};
