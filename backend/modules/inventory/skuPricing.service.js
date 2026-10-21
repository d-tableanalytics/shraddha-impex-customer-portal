import { Product } from '../../models/Product.js';
import { PRICE_TYPES, PRICE_TYPE_KEYS, asPrice, parsePriceInput } from '../../config/pricing.js';
import AuditLog from '../../models/AuditLog.js';
import { runInTransaction } from '../../utils/transaction.js';

/**
 * Maintaining the price schedule on the product master — one SKU from the
 * Update Stock dialog, or many through the SKU Pricing import.
 *
 * PRICES ONLY. Nothing here reads or writes a balance, the ledger or a planning
 * input, so a price update can never move stock. The write is a `$set` on
 * `prices.<type>` against an EXISTING { brand, skuCode } — never an upsert —
 * so it cannot create a SKU either.
 *
 * WHAT A PATCH MEANS. A patch names only the tiers it changes:
 *
 *   { trader: 120.5 }        set Trader, leave the other three alone
 *   { msil: null }           remove the MSIL price ("no price on file")
 *   {}                       nothing — refused as a no-op
 *
 * Zero is NOT a price. config/pricing.js treats null as "not priced" and the
 * picklist relies on that to avoid quoting a free line, so a 0 here is refused
 * rather than stored as something that reads like a deliberate figure.
 *
 * Everything in this file is behind MANAGE_PRICING. Prices are `select: false`
 * on the schema, so every read below names them explicitly.
 */

/**
 * Write the audit entry INSIDE the price write's transaction, and let a failure
 * throw. The shared recordAudit() swallows its own errors by design — right for
 * most callers, wrong here: a price change and its audit entry must land
 * together or not at all, so a failed audit write has to roll the prices back.
 */
const auditInTransaction = (session, actor, action, remarks, req, meta) => AuditLog.create(
  [{
    user: actor?._id || null,
    action,
    method: req?.method || 'SYSTEM',
    endpoint: req?.originalUrl || 'N/A',
    ipAddress: req?.ip || '127.0.0.1',
    userAgent: req?.headers?.['user-agent'] || 'ERP SYSTEM',
    remarks,
    meta,
  }],
  session ? { session } : {},
);

const fail = (message, status = 400, code = 'PRICING_ERROR') => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
};

const LABEL = new Map(PRICE_TYPES.map((t) => [t.key, t.label]));

/** The four tiers as the dialog shows them, current figure included. */
const shapePrices = (prices = {}) =>
  Object.fromEntries(PRICE_TYPE_KEYS.map((k) => [k, asPrice(prices?.[k])]));

/**
 * Validate a requested patch and resolve it to { key: price | null }.
 *
 * A blank ('' or null) clears the tier. Anything else must be a positive
 * amount; it is rounded to the paisa exactly as config/pricing.js reads it.
 * Unknown keys are refused rather than ignored — a misspelt tier silently
 * dropped is a price the user believes they set.
 */
export const parsePricePatch = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('prices must be an object of price type -> amount.');
  }
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PRICE_TYPE_KEYS.includes(key)) {
      fail(`Unknown price type "${key}". Expected one of: ${PRICE_TYPE_KEYS.join(', ')}.`);
    }
    const blank = value === null || value === undefined || String(value).trim() === '';
    if (blank) { patch[key] = null; continue; }
    const read = parsePriceInput(value);
    if (!read.ok) {
      fail(`${LABEL.get(key)} price: ${read.error}. Leave it blank to remove the price.`);
    }
    patch[key] = read.value;
  }
  return patch;
};

/** Just the tiers whose value would actually change, as { key: { from, to } }. */
export const diffPrices = (current = {}, patch = {}) => {
  const changes = {};
  for (const [key, to] of Object.entries(patch)) {
    const from = asPrice(current?.[key]);
    if (from !== to) changes[key] = { from, to };
  }
  return changes;
};

/**
 * What changed, for the audit trail — WHICH tiers, never the amounts.
 *
 * The audit log is shared with the Employee Portal, whose HRMS audit screen
 * shows every entry's remarks and meta to HR roles that hold no pricing
 * permission. A price written here would be readable there.
 */
const describeChanges = (changes) => Object.entries(changes)
  .map(([k, { to }]) => `${LABEL.get(k)}${to === null ? ' (removed)' : ''}`)
  .join(', ');
const tiersOf = (changes) => Object.entries(changes)
  .map(([k, { to }]) => ({ tier: k, removed: to === null }));

/** Current prices for one SKU, for the dialog. */
export const getSkuPricing = async ({ skuCode, brand }) => {
  const product = await Product.findOne(
    { skuCode, brand },
    'skuCode brand msilCode description status prices',
  ).lean();
  if (!product) fail(`${skuCode} was not found.`, 404, 'NOT_FOUND');

  return {
    skuCode: product.skuCode,
    brand: product.brand,
    msilCode: product.msilCode ?? null,
    itemDescription: product.description ?? null,
    status: product.status,
    currency: 'INR',
    priceTypes: PRICE_TYPES.map(({ key, label, description }) => ({ key, label, description })),
    prices: shapePrices(product.prices),
  };
};

/**
 * Update one SKU's prices.
 *
 * The comparison is against the figure read in this request, not one the
 * dialog was opened with, so the audit row records what was actually replaced.
 */
export const updateSkuPricing = async ({ skuCode, brand, prices, actor, req }) => {
  const patch = parsePricePatch(prices);
  if (Object.keys(patch).length === 0) fail('No price was given — nothing would change.');

  const product = await Product.findOne({ skuCode, brand }, 'skuCode brand prices').lean();
  if (!product) fail(`${skuCode} was not found.`, 404, 'NOT_FOUND');

  const changes = diffPrices(product.prices, patch);
  if (Object.keys(changes).length === 0) {
    fail('Those are the prices already on file — nothing would change.', 400, 'NO_CHANGE');
  }

  const $set = Object.fromEntries(Object.entries(changes).map(([k, c]) => [`prices.${k}`, c.to]));
  // The prices and their audit entry commit together, or neither does.
  await runInTransaction(async (session) => {
    await Product.updateOne({ _id: product._id }, { $set }, { runValidators: true, ...(session ? { session } : {}) });
    await auditInTransaction(
      session, actor, 'SKU Pricing Updated',
      `Prices updated for ${brand} ${skuCode}: ${describeChanges(changes)}.`, req,
      { skuCode, brand, tiers: tiersOf(changes), source: 'inventory-master' },
    );
  }, { label: 'sku-pricing' });

  return {
    ...(await getSkuPricing({ skuCode, brand })),
    changed: Object.keys(changes),
  };
};

/**
 * The SKU Pricing import's processor — one chunk of validated rows.
 *
 * Rows arrive already checked against the template: the SKU exists under the
 * brand, the brand is one the uploader may see, and every price cell is a
 * positive amount or blank. A blank cell is simply absent from the patch, so it
 * leaves that tier alone; an import never clears a price.
 *
 * Current prices for the whole chunk are read in ONE query, so each row can be
 * reported as updated or unchanged and the audit can say what was replaced. A
 * row whose figures already match is a success that writes nothing.
 */
export const processSkuPricing = async ({ rows, job, actor, req }) => {
  const successes = [];
  const failures = [];

  const keys = rows.map((r) => ({ skuCode: r.data.skuCode, brand: r.data.brand }));
  const current = await Product.find({ $or: keys }, 'skuCode brand prices').lean();
  const byKey = new Map(current.map((p) => [`${p.skuCode}::${p.brand}`, p]));

  const ops = [];
  const changed = [];
  for (const row of rows) {
    const { skuCode, brand } = row.data;
    const product = byKey.get(`${skuCode}::${brand}`);
    if (!product) {
      // Deleted between staging and confirming.
      failures.push({ rowNumber: row.rowNumber, reason: `${skuCode} is no longer in the catalogue under ${brand}.` });
      continue;
    }

    const patch = {};
    for (const key of PRICE_TYPE_KEYS) {
      const price = asPrice(row.data[key]);
      if (price !== null) patch[key] = price;
    }
    const changes = diffPrices(product.prices, patch);
    if (Object.keys(changes).length === 0) {
      successes.push({ rowNumber: row.rowNumber, result: { updated: [], unchanged: true } });
      continue;
    }

    const $set = Object.fromEntries(Object.entries(changes).map(([k, c]) => [`prices.${k}`, c.to]));
    ops.push({
      rowNumber: row.rowNumber,
      updated: Object.keys(changes),
      // Filtered by _id, never upserted: the import updates prices on SKUs that
      // exist and cannot create one.
      op: { updateOne: { filter: { _id: product._id }, update: { $set } } },
    });
    changed.push({ skuCode, brand, changes });
  }

  if (ops.length) {
    /*
     * ONE TRANSACTION PER CHUNK: the chunk's price writes and its audit entry
     * commit together or not at all. A process that dies half-way leaves this
     * chunk untouched — its rows are still pending, and resuming re-diffs them
     * against the prices on file, so nothing is written twice or left
     * unaudited.
     *
     * A write refused inside the transaction rolls the whole chunk back. Every
     * row in it is then reported as failed, with the reason, rather than some
     * rows changing prices that no audit entry mentions.
     */
    try {
      await runInTransaction(async (session) => {
        await Product.bulkWrite(ops.map((o) => o.op), { ordered: true, ...(session ? { session } : {}) });
        await auditInTransaction(
          session, actor, 'SKU Pricing Imported',
          `Import ${job.jobId} updated prices on ${changed.length} SKU(s).`, req,
          {
            jobId: job.jobId,
            source: 'sku-pricing-import',
            // Which SKUs and tiers — no amounts (see describeChanges).
            changes: changed.map((c) => ({ skuCode: c.skuCode, brand: c.brand, tiers: tiersOf(c.changes) })),
          },
        );
      }, { label: `sku-pricing ${job.jobId}` });
      for (const o of ops) successes.push({ rowNumber: o.rowNumber, result: { updated: o.updated, unchanged: false } });
    } catch (error) {
      // A row the database refused rolls the chunk back and is reported. Any
      // other failure (connection, timeout) is the job runner's to retry or stop.
      const refusedRow = Array.isArray(error?.writeErrors) || error?.code === 11000
        || error?.name === 'ValidationError' || error?.name === 'MongoBulkWriteError';
      if (!refusedRow) throw error;
      const reason = `Not saved — this batch of rows was rolled back: ${error.message}`;
      for (const o of ops) failures.push({ rowNumber: o.rowNumber, reason });
    }
  }

  return { successes, failures, refs: [] };
};

export default {
  parsePricePatch, diffPrices, getSkuPricing, updateSkuPricing, processSkuPricing,
};
