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
    description:
      'SKU and quantity. A SKU already in the catalogue has its Quantity ADDED to stock; a SKU '
      + 'that is new is created, and its Quantity becomes the opening stock. '
      + 'A NEGATIVE quantity (e.g. -5) is DEDUCTED from stock instead.',
    permissions: [PERMISSIONS.MANAGE_INVENTORY_MASTER],
    keyFields: ['skuCode'],
    // Deliberately NOT requireExistingSku: creating what is missing is half of
    // what this sheet is for.
    requireLocation: true,
    // Brand is resolved from the SKU when the SKU is already known. A NEW SKU
    // has nothing to resolve from, and this sheet has no Brand column — so it
    // comes from the Brand chosen on the upload form, and validation says so
    // when a new SKU turns up without one.
    resolveBrandFromSku: true,
    brandFromJobForNewSku: true,
    // MSIL is never used to FIND the product, only to confirm the row is the
    // SKU the uploader meant. It catches the failure this sheet is most prone
    // to: a column pasted one row out, where every code still exists and every
    // quantity lands on the wrong part.
    verifyMsil: true,
    columns: [
      SKU,
      { header: 'MSIL Code', field: 'msilCode', type: 'string', required: false, note: 'Optional. Checked against the catalogue if given.' },
      {
        // No `min`: a negative quantity is a deduction, which is the whole
        // point of allowing a signed figure here. The floor that matters is not
        // the cell value but the resulting stock, and that is enforced when the
        // movement is posted — a row may only reduce stock as far as zero, and
        // no further than the units already reserved against live bookings.
        header: 'Quantity', field: 'quantity', type: 'int', required: false,
        note: 'Positive adds to stock (or sets opening stock for a new SKU). '
          + 'Negative deducts, e.g. -5. Blank leaves stock alone.',
      },
    ],
    sample: { 'SKU Code': '14405M-10', 'MSIL Code': '', Quantity: 250 },
  },

  planning: {
    label: 'Planning Parameters',
    description: 'Bulk-update consumption, lead time and safety factor for existing SKUs.',
    permissions: [PERMISSIONS.MANAGE_INVENTORY_MASTER],
    keyFields: ['skuCode'],
    requireExistingSku: true,
    // Brand is accepted but not required — the SKU already identifies the
    // product, and a supplied brand is validated like any other.
    resolveBrandFromSku: true,
    columns: [
      SKU,
      { header: 'Brand', field: 'brand', type: 'string', required: false, note: 'Optional — taken from the SKU when blank.' },
      { header: 'Daily Avg Consumption (Low)', field: 'dacLow', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Normal)', field: 'dacNormal', type: 'number', required: false, min: 0 },
      { header: 'Daily Avg Consumption (Peak)', field: 'dacPeak', type: 'number', required: false, min: 0 },
      { header: 'Lead Time', field: 'leadTime', type: 'number', required: false, min: 0, note: 'Days.' },
      { header: 'Safety Factor', field: 'safetyFactor', type: 'number', required: false, min: 0 },
    ],
    // A row that changes nothing is a mistake worth reporting — usually a
    // column pasted into the wrong place.
    validate: (row) => {
      const touched = ['dacLow', 'dacNormal', 'dacPeak', 'leadTime', 'safetyFactor']
        .some((f) => row[f] !== null && row[f] !== undefined);
      return touched ? [] : [{ category: 'required', message: 'No planning value given — the row would change nothing.' }];
    },
    sample: {
      'SKU Code': '14405M-10', Brand: '', 'Daily Avg Consumption (Low)': 0,
      'Daily Avg Consumption (Normal)': 4.5, 'Daily Avg Consumption (Peak)': 0,
      'Lead Time': 45, 'Safety Factor': 1.2,
    },
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

export default { IMPORT_TEMPLATES, IMPORT_TYPE_NAMES, headersFor, matchHeaders, coerce };
