import { Product, createProductModel } from '../../models/Product.js';
import Order from '../../models/Order.js';
import Reservation from '../../models/Reservation.js';
import StockMovement from '../../models/StockMovement.js';
import StockBalance from '../../models/StockBalance.js';
import StockHealth from '../../models/StockHealth.js';
import StockCountLine from '../../models/StockCountLine.js';
import StockAdjustment from '../../models/StockAdjustment.js';
import InventoryAlert from '../../models/InventoryAlert.js';
import ProductDetail from '../../models/ProductDetail.js';
import { removeImageFile } from '../../middlewares/productImageUpload.js';
import { ALL_BRANDS } from '../../utils/brandAccess.js';

/**
 * SKU lifecycle — creating a catalogue entry and removing one.
 *
 * EDITING IS NOT HERE. It already lives in inventory.controller.js as
 * updatePlanning(), which validates every field, honours the box-number
 * permission, guards retirement against live stock and recomputes the health
 * band. A second edit path would be a second set of those rules to keep in
 * step, and the direction that drift fails in is a SKU whose band no longer
 * matches its own planning inputs.
 *
 * What was missing was the two ends of the life: bringing a SKU into the
 * catalogue, and taking one out. They are not symmetrical, and the asymmetry is
 * the substance of this file:
 *
 *   CREATING is cheap and reversible. It needs to refuse duplicates, because a
 *   second row for the same code is not a new product — it is two answers to
 *   "how much of this do we have".
 *
 *   DELETING is neither. A SKU code is a business key that orders, ledger
 *   movements, counts and reservations refer to BY NAME, not by document id.
 *   Removing the product does not remove those references; it makes them
 *   unresolvable. So a SKU anything has ever touched is REFUSED, and the caller
 *   is pointed at the status field, which is what "retire a SKU" has always
 *   meant here (BR-06, and the same rule reason codes follow in BR-24).
 *   Deletion is left for what it is actually for: undoing a row created by
 *   mistake five minutes ago.
 */

const fail = (message, status = 400, code = 'SKU_ERROR', extra = {}) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  throw err;
};

/**
 * A SKU code is a business key, so what may be in one is worth stating.
 *
 * Deliberately permissive about CONTENT — real codes here look like
 * `14405M-10`, `115G.100-10BK`, `S/C41` — and strict about the things that
 * break lookups: surrounding whitespace, empty, and absurd length.
 */
const normaliseSkuCode = (raw) => {
  const code = String(raw ?? '').trim();
  if (!code) fail('A SKU code is required.', 400, 'SKU_CODE_REQUIRED');
  if (code.length > 64) fail(`That SKU code is ${code.length} characters; the limit is 64.`, 400);
  // A code with an interior newline or tab reads as one thing on screen and
  // matches nothing, which is the worst kind of wrong.
  if (/[\r\n\t]/.test(code)) fail('A SKU code cannot contain line breaks or tabs.', 400);
  return code;
};

/** Escaped for an anchored, case-insensitive match. SKU codes are full of dots. */
const exactly = (value) => ({
  $regex: `^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  $options: 'i',
});

/**
 * Does this SKU already exist?
 *
 * Checked case-insensitively even though the index is not. `14405m-10` and
 * `14405M-10` are the same part to every human who will ever type either, and
 * letting both into the catalogue produces two rows that no report will ever
 * reconcile. The unique index would happily accept the pair.
 *
 * Exported because the Add form asks this question as you type, and asking it
 * twice in two ways is how the form and the save come to disagree.
 */
export const findExistingSku = async (skuCode, brand = null) => {
  const query = { skuCode: exactly(skuCode) };
  if (brand) query.brand = brand;
  return Product.findOne(query, 'skuCode brand description status msilCode').lean();
};

/**
 * What already uses this SKU code, and therefore what a duplicate would break.
 *
 * @returns {{ exists: boolean, sameBrand: object|null, otherBrands: object[], msilClash: object|null }}
 */
export const checkSkuAvailability = async ({ skuCode, brand, msilCode = null }) => {
  const code = normaliseSkuCode(skuCode);

  const matches = await Product.find(
    { skuCode: exactly(code) },
    'skuCode brand description status',
  ).lean();

  const sameBrand = matches.find((m) => m.brand === brand) ?? null;
  const otherBrands = matches.filter((m) => m.brand !== brand);

  /**
   * An MSIL code that already belongs to another SKU.
   *
   * Not blocked by any index, and it matters: the Fresh Inventory sheet finds a
   * product BY MSIL code when the SKU column is blank, and a code pointing at
   * two SKUs is reported as ambiguous and imports nothing. Better to refuse the
   * second one here than to leave an import that fails for reasons nobody can
   * see from the catalogue.
   */
  let msilClash = null;
  const msil = String(msilCode ?? '').trim();
  if (msil) {
    msilClash = await Product.findOne(
      { msilCode: exactly(msil), skuCode: { $ne: code } },
      'skuCode brand msilCode',
    ).lean();
  }

  return { exists: Boolean(sameBrand), sameBrand, otherBrands, msilClash };
};

/* ── Create ───────────────────────────────────────────────────────────────── */

/** Fields a new SKU may carry. Balances are absent on purpose — see BR-03. */
const CREATE_FIELDS = [
  'msilCode', 'description', 'uom', 'itemParameter', 'category',
  'vendorName', 'status', 'currentSeason',
  'leadTime', 'safetyFactor', 'moq',
];

export const createSku = async ({ payload = {}, actor, allowedBrandList }) => {
  const skuCode = normaliseSkuCode(payload.skuCode);

  const brand = ALL_BRANDS.find(
    (b) => b.toLowerCase() === String(payload.brand ?? '').trim().toLowerCase(),
  );
  if (!brand) {
    fail(`Brand must be one of ${ALL_BRANDS.join(', ')}.`, 400, 'BRAND_REQUIRED');
  }
  if (Array.isArray(allowedBrandList) && !allowedBrandList.includes(brand)) {
    fail(`You do not have access to ${brand}.`, 403, 'BRAND_FORBIDDEN');
  }

  // ── The duplicate check the requirement asks for ────────────────────────
  const availability = await checkSkuAvailability({ skuCode, brand, msilCode: payload.msilCode });

  if (availability.exists) {
    const found = availability.sameBrand;
    fail(
      `${found.skuCode} already exists under ${found.brand}`
      + `${found.description ? ` (${found.description})` : ''}. `
      + 'Edit that SKU instead of creating a second one.',
      409, 'SKU_EXISTS', { existing: found },
    );
  }

  if (availability.msilClash) {
    fail(
      `MSIL code ${payload.msilCode} already belongs to ${availability.msilClash.skuCode}. `
      + 'Two SKUs sharing one MSIL code cannot be told apart by the Fresh Inventory import.',
      409, 'MSIL_EXISTS', { existing: availability.msilClash },
    );
  }

  const doc = { skuCode };
  for (const field of CREATE_FIELDS) {
    if (!(field in payload)) continue;
    const value = payload[field];
    if (value === undefined) continue;
    doc[field] = value;
  }

  if ('category' in doc) {
    doc.category = Array.isArray(doc.category)
      ? doc.category.map((c) => String(c).trim()).filter(Boolean)
      : String(doc.category).split(',').map((c) => c.trim()).filter(Boolean);
  }
  for (const numeric of ['leadTime', 'safetyFactor', 'moq']) {
    if (!(numeric in doc)) continue;
    const n = Number(doc[numeric]);
    if (!Number.isFinite(n) || n < 0) fail(`${numeric} must be a number of zero or more.`, 400);
    doc[numeric] = n;
  }
  for (const text of ['msilCode', 'description', 'uom', 'itemParameter', 'vendorName']) {
    if (!(text in doc)) continue;
    const t = String(doc[text] ?? '').trim();
    doc[text] = t === '' ? null : t;
  }

  /**
   * The box number, on the rule the imports already follow.
   *
   * MANAGE_BOX_NUMBER exists to stop a SKU being MOVED between boxes by anyone
   * but an Admin. A SKU that does not exist yet has no mapping to disturb, so
   * setting its FIRST box is part of describing the new part — exactly as it is
   * on the Inventory Master sheet, which lets a new SKU carry its box for the
   * same reason. Moving it afterwards goes through updatePlanning(), which
   * enforces the permission.
   */
  if ('boxNo' in payload) {
    const box = String(payload.boxNo ?? '').trim();
    doc.boxNo = box === '' ? null : box;
  }

  // The brand discriminator stamps `brand` on write, so the branded model is
  // used rather than the base one — the same rule M1 and M9 follow.
  const Model = createProductModel(brand);
  let created;
  try {
    created = await Model.create(doc);
  } catch (error) {
    // The unique index is the last word. Losing a race to it is a duplicate
    // like any other, and is reported as one rather than as a 500.
    if (error?.code === 11000) {
      fail(
        `${skuCode} already exists under ${brand}. Edit that SKU instead.`,
        409, 'SKU_EXISTS',
      );
    }
    throw error;
  }

  return { product: created.toObject(), brand, warnings: availability.otherBrands.map((o) =>
    `${o.skuCode} also exists under ${o.brand}. A sheet that names this SKU without a brand `
    + 'cannot say which is meant, and the import will report it as ambiguous.') };
};

/* ── Rename ───────────────────────────────────────────────────────────────── */

/**
 * Change a SKU's CODE.
 *
 * WHY THIS IS NOT SIMPLY AN EDITABLE FIELD. The code is the business key.
 * Orders, reservations, stock counts and — above all — the stock ledger store it
 * as a STRING, not as a reference to the product document. Renaming the product
 * therefore does not rename those; it leaves them naming something that no
 * longer exists.
 *
 * The ledger settles it. `StockMovement` refuses `updateOne`, `updateMany`,
 * `findOneAndUpdate`, `replaceOne` and any save after insert, because a
 * movement is an immutable record and corrections are contra-entries. There is
 * no honest way to carry a rename into it, and going around that guard with the
 * raw driver would be doing exactly what it exists to prevent.
 *
 * So a rename is allowed while the SKU IS UNUSED — the same condition as
 * deletion, for the same reason — and refused once anything has transacted
 * against it. That covers what people actually need this for: correcting a code
 * that was mistyped when the SKU was created or imported, before it has been
 * ordered or moved. A SKU with history keeps its code and stays fully editable
 * in every other respect.
 *
 * The few soft references a never-transacted SKU can still have — its health
 * row, a zero balance, its product content — are carried across, so nothing is
 * orphaned.
 */
export const renameSku = async ({ skuCode, brand, newSkuCode, actor, allowedBrandList }) => {
  const product = await Product.findOne({ skuCode, brand }).lean();
  if (!product) fail(`${skuCode} was not found under ${brand}.`, 404, 'NOT_FOUND');

  if (Array.isArray(allowedBrandList) && !allowedBrandList.includes(product.brand)) {
    fail(`You do not have access to ${product.brand}.`, 403, 'BRAND_FORBIDDEN');
  }

  const nextCode = normaliseSkuCode(newSkuCode);
  if (nextCode === product.skuCode) {
    fail('That is already the SKU code.', 400, 'SKU_UNCHANGED');
  }

  /**
   * The new code must be free — but a CASE-ONLY change is a legitimate rename
   * (`14405m-10` → `14405M-10`), and the row that would "clash" is this one.
   * Excluding self by document id rather than by code is what makes that work.
   */
  const clash = await Product.findOne(
    { skuCode: exactly(nextCode), brand: product.brand, _id: { $ne: product._id } },
    'skuCode brand description',
  ).lean();
  if (clash) {
    fail(
      `${clash.skuCode} already exists under ${clash.brand}`
      + `${clash.description ? ` (${clash.description})` : ''}. Choose a different code.`,
      409, 'SKU_EXISTS', { existing: clash },
    );
  }

  const refs = await skuReferences({ skuCode: product.skuCode, brand: product.brand });
  if (!refs.deletable) {
    fail(
      `${product.skuCode} cannot be renamed — it is referenced by ${refs.blocking.join(', ')}. `
      + 'Those records store the SKU code as text, and the stock ledger is append-only, so a '
      + 'rename cannot be carried into them. Everything else about this SKU stays editable; '
      + 'to retire the code itself, set the status to Discontinued and create the SKU under '
      + 'the correct code.',
      409, 'SKU_IN_USE', { references: refs },
    );
  }

  const from = product.skuCode;

  /**
   * Alerts are CLOSED rather than renamed.
   *
   * `skuCode` is on the alert's immutable list — an alert is a record that a
   * condition was seen for a named thing, and rewriting that name is exactly
   * what the immutability guard is there to stop. Closing takes the stale one
   * off the open list; the engine raises a fresh one under the new code on the
   * next recompute if the condition still holds.
   */
  const closedAlerts = await InventoryAlert.updateMany(
    { skuCode: from, brand: product.brand, status: { $in: ['Open', 'Acknowledged'] } },
    { $set: { status: 'Closed', closedAt: new Date(), closedBy: actor?._id ?? null } },
  );

  // The product FIRST: if anything below fails, the catalogue already holds the
  // new code and the projections are rebuildable from it. The other order would
  // leave projections naming a code the catalogue does not have.
  await Product.updateOne({ _id: product._id }, { $set: { skuCode: nextCode } });

  const carried = {
    balances: (await StockBalance.updateMany(
      { skuCode: from, brand: product.brand }, { $set: { skuCode: nextCode } },
    )).modifiedCount ?? 0,
    health: (await StockHealth.updateMany(
      { skuCode: from, brand: product.brand }, { $set: { skuCode: nextCode } },
    )).modifiedCount ?? 0,
    productDetail: (await ProductDetail.updateMany(
      { skuCode: from }, { $set: { skuCode: nextCode } },
    )).modifiedCount ?? 0,
    alertsClosed: closedAlerts.modifiedCount ?? 0,
  };

  return { from, to: nextCode, brand: product.brand, carried };
};

/* ── Delete ───────────────────────────────────────────────────────────────── */

/**
 * Everything that would be left pointing at nothing if this SKU were removed.
 *
 * Counted rather than merely detected, because "you cannot delete this" is a
 * refusal and "you cannot delete this, it is on 3 bookings and 47 stock
 * movements" is an explanation.
 */
export const skuReferences = async ({ skuCode, brand }) => {
  const key = { skuCode, brand };

  const [orders, reservations, movements, countLines, adjustments, balance] = await Promise.all([
    Order.countDocuments({ skuCode, brand }),
    Reservation.countDocuments({ skuCode }),
    StockMovement.countDocuments(key),
    StockCountLine.countDocuments(key),
    StockAdjustment.countDocuments(key),
    StockBalance.aggregate([
      { $match: key },
      { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' } } },
    ]),
  ]);

  const onHand = balance[0]?.onHand ?? 0;
  const reserved = balance[0]?.reserved ?? 0;

  // Each entry is a reason the SKU is part of the business's history. A zero
  // balance is NOT one — a SKU that has never moved has a zero row like any
  // other, and that row is a projection rather than a record of anything.
  const blocking = [
    orders && `${orders} booking line(s)`,
    reservations && `${reservations} reservation(s)`,
    movements && `${movements} stock movement(s)`,
    countLines && `${countLines} stock count line(s)`,
    adjustments && `${adjustments} adjustment(s)`,
    onHand !== 0 && `${onHand} unit(s) on hand`,
    reserved > 0 && `${reserved} unit(s) reserved`,
  ].filter(Boolean);

  return {
    blocking,
    deletable: blocking.length === 0,
    counts: { orders, reservations, movements, countLines, adjustments, onHand, reserved },
  };
};

/**
 * Remove a SKU that nothing has ever used.
 *
 * Refuses anything with history and says what the history is, because the
 * answer to "I need this gone" is almost always Discontinued rather than
 * deleted — and a refusal that does not say so just gets retried.
 */
export const deleteSku = async ({ skuCode, brand, actor, allowedBrandList }) => {
  const product = await Product.findOne({ skuCode, brand }).lean();
  if (!product) fail(`${skuCode} was not found under ${brand}.`, 404, 'NOT_FOUND');

  if (Array.isArray(allowedBrandList) && !allowedBrandList.includes(product.brand)) {
    fail(`You do not have access to ${product.brand}.`, 403, 'BRAND_FORBIDDEN');
  }

  const refs = await skuReferences({ skuCode: product.skuCode, brand: product.brand });
  if (!refs.deletable) {
    fail(
      `${product.skuCode} cannot be deleted — it is referenced by ${refs.blocking.join(', ')}. `
      + 'Records refer to a SKU by its code, so removing it would leave them pointing at nothing. '
      + 'Set the status to Discontinued instead, which retires it without breaking its history.',
      409, 'SKU_IN_USE', { references: refs },
    );
  }

  /**
   * What goes with it.
   *
   * These are PROJECTIONS AND CONTENT, not records: a health band and a zero
   * balance are derived from a product that is about to stop existing, and
   * leaving them behind means the Health screen lists a SKU the catalogue does
   * not have. The product detail — description, photographs, videos — is
   * content attached to this SKU and nothing else.
   *
   * The image FILES are removed too. Deleting only the row would leave the
   * bytes on disk with nothing referencing them, which is invisible and
   * therefore permanent.
   */
  const detail = await ProductDetail.findOne({ skuCode: product.skuCode }).lean();
  for (const image of detail?.images ?? []) {
    await removeImageFile(image.imageId, image.extension);
  }

  /**
   * Alerts are CLOSED, not deleted — the model refuses deletion outright
   * ("Alerts cannot be deleted … Close the alert instead") because an alert is
   * a record that a condition was observed, and that remains true whatever
   * happens to the SKU afterwards. Closing takes it off the open list, which is
   * the only part that would otherwise dangle.
   *
   * `updateMany` rather than a save loop: the guard is on the delete hooks, and
   * a status change is exactly the sanctioned operation.
   */
  const closedAlerts = await InventoryAlert.updateMany(
    { skuCode: product.skuCode, brand: product.brand, status: { $in: ['Open', 'Acknowledged'] } },
    {
      $set: {
        status: 'Closed',
        closedAt: new Date(),
        closedBy: actor?._id ?? null,
      },
    },
  );

  const removed = {
    balances: (await StockBalance.deleteMany({ skuCode: product.skuCode, brand: product.brand })).deletedCount,
    health: (await StockHealth.deleteMany({ skuCode: product.skuCode, brand: product.brand })).deletedCount,
    alertsClosed: closedAlerts.modifiedCount ?? 0,
    productDetail: (await ProductDetail.deleteMany({ skuCode: product.skuCode })).deletedCount,
    images: detail?.images?.length ?? 0,
  };

  // The product LAST, so a failure part-way through leaves the catalogue entry
  // in place with some projections missing — which the next health rebuild
  // repairs — rather than a live SKU with no product behind it.
  await Product.deleteOne({ _id: product._id });

  return { product, removed };
};

export default {
  checkSkuAvailability, findExistingSku, createSku, renameSku, deleteSku, skuReferences,
};
