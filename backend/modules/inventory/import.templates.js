import { MOVEMENT_TYPES } from '../../models/StockMovement.js';
import { VALID_SEASONS, VALID_STATUSES } from '../../utils/productFields.js';
import { PERMISSIONS } from '../../middlewares/rbac.js';

/**
 * Import template registry (IMS Module M9).
 *
 * ONE declaration per import type, used for four things that would otherwise
 * drift apart: generating the blank template, validating the uploaded headers,
 * coercing each cell, and validating each row.
 *
 * When those four live in separate places, the template says "Lead Time (days)"
 * and the validator looks for "Lead Time", and the only way anyone finds out is
 * a failed import. Here the header string exists exactly once.
 *
 * THIS FILE CONTAINS NO INVENTORY LOGIC. Enum values are read from the models
 * that own them, so an import can never accept a value the model would reject,
 * and can never invent one it would not.
 */

// Types a bulk file may post. The full ledger set is deliberately NOT offered:
//
//   OPENING  — has its own import, so an opening balance is never filed as an
//              ordinary receipt and lost among them.
//   COUNT    — belongs to Module M7. A variance must come from a counted,
//              approved session, not from a spreadsheet asserting the answer.
//   RESERVE  — allocation movements are produced by the booking flow. Letting a
//   RELEASE    file write them would let stock be promised without an order.
//   REVERSAL — must reference the movement it reverses; there is nothing to
//              reference in a blank sheet.
export const IMPORTABLE_MOVEMENT_TYPES = ['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT'];

/* ── Cell coercion ──────────────────────────────────────────────────────────
 *
 * Every coercer returns { ok, value, error }. A blank cell is never an error
 * here — "required" is a separate check, so a missing value is reported once as
 * "required" rather than twice as "required" and "not a number".
 */

const asText = (v) => {
  if (v === null || v === undefined) return { ok: true, value: null };
  // Excel hands back rich-text and formula objects; both carry the display
  // string, and a cell that reads "ABC-1" in Excel must import as "ABC-1".
  const raw = typeof v === 'object'
    ? (v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? String(v))
    : v;
  const s = String(raw).trim();
  return { ok: true, value: s === '' ? null : s };
};

const asNumber = (v, { integer = false, min = null, max = null } = {}) => {
  const t = asText(v);
  if (t.value === null) return { ok: true, value: null };
  // Spreadsheets carry thousands separators and stray currency marks.
  const cleaned = t.value.replace(/[, ]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, error: `"${t.value}" is not a number` };
  if (integer && !Number.isInteger(n)) return { ok: false, error: `"${t.value}" must be a whole number` };
  if (min !== null && n < min) return { ok: false, error: `must be at least ${min} (got ${n})` };
  if (max !== null && n > max) return { ok: false, error: `must be at most ${max} (got ${n})` };
  return { ok: true, value: n };
};

const asDate = (v) => {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  // The reader returns real Dates for date-formatted cells; CSV gives strings.
  const d = v instanceof Date ? v : new Date(String(v).trim());
  if (Number.isNaN(d.getTime())) return { ok: false, error: `"${v}" is not a date` };

  // Excel stores a date as a fractional day count, and converting it back lands
  // a few seconds short — a cell reading 2026-03-04 comes through as
  // 2026-03-03T23:59:50 local, which is the WRONG DAY. Rounding to the nearest
  // minute removes the artefact. Nothing in an inventory sheet is meaningful
  // below a minute, so nothing real is lost.
  const rounded = new Date(Math.round(d.getTime() / 60_000) * 60_000);
  return { ok: true, value: rounded };
};

const asBool = (v) => {
  const t = asText(v);
  if (t.value === null) return { ok: true, value: null };
  const l = t.value.toLowerCase();
  if (['true', 'yes', 'y', '1', 'active'].includes(l)) return { ok: true, value: true };
  if (['false', 'no', 'n', '0', 'inactive'].includes(l)) return { ok: true, value: false };
  return { ok: false, error: `"${t.value}" is not yes/no` };
};

const asList = (v) => {
  const t = asText(v);
  if (t.value === null) return { ok: true, value: [] };
  return { ok: true, value: t.value.split(/[,;|]/).map((s) => s.trim()).filter(Boolean) };
};

/** Coerce one cell according to its column spec. */
export const coerce = (spec, value) => {
  switch (spec.type) {
    case 'number': return asNumber(value, spec);
    case 'int': return asNumber(value, { ...spec, integer: true });
    case 'date': return asDate(value);
    case 'boolean': return asBool(value);
    case 'list': return asList(value);
    case 'upper': {
      const t = asText(value);
      return { ok: true, value: t.value ? t.value.toUpperCase() : null };
    }
    default: return asText(value);
  }
};

/* ── Shared column definitions ──────────────────────────────────────────── */

const SKU = { header: 'SKU Code', field: 'skuCode', type: 'string', required: true, note: 'Must already exist unless this is a master import.' };
const BRAND = { header: 'Brand', field: 'brand', type: 'string', required: true, note: 'Koken, BIX or IMADA.' };
const NOTE = { header: 'Note', field: 'note', type: 'string', required: false };

/* ── The registry ───────────────────────────────────────────────────────── */

export const IMPORT_TEMPLATES = {
  'inventory-master': {
    label: 'Inventory Master',
    description: 'Create or update SKUs, categories and planning parameters.',
    // Writing the master is the same act as editing a planning parameter by
    // hand, so it carries the same permission rather than a new one.
    permissions: [PERMISSIONS.MANAGE_INVENTORY_MASTER],
    // The key that makes a row unique within the file. Duplicate detection and
    // the "already exists" check both use it.
    keyFields: ['skuCode', 'brand'],
    columns: [
      SKU,
      BRAND,
      { header: 'MSIL Code', field: 'msilCode', type: 'string', required: false },
      { header: 'Description', field: 'description', type: 'string', required: false },
      { header: 'Category', field: 'category', type: 'list', required: false, note: 'Comma-separated for multiple.' },
      { header: 'UOM', field: 'uom', type: 'string', required: false, note: 'Defaults to PCS.' },
      { header: 'Status', field: 'status', type: 'string', required: false, enumOf: VALID_STATUSES },
      { header: 'Current Season', field: 'currentSeason', type: 'string', required: false, enumOf: VALID_SEASONS },
      // Three columns, matching the workbook's own E/F/G. A single figure
      // cannot say WHICH season it belongs to, and writing it to the field
      // wholesale replaces the per-season object with a bare number — which
      // reads back as no consumption at all.
      { header: 'Daily Avg Consumption (Low)', field: 'dacLow', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Normal)', field: 'dacNormal', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Peak)', field: 'dacPeak', type: 'number', required: false, min: 0 },
      { header: 'Lead Time', field: 'leadTime', type: 'number', required: false, min: 0, note: 'Days.' },
      { header: 'Safety Factor', field: 'safetyFactor', type: 'number', required: false, min: 0 },
    ],
    sample: {
      'SKU Code': '14405M-10', Brand: 'Koken', 'MSIL Code': 'M-14405-10',
      Description: '10mm Socket', Category: 'Sockets', UOM: 'PCS', Status: 'Active',
      'Current Season': 'Normal', 'Daily Avg Consumption (Normal)': 4.5, 'Lead Time': 45, 'Safety Factor': 1.2,
    },
  },

  planning: {
    label: 'Planning Parameters',
    description: 'Bulk-update consumption, lead time, safety factor and season for existing SKUs.',
    permissions: [PERMISSIONS.MANAGE_INVENTORY_MASTER],
    keyFields: ['skuCode', 'brand'],
    requireExistingSku: true,
    columns: [
      SKU,
      BRAND,
      // Three columns, matching the workbook's own E/F/G. A single figure
      // cannot say WHICH season it belongs to, and writing it to the field
      // wholesale replaces the per-season object with a bare number — which
      // reads back as no consumption at all.
      { header: 'Daily Avg Consumption (Low)', field: 'dacLow', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Normal)', field: 'dacNormal', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Peak)', field: 'dacPeak', type: 'number', required: false, min: 0 },
      { header: 'Lead Time', field: 'leadTime', type: 'number', required: false, min: 0 },
      { header: 'Safety Factor', field: 'safetyFactor', type: 'number', required: false, min: 0 },
      { header: 'Current Season', field: 'currentSeason', type: 'string', required: false, enumOf: VALID_SEASONS },
    ],
    // A row that changes nothing is a mistake worth reporting — usually a
    // column pasted into the wrong place.
    validate: (row) => {
      const touched = ['dacLow', 'dacNormal', 'dacPeak', 'leadTime', 'safetyFactor', 'currentSeason']
        .some((f) => row[f] !== null && row[f] !== undefined);
      return touched ? [] : [{ category: 'required', message: 'No planning value given — the row would change nothing.' }];
    },
    sample: { 'SKU Code': '14405M-10', Brand: 'Koken', 'Daily Avg Consumption (Low)': 0, 'Daily Avg Consumption (Normal)': 4.5, 'Daily Avg Consumption (Peak)': 0, 'Lead Time': 45, 'Safety Factor': 1.2, 'Current Season': 'Normal' },
  },

  'opening-stock': {
    label: 'Opening Stock',
    description: 'Set opening balances. Posted as OPENING movements through the ledger.',
    permissions: [PERMISSIONS.POST_STOCK_IN],
    keyFields: ['skuCode', 'brand', 'locationCode'],
    requireExistingSku: true,
    requireLocation: true,
    columns: [
      SKU,
      BRAND,
      { header: 'Quantity', field: 'quantity', type: 'number', required: true, min: 0, note: 'Opening stock cannot be negative.' },
      { header: 'Unit Cost', field: 'unitCost', type: 'number', required: false, min: 0 },
      NOTE,
    ],
    sample: { 'SKU Code': '14405M-10', Brand: 'Koken', Quantity: 250, 'Unit Cost': 180, Note: 'Go-live balance' },
  },

  'stock-movements': {
    label: 'Stock Movements',
    description: 'Bulk receipts, issues, adjustments and transfers. Every line posts through the ledger.',
    permissions: [PERMISSIONS.POST_STOCK_IN, PERMISSIONS.POST_STOCK_OUT, PERMISSIONS.ADJUST_STOCK],
    // Movements are events, not state — the same SKU legitimately appears many
    // times in one file, so there is no duplicate key to enforce.
    keyFields: null,
    requireExistingSku: true,
    requireLocation: true,
    requireReasonCode: 'optional',
    columns: [
      SKU,
      BRAND,
      { header: 'Movement Type', field: 'movementType', type: 'upper', required: true, enumOf: IMPORTABLE_MOVEMENT_TYPES },
      { header: 'Quantity', field: 'quantity', type: 'number', required: true, note: 'Sign is set by the movement type; enter a positive figure.' },
      { header: 'Reason Code', field: 'reasonCode', type: 'upper', required: false },
      { header: 'Effective Date', field: 'effectiveDate', type: 'date', required: false, note: 'Blank means now. Cannot be in the future.' },
      NOTE,
    ],
    /**
     * The sign belongs to the movement type, not to the person filling in the
     * sheet. Asking for "-5" on an ISSUE invites both "-5" and "5" in the same
     * file, half of which then post backwards. The quantity is entered as a
     * magnitude and signed here, exactly as the ledger's own rules require.
     */
    validate: (row) => {
      const errors = [];
      const spec = MOVEMENT_TYPES[row.movementType];
      if (!spec) return errors; // enum validation already reported it
      if (row.quantity === 0) {
        errors.push({ category: 'range', column: 'Quantity', message: 'Quantity cannot be zero.' });
      } else if (row.quantity < 0) {
        errors.push({
          category: 'range', column: 'Quantity',
          message: `Enter a positive quantity — ${row.movementType} already means ${spec.sign === 'negative' ? 'stock out' : 'stock in'}.`,
        });
      }
      if (row.effectiveDate && row.effectiveDate.getTime() > Date.now() + 60_000) {
        errors.push({ category: 'range', column: 'Effective Date', message: 'Effective date cannot be in the future.' });
      }
      return errors;
    },
    /** Apply the type's sign once the row is known good. */
    transform: (row) => ({
      ...row,
      quantity: MOVEMENT_TYPES[row.movementType]?.sign === 'negative' ? -Math.abs(row.quantity) : Math.abs(row.quantity),
    }),
    sample: { 'SKU Code': '14405M-10', Brand: 'Koken', 'Movement Type': 'RECEIPT', Quantity: 100, 'Reason Code': '', 'Effective Date': '', Note: 'PO-4471' },
  },

  'physical-count': {
    label: 'Physical Count Sheet',
    description: 'Load counted quantities into a count session. Variances still require approval before they post.',
    permissions: [PERMISSIONS.PERFORM_COUNT],
    keyFields: ['skuCode', 'brand'],
    requireExistingSku: true,
    requireLocation: true,
    requireReasonCode: 'optional',
    columns: [
      SKU,
      BRAND,
      { header: 'Counted Quantity', field: 'countedQuantity', type: 'number', required: true, min: 0 },
      { header: 'Reason Code', field: 'reasonCode', type: 'upper', required: false, note: 'Required by the count service when a variance needs explaining.' },
      NOTE,
    ],
    sample: { 'SKU Code': '14405M-10', Brand: 'Koken', 'Counted Quantity': 248, 'Reason Code': 'MISCOUNT', Note: '' },
  },

};

export const IMPORT_TYPE_NAMES = Object.keys(IMPORT_TEMPLATES);

/** Header row for a type's template, in declaration order. */
export const headersFor = (importType) =>
  (IMPORT_TEMPLATES[importType]?.columns || []).map((c) => c.header);

/**
 * Match the uploaded header row against the template.
 *
 * Matching is case- and whitespace-insensitive, because a header retyped as
 * "sku code" is unambiguous and rejecting it would be pedantic. Unknown columns
 * are reported but tolerated — sheets routinely carry a working column or two,
 * and refusing the file over an extra "Checked By" column helps nobody.
 * Missing REQUIRED columns are fatal, since nothing can be validated without
 * them.
 */
export const matchHeaders = (importType, headerRow) => {
  const template = IMPORT_TEMPLATES[importType];
  const seen = (headerRow || []).map((h) => String(h ?? '').trim());
  /**
   * A trailing asterisk is stripped before matching.
   *
   * The generated template marks required columns "SKU Code *", so without this
   * the blank template DOWNLOADED FROM THIS SYSTEM failed its own header check —
   * and the error told the user to download the template and use its header row,
   * which is exactly what they had done. People mark required columns this way
   * in their own sheets too, so accepting it is right regardless.
   */
  const normalise = (s) => s.toLowerCase().replace(/\s*\*+$/, '').replace(/\s+/g, ' ').trim();
  const byNormalised = new Map(seen.map((h, i) => [normalise(h), i]));

  const mapping = {};        // field → column index
  const missing = [];
  for (const col of template.columns) {
    const index = byNormalised.get(normalise(col.header));
    if (index === undefined) {
      if (col.required) missing.push(col.header);
    } else {
      mapping[col.field] = index;
    }
  }

  const known = new Set(template.columns.map((c) => normalise(c.header)));
  const unexpected = seen.filter((h) => h && !known.has(normalise(h)));

  return { mapping, missing, unexpected, matched: Object.keys(mapping).length };
};

export default { IMPORT_TEMPLATES, IMPORT_TYPE_NAMES, headersFor, matchHeaders, coerce, IMPORTABLE_MOVEMENT_TYPES };
