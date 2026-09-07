/**
 * import-pricelist.js
 * -----------------------------------------------------------------------------
 * Load the Ko-ken pricelist workbook into Product.prices.
 *
 *   node scripts/import-pricelist.js                     # DRY RUN — reports, writes nothing
 *   node scripts/import-pricelist.js --apply             # write the prices
 *   node scripts/import-pricelist.js --file "../docs/Ko-ken Pricelist.xlsx"
 *   node scripts/import-pricelist.js --brand Koken
 *   node scripts/import-pricelist.js --apply --unmatched unmatched.csv
 *
 * DRY RUN IS THE DEFAULT, and that is deliberate. This runs against the live
 * catalogue and rewrites a commercial figure on up to eight thousand products;
 * the version of the command you type while working something out should be the
 * one that cannot do any of that.
 *
 * WHAT IT DOES NOT DO: create products. A pricelist row whose Item Code is not
 * in the catalogue is REPORTED, never inserted. A price is an attribute of a SKU
 * we stock, and a workbook of seven thousand rows is not a decision to stock
 * seven thousand SKUs. Use the Inventory Master import for that, then re-run
 * this and the new codes pick up their prices.
 *
 * SHEETS
 *   VENUS AUTOMATION / TRADER / END USER   Item Code  -> price
 *   MSIL                                   KO-KEN CODE -> price   (MARUTI CODE is
 *                                          the customer's own code and is
 *                                          already stored as Product.msilCode,
 *                                          so it is used only to cross-check)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { connectDatabase } = await import('../config/database.js');
const { Product } = await import('../models/Product.js');
const { PRICE_TYPES, asPrice } = await import('../config/pricing.js');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APPLY = has('--apply');
const BRAND = valueOf('--brand', 'Koken');
const FILE = path.resolve(
  __dirname, '..', '..',
  valueOf('--file', path.join('docs', 'Ko-ken Pricelist.xlsx')),
);
const UNMATCHED_OUT = valueOf('--unmatched', null);

/** Case- and space-insensitive key. Codes are typed by hand at both ends. */
const key = (v) => String(v ?? '').trim().toUpperCase();

/** The first header whose name looks like the price column on that sheet. */
const priceColumnOf = (row) =>
  Object.keys(row).find((k) => /price|inr/i.test(k)) ?? null;

const main = async () => {
  if (!fs.existsSync(FILE)) {
    console.error(`\nPricelist not found: ${FILE}\n`);
    process.exit(1);
  }

  console.log(`\nKo-ken pricelist -> Product.prices`);
  console.log(`  File   ${FILE}`);
  console.log(`  Brand  ${BRAND}`);
  console.log(`  Mode   ${APPLY ? 'APPLY — the catalogue will be written' : 'DRY RUN — nothing will be written'}\n`);

  const workbook = XLSX.readFile(FILE);

  /* ── Read every sheet into code -> price ──────────────────────────────── */
  // Read first, connect second: a malformed workbook should fail before it has
  // an open handle on the production database.
  const sheets = new Map();
  for (const type of PRICE_TYPES) {
    const sheet = workbook.Sheets[type.sheet];
    if (!sheet) {
      console.log(`  ! Sheet "${type.sheet}" is not in the workbook — ${type.label} prices will be left as they are.`);
      continue;
    }
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    if (!rows.length) {
      console.log(`  ! Sheet "${type.sheet}" is empty.`);
      continue;
    }

    // The MSIL schedule is keyed by the Ko-ken code; the other three by Item Code.
    const codeColumn = 'KO-KEN CODE' in rows[0] ? 'KO-KEN CODE' : 'Item Code';
    const priceColumn = priceColumnOf(rows[0]);
    if (!priceColumn) {
      console.log(`  ! Sheet "${type.sheet}" has no price column — skipped.`);
      continue;
    }

    const prices = new Map();
    let blankCode = 0;
    let blankPrice = 0;
    let conflicting = 0;
    for (const row of rows) {
      const code = key(row[codeColumn]);
      if (!code) { blankCode += 1; continue; }
      const price = asPrice(row[priceColumn]);
      if (price === null) { blankPrice += 1; continue; }
      // A repeated code with a DIFFERENT price is worth counting: the sheet is
      // then ambiguous about what the SKU costs, and the last row silently wins.
      if (prices.has(code) && prices.get(code) !== price) conflicting += 1;
      prices.set(code, price);
    }

    sheets.set(type.key, { type, prices, codeColumn, priceColumn });
    console.log(
      `  ${type.label.padEnd(18)} sheet "${type.sheet}": ${rows.length} rows, ${prices.size} priced codes`
      + ` (column "${priceColumn}")`
      + (blankCode ? `, ${blankCode} without a code` : '')
      + (blankPrice ? `, ${blankPrice} without a price` : '')
      + (conflicting ? `, ${conflicting} repeated codes disagreeing on price` : ''),
    );
  }

  if (!sheets.size) {
    console.error('\nNothing to import — no usable sheet in the workbook.\n');
    process.exit(1);
  }

  await connectDatabase();

  /* ── The catalogue side ───────────────────────────────────────────────── */
  const products = await Product.find({ brand: BRAND }, 'skuCode msilCode prices').lean();
  console.log(`\n  ${products.length} ${BRAND} products in the catalogue.`);
  if (!products.length) {
    console.error(`\nNo products for brand "${BRAND}" — check --brand.\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const bySku = new Map();
  for (const p of products) {
    // A duplicate code cannot happen — { brand, skuCode } is unique — so the
    // first writer wins and there is nothing to reconcile.
    if (!bySku.has(key(p.skuCode))) bySku.set(key(p.skuCode), p);
  }

  /* ── Match, and work out what would change ────────────────────────────── */
  const updates = new Map();   // skuCode -> { [pricesField]: value }
  const stats = new Map();     // type key -> counters
  const unmatched = [];

  for (const [typeKey, sheet] of sheets) {
    const counters = { matched: 0, changed: 0, same: 0, missing: 0 };
    for (const [code, price] of sheet.prices) {
      const product = bySku.get(code);
      if (!product) {
        counters.missing += 1;
        unmatched.push({ type: sheet.type.label, code, price });
        continue;
      }
      counters.matched += 1;
      const current = asPrice(product.prices?.[typeKey]);
      if (current === price) { counters.same += 1; continue; }
      counters.changed += 1;
      const patch = updates.get(product.skuCode) || {};
      patch[`prices.${typeKey}`] = price;
      updates.set(product.skuCode, patch);
    }
    stats.set(typeKey, counters);
  }

  console.log('\n  Type                Matched   New/Changed   Unchanged   Not in catalogue');
  console.log('  ' + '─'.repeat(76));
  for (const [typeKey, sheet] of sheets) {
    const c = stats.get(typeKey);
    console.log(
      '  ' + sheet.type.label.padEnd(20)
      + String(c.matched).padStart(7)
      + String(c.changed).padStart(14)
      + String(c.same).padStart(12)
      + String(c.missing).padStart(19),
    );
  }

  /* ── Coverage: the question the sales desk actually cares about ───────── */
  console.log('\n  Coverage across the catalogue:');
  for (const [typeKey, sheet] of sheets) {
    let covered = 0;
    for (const code of bySku.keys()) if (sheet.prices.has(code)) covered += 1;
    const pct = ((covered / bySku.size) * 100).toFixed(1);
    console.log(`    ${sheet.type.label.padEnd(20)} ${String(covered).padStart(5)} of ${bySku.size} ${BRAND} SKUs (${pct}%)`);
  }

  /* ── The MSIL cross-check ─────────────────────────────────────────────── */
  // The MSIL sheet carries the customer's own part number beside ours. We
  // already store that as msilCode, so disagreement means one of the two is
  // wrong — worth surfacing, never worth silently "fixing" from a price sheet.
  const msilSheet = workbook.Sheets.MSIL;
  if (msilSheet) {
    const rows = XLSX.utils.sheet_to_json(msilSheet, { defval: null });
    let agree = 0; let differ = 0; let noStored = 0; const examples = [];
    for (const row of rows) {
      const product = bySku.get(key(row['KO-KEN CODE']));
      if (!product) continue;
      const sheetCode = key(row['MARUTI CODE']);
      const stored = key(product.msilCode);
      if (!stored) { noStored += 1; continue; }
      if (stored === sheetCode) { agree += 1; continue; }
      differ += 1;
      if (examples.length < 5) examples.push(`${product.skuCode}: stored ${stored} / sheet ${sheetCode}`);
    }
    console.log(`\n  MSIL part numbers: ${agree} agree with the stored MSIL code, ${differ} differ, ${noStored} have none stored.`);
    for (const e of examples) console.log(`    - ${e}`);
    if (differ) console.log('    (left alone — this script only writes prices)');
  }

  /* ── Unmatched report ─────────────────────────────────────────────────── */
  if (unmatched.length) {
    console.log(`\n  ${unmatched.length} priced row(s) name a code that is not in the ${BRAND} catalogue. First 10:`);
    for (const u of unmatched.slice(0, 10)) console.log(`    - ${u.type.padEnd(18)} ${u.code}`);
    if (UNMATCHED_OUT) {
      const target = path.resolve(process.cwd(), UNMATCHED_OUT);
      fs.writeFileSync(
        target,
        'Price Type,Code,Price\n' + unmatched.map((u) => `${u.type},${u.code},${u.price}`).join('\n'),
      );
      console.log(`    Written in full to ${target}`);
    } else {
      console.log('    Use --unmatched <file.csv> to write the full list.');
    }
  }

  /* ── Write ────────────────────────────────────────────────────────────── */
  const productsToWrite = updates.size;
  const fieldsToWrite = [...updates.values()].reduce((n, p) => n + Object.keys(p).length, 0);

  if (!productsToWrite) {
    console.log('\n  Nothing to write — every matched price is already what the sheet says.\n');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(
      `\n  DRY RUN — ${fieldsToWrite} price(s) on ${productsToWrite} product(s) would be written.`
      + '\n  Re-run with --apply to write them.\n',
    );
    await mongoose.disconnect();
    return;
  }

  const operations = [...updates.entries()].map(([skuCode, patch]) => ({
    updateOne: {
      filter: { brand: BRAND, skuCode },
      update: { $set: patch },
    },
  }));

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < operations.length; i += CHUNK) {
    const chunk = operations.slice(i, i + CHUNK);
    const res = await Product.bulkWrite(chunk, { ordered: false });
    written += res.modifiedCount ?? 0;
    process.stdout.write(`\r  Writing… ${Math.min(i + CHUNK, operations.length)}/${operations.length}`);
  }
  console.log(`\n\n  Done. ${written} product(s) updated, ${fieldsToWrite} price field(s) written.\n`);

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error('\nThe import failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
