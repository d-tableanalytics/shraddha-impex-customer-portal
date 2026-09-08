import MsilCode from '../models/MsilCode.js';

/**
 * Keeping the MSIL allowlist in step with the product master.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * An MSIL code lives in two places. `Product.msilCode` says which code a SKU
 * answers to; a row in `msilcodes` says that code is one we accept orders
 * against. Booking checks the SECOND one:
 *
 *     const msilDoc = await MsilCode.findOne({ code: product.msilCode });
 *     if (!msilDoc || msilDoc.status !== 'Active') throw ...
 *
 * Every path that could set `Product.msilCode` — Add SKU, the planning edit,
 * the Inventory Master import — wrote the first and not the second. So a SKU
 * created with a brand-new MSIL code was born unbookable, and failed with
 * "MSIL Code ... is inactive or does not exist" the first time an MSIL customer
 * tried to order it. Nothing was wrong with the SKU; the allowlist had simply
 * never heard of it. Four Ko-ken SKUs added on 2026-09-07 hit exactly this.
 *
 * Registering here, from one helper the three write paths share, is what stops
 * the two drifting again.
 *
 * WHY $setOnInsert AND NOT $set
 *
 * The status is a GATE somebody can close. Setting a code to Inactive is how
 * the business withdraws it, and an ordinary edit to a product's description
 * must not quietly reopen a gate that was deliberately shut. So a new code is
 * inserted Active and an existing row is left exactly as it is — this helper
 * can only ever ADD a code, never re-enable one.
 *
 * WHY IT NEVER THROWS
 *
 * A SKU that was created successfully must not be reported as failed because a
 * secondary bookkeeping write did not land. The failure is logged loudly and
 * `scripts/sync-msil.js` repairs any gap — the same bargain recordAudit makes.
 */

const TAG = '[MsilRegistry]';

/** Trimmed, or null. Codes are typed by hand at both ends. */
const clean = (raw) => {
  const code = String(raw ?? '').trim();
  return code === '' ? null : code;
};

/**
 * Register one MSIL code, if it is not already known.
 *
 * @returns {Promise<{ code: string|null, added: boolean }>} `added` is true only
 *          when a row was actually created, so callers can report it.
 */
export const registerMsilCode = async (rawCode, { session = null } = {}) => {
  const code = clean(rawCode);
  if (!code) return { code: null, added: false };

  try {
    const res = await MsilCode.updateOne(
      { code },
      { $setOnInsert: { code, status: 'Active' } },
      { upsert: true, ...(session ? { session } : {}) },
    );
    const added = Boolean(res.upsertedCount);
    if (added) console.log(`${TAG} Registered MSIL code ${code} (Active).`);
    return { code, added };
  } catch (error) {
    // A duplicate key here means another writer registered the same code
    // between our read and our write, which is the outcome we wanted anyway.
    if (error?.code === 11000) return { code, added: false };
    console.error(`${TAG} Could not register MSIL code ${code}: ${error.message}`);
    return { code, added: false, error };
  }
};

/**
 * Register many at once — for the bulk import, where a sheet can introduce
 * dozens of codes and one round trip each would be dozens of round trips.
 *
 * Only the codes not already present are written, so a re-run of the same sheet
 * costs one read and no writes.
 *
 * @returns {Promise<{ added: string[], known: number }>}
 */
export const registerMsilCodes = async (rawCodes = [], { session = null } = {}) => {
  const codes = [...new Set(
    (Array.isArray(rawCodes) ? rawCodes : [rawCodes]).map(clean).filter(Boolean),
  )];
  if (!codes.length) return { added: [], known: 0 };

  try {
    const opts = session ? { session } : {};
    const existing = await MsilCode.find({ code: { $in: codes } }, 'code', opts).lean();
    const known = new Set(existing.map((d) => d.code));
    const missing = codes.filter((c) => !known.has(c));
    if (!missing.length) return { added: [], known: codes.length };

    await MsilCode.bulkWrite(
      missing.map((code) => ({
        updateOne: {
          filter: { code },
          update: { $setOnInsert: { code, status: 'Active' } },
          upsert: true,
        },
      })),
      { ordered: false, ...opts },
    );
    console.log(`${TAG} Registered ${missing.length} new MSIL code(s): ${missing.join(', ')}`);
    return { added: missing, known: known.size };
  } catch (error) {
    // ordered:false means the writes that could land, did. A duplicate-key
    // error is two importers racing on the same code, which is harmless.
    if (error?.code === 11000 || error?.writeErrors?.every((e) => e.code === 11000)) {
      return { added: [], known: codes.length };
    }
    console.error(`${TAG} Could not register MSIL codes: ${error.message}`);
    return { added: [], known: 0, error };
  }
};

export default { registerMsilCode, registerMsilCodes };
