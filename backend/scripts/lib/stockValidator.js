/**
 * Phase 5 — the database-level stock invariant.
 *
 * Phases 1 and 2 stop the application creating inconsistent rows; Phases 3 and
 * 4 repair the rows already inconsistent. This is what stops it coming back
 * from somewhere nobody is watching — a migration script, a mongosh session, a
 * future feature. Anything that writes `products` is held to the same rule as
 * the booking flow.
 *
 * $expr rather than $jsonSchema, because the constraint relates three fields to
 * each other and $jsonSchema can only describe fields in isolation.
 *
 * Documents carrying none of the three fields are exempt: `products` holds
 * catalogue rows that have never held stock, and refusing those would block
 * ordinary product edits for no gain.
 */
export const VALIDATOR = {
  $or: [
    {
      totalAvailableQuantity: { $exists: false },
      bookedQuantity: { $exists: false },
      availableForSale: { $exists: false },
    },
    {
      $expr: {
        $and: [
          { $gte: [{ $ifNull: ['$totalAvailableQuantity', 0] }, 0] },
          { $gte: [{ $ifNull: ['$bookedQuantity', 0] }, 0] },
          { $gte: [{ $ifNull: ['$availableForSale', 0] }, 0] },
          {
            $eq: [
              { $add: [{ $ifNull: ['$availableForSale', 0] }, { $ifNull: ['$bookedQuantity', 0] }] },
              { $ifNull: ['$totalAvailableQuantity', 0] },
            ],
          },
        ],
      },
    },
  ],
};

/**
 * `moderate` is deliberate.
 *
 * It applies the rule to inserts and to updates of documents that ALREADY
 * satisfy it, and leaves existing bad rows editable. `strict` would make a
 * known-bad row impossible to correct by hand, which is the opposite of what
 * is wanted while any remain.
 */
export const collModCommand = (action) => ({
  collMod: 'products',
  validator: action === 'off' ? {} : VALIDATOR,
  validationLevel: action === 'off' ? 'off' : 'moderate',
  validationAction: action === 'off' ? 'error' : action,
});

/** How many documents satisfy the rule today, and which do not. */
export const assess = async (db, { limit = 40 } = {}) => {
  const total = await db.collection('products').countDocuments({});
  const passing = await db.collection('products').countDocuments(VALIDATOR);
  const offenders = await db.collection('products').aggregate([
    { $match: { $nor: [VALIDATOR] } },
    {
      $project: {
        skuCode: 1,
        brand: 1,
        t: { $ifNull: ['$totalAvailableQuantity', 0] },
        b: { $ifNull: ['$bookedQuantity', 0] },
        a: { $ifNull: ['$availableForSale', 0] },
      },
    },
    { $limit: limit },
  ]).toArray();
  return { total, passing, failing: total - passing, offenders };
};

/** Read back what the collection currently enforces. */
export const currentValidation = async (db) => {
  const [info] = await db.listCollections({ name: 'products' }).toArray();
  return {
    hasValidator: Boolean(info?.options?.validator && Object.keys(info.options.validator).length),
    validationAction: info?.options?.validationAction ?? null,
    validationLevel: info?.options?.validationLevel ?? null,
  };
};

/**
 * Turn the rule on (or off).
 *
 * Refuses `error` while any document still fails, because enforcing a rule the
 * data does not yet satisfy turns the next legitimate edit of a broken row into
 * a customer-facing failure. `warn` is allowed at any time — that is the point
 * of having a warning stage.
 */
export const setValidation = async (db, action, { force = false } = {}) => {
  if (!['warn', 'error', 'off'].includes(action)) {
    throw new Error(`action must be warn, error or off — got "${action}"`);
  }
  if (action === 'error' && !force) {
    const { failing } = await assess(db, { limit: 1 });
    if (failing > 0) {
      throw new Error(
        `${failing} product document(s) still fail the invariant. Enforcing now would refuse `
        + 'their next legitimate write. Run Phase 4 first, or pass --force if you accept that.',
      );
    }
  }
  await db.command(collModCommand(action));
  return currentValidation(db);
};

export default { VALIDATOR, collModCommand, assess, currentValidation, setValidation };
