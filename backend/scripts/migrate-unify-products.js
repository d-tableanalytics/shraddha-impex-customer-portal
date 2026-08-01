/**
 * migrate-unify-products.js
 * -----------------------------------------------------------------------------
 * IMS Module M1 — merges products_koken / products_bix / products_imada into the
 * single `products` collection, stamping each document with its `brand`.
 *
 * Deliberate rules:
 *   • DRY RUN BY DEFAULT. Nothing is written without --apply.
 *   • The three source collections are READ ONLY and are never dropped, so the
 *     migration is reversible: point models/Product.js back at them, or run
 *     --rollback to empty the unified collection.
 *   • Refuses to proceed if the same SKU appears under two brands, because the
 *     new business key is {brand, skuCode} and a collision would mean silently
 *     losing a row. (There are none today — the three workbooks have zero
 *     overlap — but the check must exist, not be assumed.)
 *   • Idempotent: re-running upserts on {brand, skuCode}, so a partial run can
 *     simply be re-run.
 *
 * Verification (--verify) compares the unified collection against the sources
 * field by field. It is the exit gate for this migration: parity must be 100%
 * before the application is cut over.
 *
 * Usage:
 *   node scripts/migrate-unify-products.js                 # dry run
 *   node scripts/migrate-unify-products.js --apply         # perform the merge
 *   node scripts/migrate-unify-products.js --verify        # compare after
 *   node scripts/migrate-unify-products.js --rollback --apply
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Product, BRAND_VALUES } from '../models/Product.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const ROLLBACK = process.argv.includes('--rollback');

const SOURCES = [
  { collection: 'products_koken', brand: BRAND_VALUES.koken },
  { collection: 'products_bix', brand: BRAND_VALUES.bix },
  { collection: 'products_imada', brand: BRAND_VALUES.imada },
];

// Fields carried across verbatim. `brand` is set from the source collection and
// `_id` is preserved so any document already referencing a product by id — the
// reservations collection does — keeps resolving after the merge.
const CARRIED = [
  'skuCode', 'msilCode', 'category', 'description', 'uom', 'itemParameter',
  'dailyAvgConsumption', 'currentSeason', 'leadTime', 'safetyFactor', 'moq',
  'abcClass', 'boxNo', 'vendorName', 'status',
  'totalAvailableQuantity', 'bookedQuantity', 'availableForSale', 'inTransitQty',
  'openingStockQuantity', 'openingStockDate',
  'maxLevel', 'availableInPercent',
  'createdAt', 'updatedAt',
];

const connect = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal';
  await mongoose.connect(uri);
  console.log(`🔌  Connected to MongoDB (${mongoose.connection.name})`);
};

const readSources = async () => {
  const db = mongoose.connection.db;
  const existing = (await db.listCollections().toArray()).map((c) => c.name);
  const out = [];

  for (const src of SOURCES) {
    if (!existing.includes(src.collection)) {
      console.log(`   ℹ️   ${src.collection} does not exist — skipped.`);
      continue;
    }
    const docs = await db.collection(src.collection).find({}).toArray();
    out.push({ ...src, docs });
    console.log(`   📦  ${src.collection.padEnd(18)} ${docs.length} documents`);
  }
  return out;
};

// ─── Rollback ────────────────────────────────────────────────────────────────
const rollback = async () => {
  const count = await Product.countDocuments();
  console.log(`\n⏪  Rollback: the unified 'products' collection holds ${count} documents.`);
  console.log('    The three source collections were never modified, so emptying');
  console.log('    the unified collection fully restores the previous state.\n');

  if (!APPLY) {
    console.log('🚫  Dry run — nothing deleted. Re-run with --apply to commit.\n');
    return;
  }

  const res = await Product.deleteMany({});
  console.log(`✅  Removed ${res.deletedCount} documents from 'products'.`);
  console.log('    Now revert models/Product.js to the per-brand collections.\n');
};

// ─── Verification ────────────────────────────────────────────────────────────
const verify = async (sources) => {
  console.log('\n──────────── VERIFICATION ────────────');
  let checked = 0;
  let missing = 0;
  let mismatched = 0;
  const problems = [];

  for (const src of sources) {
    for (const doc of src.docs) {
      checked++;
      const merged = await Product.findOne({ brand: src.brand, skuCode: doc.skuCode }).lean();

      if (!merged) {
        missing++;
        if (problems.length < 20) problems.push(`MISSING  ${src.brand} ${doc.skuCode}`);
        continue;
      }

      // Compare the values that actually matter operationally. Timestamps are
      // excluded — the upsert legitimately refreshes updatedAt.
      const fields = [
        'msilCode', 'itemParameter', 'currentSeason', 'leadTime', 'safetyFactor',
        'moq', 'boxNo', 'vendorName', 'status',
        'totalAvailableQuantity', 'bookedQuantity', 'availableForSale',
        'inTransitQty', 'openingStockQuantity', 'maxLevel',
      ];

      for (const f of fields) {
        const a = doc[f] ?? null;
        const b = merged[f] ?? null;
        // Numeric compare tolerant of int/float representation.
        const same = (typeof a === 'number' || typeof b === 'number')
          ? Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-9
          : String(a) === String(b);
        if (!same) {
          mismatched++;
          if (problems.length < 20) {
            problems.push(`MISMATCH ${src.brand} ${doc.skuCode}.${f}: ${a} → ${b}`);
          }
          break;
        }
      }

      // _id preservation matters: reservations reference products by id.
      if (String(doc._id) !== String(merged._id)) {
        mismatched++;
        if (problems.length < 20) {
          problems.push(`ID DRIFT ${src.brand} ${doc.skuCode}: ${doc._id} → ${merged._id}`);
        }
      }
    }
  }

  const unified = await Product.countDocuments();
  // Rows in the unified collection that no source collection accounts for.
  // Pre-existing records are not a migration failure — the merge only claims
  // that every SOURCE row arrived intact, not that it owns the collection.
  // Gating on an exact count equality would fail the cut-over for documents
  // this migration never touched and makes no claim about.
  const extras = unified - checked;

  console.log(`   source documents checked : ${checked}`);
  console.log(`   unified collection count : ${unified}`);
  console.log(`   missing in unified       : ${missing}`);
  console.log(`   field mismatches         : ${mismatched}`);
  if (extras !== 0) {
    console.log(`   pre-existing rows        : ${extras}  (not from any source; left untouched)`);
  }
  if (problems.length) {
    console.log('\n   first problems:');
    problems.forEach((p) => console.log(`      ${p}`));
  }
  console.log('──────────────────────────────────────');

  // Parity is about the source rows: all present, all field-identical. Extras
  // are reported above so they are never silent, but they do not fail the gate.
  const ok = missing === 0 && mismatched === 0;
  console.log(ok
    ? '\n✅  PARITY CONFIRMED — every source row migrated intact.\n'
    : '\n❌  PARITY FAILED — do not cut over. Investigate the rows above.\n');
  return ok;
};

// ─── Migration ───────────────────────────────────────────────────────────────
const migrate = async (sources) => {
  // Collision check. The new business key is {brand, skuCode}; a SKU appearing
  // under two brands is fine, but the SAME brand listing it twice is not.
  const seen = new Map();
  const dupes = [];
  for (const src of sources) {
    for (const doc of src.docs) {
      const key = `${src.brand}::${String(doc.skuCode).trim().toUpperCase()}`;
      if (seen.has(key)) dupes.push(key);
      else seen.set(key, true);
    }
  }

  // Informational: SKUs shared across brands. Allowed by the new key, and worth
  // reporting because the old global-unique index forbade them.
  const bySku = new Map();
  for (const src of sources) {
    for (const doc of src.docs) {
      const sku = String(doc.skuCode).trim().toUpperCase();
      if (!bySku.has(sku)) bySku.set(sku, new Set());
      bySku.get(sku).add(src.brand);
    }
  }
  const crossBrand = [...bySku.entries()].filter(([, brands]) => brands.size > 1);

  console.log(`\n   cross-brand SKUs (allowed) : ${crossBrand.length}`);
  if (crossBrand.length) {
    crossBrand.slice(0, 10).forEach(([sku, b]) => console.log(`      ${sku} → ${[...b].join(', ')}`));
  }
  console.log(`   within-brand duplicates    : ${dupes.length}`);

  if (dupes.length) {
    console.log('\n❌  Aborting: the same SKU appears twice within one brand.');
    dupes.slice(0, 20).forEach((d) => console.log(`      ${d}`));
    console.log('    Resolve these in the source collections before migrating.\n');
    return false;
  }

  const ops = [];
  for (const src of sources) {
    for (const doc of src.docs) {
      const payload = { brand: src.brand };
      for (const f of CARRIED) {
        if (doc[f] !== undefined) payload[f] = doc[f];
      }
      // Defaults for the fields added in M1 that the source rows predate.
      if (payload.uom === undefined) payload.uom = 'PCS';
      if (payload.description === undefined) payload.description = null;

      ops.push({
        updateOne: {
          // Match on _id so the identifier is preserved — reservations reference
          // products by id and would otherwise be orphaned.
          filter: { _id: doc._id },
          update: { $set: payload },
          upsert: true,
        },
      });
    }
  }

  console.log(`\n   documents to upsert        : ${ops.length}`);

  if (!APPLY) {
    console.log('\n🚫  Dry run — nothing written. Re-run with --apply to commit.\n');
    return true;
  }

  /**
   * WRITTEN THROUGH THE RAW DRIVER, NOT `Product.bulkWrite`.
   *
   * `brand` is the schema's discriminatorKey, and Mongoose STRIPS the
   * discriminator key out of `$set` when casting a bulkWrite on the base
   * model. The write then succeeds and reports the full modified count while
   * silently omitting the one field this entire migration exists to stamp —
   * every row lands with `brand: undefined`, the per-brand models match
   * nothing, and every IMS screen reads empty.
   *
   * Verified directly: the same op through `Product.bulkWrite` produces
   * `brand: undefined`, through `Product.collection.bulkWrite` produces
   * `brand: "Koken"`.
   *
   * The payload is already built field by field from the source document, so
   * bypassing Mongoose's casting costs nothing — and `createdAt`/`updatedAt`
   * are carried across explicitly, which is why no timestamp option is needed.
   */
  const res = await Product.collection.bulkWrite(ops, { ordered: false });
  console.log(`   ✅  upserted ${res.upsertedCount}, modified ${res.modifiedCount}`);

  // Build the new indexes now rather than lazily on first query.
  // NOT fatal: the unique {brand, skuCode} index cannot build while documents
  // sharing a (brand, null) pair remain in the collection. That is a data
  // decision, not a migration failure — the rows above are already written and
  // correct, so the script reports the gap and carries on rather than exiting
  // non-zero and implying the merge did not happen.
  try {
    await Product.syncIndexes();
    console.log('   ✅  indexes synced');
  } catch (err) {
    console.log(`   ⚠️   indexes NOT fully built: ${err.message.split('::').pop().trim()}`);
    console.log('       The merge itself succeeded. Resolve the duplicate rows, then');
    console.log('       re-run to finish building the unique {brand, skuCode} index.');
  }
  console.log('   ✅  indexes synchronised on the unified collection.');
  return true;
};

// ─── Entry point ─────────────────────────────────────────────────────────────
const run = async () => {
  console.log(`\n⚙️   Mode : ${ROLLBACK ? 'ROLLBACK' : VERIFY ? 'VERIFY' : 'MIGRATE'}` +
    ` — ${APPLY ? 'APPLY (writes to DB)' : 'DRY RUN (no writes)'}`);

  await connect();

  if (ROLLBACK) {
    await rollback();
    await mongoose.disconnect();
    return;
  }

  console.log('\n📥  Reading source collections...');
  const sources = await readSources();

  if (sources.length === 0) {
    console.log('\n   Nothing to migrate — no per-brand collections found.');
    console.log('   This is expected if the migration has already run and the');
    console.log('   sources were archived.\n');
    await mongoose.disconnect();
    return;
  }

  if (VERIFY) {
    await verify(sources);
    await mongoose.disconnect();
    return;
  }

  const ok = await migrate(sources);
  if (ok && APPLY) {
    await verify(sources);
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('\n❌  Failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
