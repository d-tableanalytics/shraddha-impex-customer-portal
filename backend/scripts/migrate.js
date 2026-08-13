import mongoose from 'mongoose';
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// ─── Resolve __dirname for ES Modules ────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Load environment variables from backend/.env ────────────────────────────
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ─── Import Mongoose Models ───────────────────────────────────────────────────
import { ProductKoken, ProductBIX, ProductIMADA } from '../models/Product.js';
import { normaliseSeason, describeSeasonIssues } from '../utils/productFields.js';
import { stripBlocked } from '../utils/mailRecipients.js';
import User  from '../models/User.js';
import Order from '../models/Order.js';

const args   = process.argv.slice(2);
const getArg = (name) => {
  const match = args.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=').replace(/^"|"$/g, '') : null;
};

// Base path: the Koken workbook is used as the combined source
const BASE_FILE = getArg('file') ||
  "C:\\Users\\angel\\OneDrive\\Desktop\\Customer portal module\\Pankaj's Copy of IMS By D Table (koken).xlsx";

// Allow per-brand overrides if separate files exist; fall back to BASE_FILE
const KOKEN_FILE = getArg('koken')  || BASE_FILE;
const BIX_FILE   = getArg('bix')    || "C:\\Users\\angel\\OneDrive\\Desktop\\Customer portal module\\Pankaj's Copy of IMS By D Table (Bix).xlsx";
const IMADA_FILE = getArg('imada')  || "C:\\Users\\angel\\OneDrive\\Desktop\\Customer portal module\\Pankaj's Copy of IMS By D Table (IMADA).xlsx";
const USER_FILE  = getArg('users')  || BASE_FILE;   // auth sheet lives in the same workbook
const ORDER_FILE = getArg('orders') || BASE_FILE;   // Orders sheet lives in the same workbook

// Retain COMBINED_FILE for backward-compatibility with main() logic
const COMBINED_FILE = null;

// ─── Sheet Name Constants ─────────────────────────────────────────────────────
const SHEET_KOKEN  = 'Inventory - Koken';
const SHEET_BIX    = 'Inventory - BIX';
const SHEET_IMADA  = 'Inventory - IMADA';
const SHEET_AUTH   = 'auth';
const SHEET_ORDERS = 'Orders';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Safely converts a value to a JS Date.
 * Handles: JS Date objects (from cellDates:true), ISO strings, null/blank.
 */
const toDate = (val) => {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * Splits a comma-separated string into a trimmed array.
 * Returns empty array for null/blank values.
 */
const toArray = (val) => {
  if (!val) return [];
  return String(val).split(',').map(s => s.trim()).filter(Boolean);
};

/**
 * Converts a value to a Boolean.
 * Handles: true/false, "TRUE"/"FALSE" strings, 1/0.
 */
const toBool = (val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number')  return val === 1;
  return String(val).trim().toLowerCase() === 'true';
};

/**
 * Coerces a value to a Number; returns 0 if invalid.
 */
const toNum = (val) => {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
};

/**
 * Returns a trimmed string or null for empty/blank values.
 */
const toStr = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
};

/**
 * Reads an Excel workbook with cellDates enabled to avoid serial-date issues.
 * Throws a descriptive error if the file does not exist.
 */
const readWorkbook = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return XLSX.readFile(filePath, { cellDates: true });
};

/**
 * Extracts a worksheet by name, throws if missing.
 */
const getSheet = (workbook, sheetName, filePath) => {
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    throw new Error(`Sheet "${sheetName}" not found in ${path.basename(filePath)}`);
  }
  return ws;
};

/**
 * Maps a raw product status string to the schema enum value.
 */
const mapProductStatus = (val) => {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'inactive')     return 'Inactive';
  if (s === 'discontinued') return 'Discontinued';
  return 'Active';
};

/**
 * Maps an order status string to the schema enum value.
 */
const mapOrderStatus = (val) => {
  const s = String(val || '').trim().toLowerCase();
  if (s === 'dispatched') return 'Dispatched';
  if (s === 'cancelled')  return 'Cancelled';
  if (s === 'delivered')  return 'Delivered';
  return 'Booked';
};

// =============================================================================
// DATABASE CONNECTION
// =============================================================================

const connectMongo = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/erp_portal';
  await mongoose.connect(uri);
  console.log(`\n✅  Connected to MongoDB: ${mongoose.connection.host}\n`);
};

// =============================================================================
// 1. MIGRATE PRODUCTS
// =============================================================================

/**
 * Reads a product Inventory sheet and inserts documents into the given Model.
 *
 * @param {string} filePath   - Absolute path to the Excel file
 * @param {string} sheetName  - Name of the worksheet (e.g. "Inventory - Koken")
 * @param {Model}  Model      - Mongoose model (ProductKoken / ProductBIX / ProductIMADA)
 * @param {string} brandLabel - Human-readable brand name for logging
 */
export const migrateProducts = async (filePath, sheetName, Model, brandLabel) => {
  console.log(`📦  Migrating ${brandLabel} Products...`);

  const workbook = readWorkbook(filePath);
  const ws       = getSheet(workbook, sheetName, filePath);

  // range: 1 → skip the top banner row, treat row 2 as headers
  const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: null });

  const docs = [];
  const seasonIssues = [];
  let skipped = 0;

  for (const row of rows) {
    const skuCode = toStr(row['SKU Code']);

    // Skip padded empty rows
    if (!skuCode) { skipped++; continue; }

    docs.push({
      skuCode,
      msilCode:              toStr(row['MSIL Code']),
      category:              toArray(row['Category']),          // comma-separated → array
      // The actual Excel header contains a newline: "Item Parameter\n(Optional)"
      itemParameter:         toStr(row['Item Parameter\n(Optional)']) ?? toStr(row['Item Parameter (Optional)']),  // handle both formats
      dailyAvgConsumption: {
        low:    toNum(row['Daily Avg Consumption (Low)']),
        normal: toNum(row['Daily Avg Consumption (Normal)']),
        peak:   toNum(row['Daily Avg Consumption (Peak)']),
      },
      currentSeason:         (() => {
        // insertMany runs validators, so an unmapped value would throw partway
        // through the insert. Validate first and report the whole set instead.
        const season = normaliseSeason(row['Current Season']);
        if (!season.ok) seasonIssues.push({ sku: skuCode, raw: season.raw });
        return season.value;
      })(),
      leadTime:              toNum(row['Lead Time']),
      safetyFactor:          toNum(row['Safety Factor']),
      maxLevel:              toNum(row['Max Level']),
      openingStockQuantity:  row['Opening Stock Quantity'] != null ? toNum(row['Opening Stock Quantity']) : null,
      totalAvailableQuantity: toNum(row['Total Available Quantity']),
      availableInPercent:    toNum(row['Available in %']),
      openingStockDate:      toDate(row['Opening Stock Date']),
      bookedQuantity:        toNum(row['Booked Quantity']),
      availableForSale:      toNum(row['Available for Sale']),
      moq:                   toNum(row['MOQ']),
      boxNo:                 toStr(row['Box No']),
      status:                mapProductStatus(row['Status']),
      inTransitQty:          toNum(row['In-Transit Qty']),
      vendorName:            toStr(row['Vendor Name']),
    });
  }

  const seasonReport = describeSeasonIssues(seasonIssues);
  if (seasonReport) {
    console.log(`   ❌  ${seasonReport}`);
    seasonIssues.slice(0, 10).forEach(i => console.log(`      ${i.sku}: "${i.raw}"`));
    throw new Error(`${brandLabel}: invalid "Current Season" values — nothing was imported.`);
  }

  // Deduplicate by skuCode — keep the last occurrence when the Excel data has repeats
  const uniqueDocs = [...new Map(docs.map(d => [d.skuCode, d])).values()];
  const dupCount   = docs.length - uniqueDocs.length;
  if (dupCount > 0) console.log(`   ℹ️   ${dupCount} duplicate SKU rows removed before insert`);

  // Clear collection before inserting to avoid duplicates on re-run
  await Model.deleteMany({});

  if (uniqueDocs.length === 0) {
    console.log(`   ⚠️  No valid rows found for ${brandLabel}. Skipped ${skipped} empty rows.\n`);
    return 0;
  }

  const result = await Model.insertMany(uniqueDocs, { ordered: false });
  console.log(`   ✅  Inserted ${result.length} ${brandLabel} Products  (${skipped} empty rows skipped)\n`);
  return result.length;
};

// =============================================================================
// 2. MIGRATE USERS
// =============================================================================

/**
 * Reads the "auth" sheet and inserts User documents.
 * NOTE: Headers in the auth sheet start on row 1 (no banner row).
 *
 * @param {string} filePath - Absolute path to the Excel file containing "auth" sheet
 */
export const migrateUsers = async (filePath) => {
  console.log('👤  Migrating Users...');

  const workbook = readWorkbook(filePath);
  const ws       = getSheet(workbook, SHEET_AUTH, filePath);

  // range: 0 → headers on row 1 (default behaviour)
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const docs = [];
  const seasonIssues = [];
  let skipped = 0;

  for (const row of rows) {
    const email = toStr(row['EMAIL']);
    if (!email) { skipped++; continue; }

    // Booking CC Emails: split comma-separated string into array, minus any
    // address on the mail blocklist — the sheet still carries addresses that
    // must not be copied on customer mail, and re-importing it would restore
    // them.
    const bookingCcEmails = stripBlocked(toArray(row['Booking CC Emails']));

    // Brand access: Excel stores TRUE/FALSE or 1/0
    const brandAccess = {
      koken: toBool(row['KOKEN']),
      bix:   toBool(row['BIX']),
      imada: toBool(row['IMADA']),
    };

    docs.push({
      email:           email.toLowerCase(),
      password:        toStr(row['PASSWORD']) || '',   // Plaintext — TODO: hash with bcrypt when ready
      company:         toStr(row['COMPANY']),
      user:            toStr(row['USER']),
      role:            toStr(row['ROLE']) === 'Admin' ? 'Admin' : 'Customer',
      brandAccess,
      moq:             toStr(row['MOQ']),             // String to support "SKIP"
      showMsilCode:    toBool(row['Show MSIL Code']),
      bookingCcEmails,
      status:          'Active',
    });
  }

  await User.deleteMany({});

  if (docs.length === 0) {
    console.log(`   ⚠️  No valid user rows found. Skipped ${skipped} empty rows.\n`);
    return 0;
  }

  const result = await User.insertMany(docs, { ordered: false });
  console.log(`   ✅  Inserted ${result.length} Users  (${skipped} empty rows skipped)\n`);
  return result.length;
};

// =============================================================================
// 3. MIGRATE ORDERS (with automatic brand detection)
// =============================================================================

/**
 * Reads the "Orders" sheet and inserts Order documents.
 *
 * Brand is NOT present in the sheet — it is detected automatically:
 *   1. Search ProductKoken  → brand = "Koken"
 *   2. Search ProductBIX   → brand = "BIX"
 *   3. Search ProductIMADA → brand = "IMADA"
 *   4. Not found           → log warning, skip row
 *
 * @param {string} filePath - Absolute path to the Excel file containing "Orders" sheet
 */
export const migrateOrders = async (filePath) => {
  console.log('📋  Migrating Orders...');

  const workbook = readWorkbook(filePath);
  const ws       = getSheet(workbook, SHEET_ORDERS, filePath);

  // range: 0 → headers on row 1 (Orders sheet has no banner row)
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

  const docs    = [];
  let skipped   = 0;
  let noUser    = 0;
  let noBrand   = 0;

  // Build a user email → ObjectId lookup map for fast resolution
  const allUsers  = await User.find({}).select('_id email').lean();
  const userMap   = new Map(allUsers.map(u => [u.email.toLowerCase(), u._id]));

  // Fallback user: first Admin account
  const adminUser = await User.findOne({ role: 'Admin' }).select('_id').lean();

  for (const row of rows) {
    const orderId = toStr(row['Order ID']);
    const skuCode = toStr(row['SKU Code']);

    // Skip rows missing the two required fields
    if (!orderId || !skuCode) { skipped++; continue; }

    // ── Brand detection ────────────────────────────────────────────────────
    let brand = null;

    const kokenProduct = await ProductKoken.findOne({ skuCode }).select('_id').lean();
    if (kokenProduct) {
      brand = 'Koken';
    } else {
      const bixProduct = await ProductBIX.findOne({ skuCode }).select('_id').lean();
      if (bixProduct) {
        brand = 'BIX';
      } else {
        const imadaProduct = await ProductIMADA.findOne({ skuCode }).select('_id').lean();
        if (imadaProduct) {
          brand = 'IMADA';
        }
      }
    }

    if (!brand) {
      console.warn(`   ⚠️  SKU "${skuCode}" (Order ID: ${orderId}) not found in any brand collection — skipping row`);
      noBrand++;
      continue;
    }

    // ── User resolution ────────────────────────────────────────────────────
    const emailRaw  = toStr(row['Email id']);
    const emailKey  = emailRaw ? emailRaw.toLowerCase() : null;
    const userId    = (emailKey && userMap.has(emailKey))
                      ? userMap.get(emailKey)
                      : adminUser?._id ?? null;

    if (!userId) {
      console.warn(`   ⚠️  No user found for email "${emailRaw}" (Order ID: ${orderId}) and no Admin fallback — skipping row`);
      noUser++;
      continue;
    }

    docs.push({
      brand,
      user:            userId,
      status:          mapOrderStatus(row['Status']),
      orderTimestamp:  toDate(row['Timestamp']),
      company:         toStr(row['Company']),
      role:            toStr(row['Role']),
      orderId,
      date:            toDate(row['Date']),
      skuCode,
      category:        toStr(row['Category']),          // single string on Orders sheet
      requestedQty:    toNum(row['Requested Qty']),
      poNumber:        toStr(row['PO Number']),
      remarks:         toStr(row['Remarks']),
      expiryNotified:  toBool(row['Expiry Notified']),
      uniqueId:        toStr(row['Unique ID']),
      statusTimestamp: toDate(row['Status_Timestamp']),
      msilCode:        toStr(row['MSIL CODE']),
      poDate:          toDate(row['PO Date']),
      supplyByDate:    toDate(row['SupplyByDate']),
      boxNo:           toStr(row['boxNo']),
      location:        toStr(row['Location']),
      vendorCode:      toStr(row['Vendor code']),
      emailId:         emailRaw,
      phoneNumber:     toStr(row['Phone Number']),
    });
  }

  // Deduplicate by orderId — keep the last occurrence when the sheet has repeats
  const uniqueOrders = [...new Map(docs.map(d => [d.orderId, d])).values()];
  const dupOrders    = docs.length - uniqueOrders.length;
  if (dupOrders > 0) console.log(`   ℹ️   ${dupOrders} duplicate Order ID rows removed before insert`);

  await Order.deleteMany({});

  if (uniqueOrders.length === 0) {
    console.log(`   ⚠️  No valid order rows to insert.\n`);
    return 0;
  }

  const result = await Order.insertMany(uniqueOrders, { ordered: false });
  console.log(`   ✅  Inserted ${result.length} Orders`);
  if (skipped > 0) console.log(`   ℹ️   ${skipped} rows skipped (missing Order ID or SKU)`);
  if (noBrand  > 0) console.log(`   ⚠️  ${noBrand} rows skipped (SKU not found in any brand collection)`);
  if (noUser   > 0) console.log(`   ⚠️  ${noUser} rows skipped (no matching user and no Admin fallback)`);
  console.log();
  return result.length;
};

// =============================================================================
// MAIN — orchestrates the full migration
// =============================================================================

const main = async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Shardha Impex ERP — Excel to MongoDB Migration   ');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Connect to MongoDB ─────────────────────────────────────────────────────
  try {
    await connectMongo();
  } catch (err) {
    console.error('❌  Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  const summary = { products: 0, users: 0, orders: 0, errors: [] };

  // ── 1. Migrate Koken Products ─────────────────────────────────────────────
  try {
    const src = COMBINED_FILE ?? KOKEN_FILE;
    summary.products += await migrateProducts(src, SHEET_KOKEN, ProductKoken, 'Koken');
  } catch (err) {
    console.error('❌  Koken product migration failed:', err.message, '\n');
    summary.errors.push(`Koken products: ${err.message}`);
  }

  // ── 2. Migrate BIX Products ───────────────────────────────────────────────
  try {
    const src = COMBINED_FILE ?? BIX_FILE;
    summary.products += await migrateProducts(src, SHEET_BIX, ProductBIX, 'BIX');
  } catch (err) {
    console.error('❌  BIX product migration failed:', err.message, '\n');
    summary.errors.push(`BIX products: ${err.message}`);
  }

  // ── 3. Migrate IMADA Products ─────────────────────────────────────────────
  try {
    const src = COMBINED_FILE ?? IMADA_FILE;
    summary.products += await migrateProducts(src, SHEET_IMADA, ProductIMADA, 'IMADA');
  } catch (err) {
    console.error('❌  IMADA product migration failed:', err.message, '\n');
    summary.errors.push(`IMADA products: ${err.message}`);
  }

  // ── 4. Migrate Users ──────────────────────────────────────────────────────
  // Users MUST be migrated before Orders (brand detection builds the userMap)
  try {
    summary.users = await migrateUsers(USER_FILE);
  } catch (err) {
    console.error('❌  User migration failed:', err.message, '\n');
    summary.errors.push(`Users: ${err.message}`);
  }

  // ── 5. Migrate Orders ─────────────────────────────────────────────────────
  try {
    summary.orders = await migrateOrders(ORDER_FILE);
  } catch (err) {
    console.error('❌  Order migration failed:', err.message, '\n');
    summary.errors.push(`Orders: ${err.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Products inserted : ${summary.products}`);
  console.log(`  Users inserted    : ${summary.users}`);
  console.log(`  Orders inserted   : ${summary.orders}`);

  if (summary.errors.length > 0) {
    console.log(`\n  ⚠️  ${summary.errors.length} migration(s) failed:`);
    summary.errors.forEach(e => console.log(`     - ${e}`));
  } else {
    console.log('\n  ✅  Migration completed successfully.');
  }
  console.log('═══════════════════════════════════════════════════\n');

  // ── Disconnect ────────────────────────────────────────────────────────────
  await mongoose.disconnect();
  console.log('🔌  Disconnected from MongoDB.');
};

// Run when invoked directly: node scripts/migrate.js
main().catch((err) => {
  console.error('❌  Unhandled migration error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
