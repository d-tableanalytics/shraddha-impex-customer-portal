import * as XLSX from 'xlsx';

/**
 * Upcoming Stock — presentation helpers.
 *
 * The figures themselves (upcoming, reserved, remaining, status) are worked out
 * by the server (backend/modules/inventory/upcomingStock.service.js), which
 * links them to the live inventory: stock arriving through the inventory takes
 * quantity off the upcoming shipments by itself. Nothing here decides a
 * quantity; it shapes what the server sent for the screen.
 */

const DAY = 24 * 60 * 60 * 1000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export const itemKey = (item) => `${item.brand}::${item.skuCode}`;

/**
 * An id for one intended write. Sent with a reservation or an import, it lets
 * the server answer a double click or a retried request with the first result
 * instead of doing the work twice.
 */
export const newRequestId = () => (
  globalThis.crypto?.randomUUID?.()
  ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
);

/* ── Indents ───────────────────────────────────────────────────────────── */

/** Indent statuses still waiting on stock — the same pair the server treats as open. */
export const OPEN_INDENT_STATUSES = ['Pending', 'Partially Confirmed'];

/**
 * How much of one indent the FIFO allocation of upcoming stock covers.
 *
 * Separate from the indent's own status (Pending / Partially Confirmed, shown
 * by IndentStatusBadge), which is about the booking it came from. This is a
 * calculation for analysis — nothing is reserved for real.
 */
export const INDENT_RESERVATION_STATUS = {
  'Not Reserved': { chip: 'bg-slate-100 text-slate-600', bar: 'bg-slate-300', mark: '○' },
  'Partially Reserved': { chip: 'bg-primary-50 text-primary-700', bar: 'bg-primary-500', mark: '◐' },
  'Fully Reserved': { chip: 'bg-success-50 text-success-700', bar: 'bg-success-500', mark: '●' },
};

export const reservationStatusFor = (reservedQty, requiredQty) => {
  if (reservedQty >= requiredQty && requiredQty > 0) return 'Fully Reserved';
  if (reservedQty > 0) return 'Partially Reserved';
  return 'Not Reserved';
};

/**
 * Every open indent for this SKU in FIFO order (oldest first), with what the
 * server's FIFO allocation gives it: reservedQty, outstanding (still short) and
 * the shipments that would cover it (coveredBy).
 */
export const indentLinesFor = (item) => (item.indents || [])
  .filter((l) => OPEN_INDENT_STATUSES.includes(l.status))
  .map((l) => ({
    ...l,
    reservedQty: l.reservedQty ?? 0,
    outstanding: l.shortQty ?? Math.max(0, l.requiredQty - (l.reservedQty ?? 0)),
    coveredBy: l.coveredBy || [],
    reservationStatus: reservationStatusFor(l.reservedQty ?? 0, l.requiredQty),
  }))
  .sort((a, b) => (a.fifoPosition ?? 0) - (b.fifoPosition ?? 0));

/** Totals across a SKU's open indents — what the upcoming stock is being asked to cover. */
export const indentSummary = (lines) => lines.reduce((s, l) => ({
  count: s.count + 1,
  required: s.required + l.requiredQty,
  reserved: s.reserved + l.reservedQty,
  open: s.open + l.outstanding,
  covered: s.covered + (l.reservationStatus === 'Fully Reserved' ? 1 : 0),
}), { count: 0, required: 0, reserved: 0, open: 0, covered: 0 });

/* ── Stock status ──────────────────────────────────────────────────────── */

/**
 * Stock status, in priority order. Conveyed by colour AND text AND a shape
 * marker, matching Inventory Health's band chips.
 */
export const STATUS = {
  Delayed: { chip: 'bg-error-50 text-error-700', dot: 'bg-error-500', mark: '▲' },
  'Fully Reserved': { chip: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500', mark: '■' },
  'Low Remaining': { chip: 'bg-warning-50 text-warning-700', dot: 'bg-warning-500', mark: '◆' },
  Available: { chip: 'bg-success-50 text-success-700', dot: 'bg-success-500', mark: '●' },
  'No Inbound': { chip: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300', mark: '○' },
};

export const STATUS_ORDER = ['Delayed', 'Low Remaining', 'Fully Reserved', 'Available', 'No Inbound'];

export const STATUS_HELP = {
  Delayed: 'Expected arrival date has passed and the shipment is not yet received.',
  'Fully Reserved': 'Every unit of upcoming stock is already reserved.',
  'Low Remaining': '20% or less of the upcoming stock is still free to reserve.',
  Available: 'Upcoming stock is free to reserve.',
  'No Inbound': 'No upcoming shipment is recorded for this SKU.',
};

export const daysUntil = (iso) => Math.round((new Date(iso).setHours(0, 0, 0, 0) - startOfToday().getTime()) / DAY);

/* ── Formatting ────────────────────────────────────────────────────────── */

export const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const formatDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
    : '—';

export const relativeArrival = (iso) => {
  if (!iso) return '';
  const d = daysUntil(iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 1) return `in ${d} days`;
  return `${Math.abs(d)} day${d === -1 ? '' : 's'} overdue`;
};

/** A date as the 'YYYY-MM-DD' calendar day a date input and the server use. */
export const toYmd = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ── Import file ───────────────────────────────────────────────────────── */

export const TEMPLATE_HEADERS = ['SKU Code', 'Brand', 'Product', 'Upcoming Qty', 'Expected Arrival', 'PO / Shipment Ref', 'Supplier'];

const HEADER_MATCH = {
  skuCode: /^(sku|sku ?code|item ?code|part ?no\.?)$/,
  brand: /^brand$/,
  product: /^(product|description|product ?name|item ?name)$/,
  qty: /^(upcoming ?qty|upcoming ?quantity|qty|quantity|upcoming)$/,
  eta: /^(expected ?arrival|eta|arrival ?date|expected ?date)$/,
  ref: /^(po ?\/ ?shipment ?ref|po|po ?no\.?|shipment|shipment ?ref|reference|ref)$/,
  supplier: /^(supplier|vendor)$/,
};

const ymdOf = (y, m, d) => {
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * A cell as the calendar day it names, 'YYYY-MM-DD', or '' when it names none.
 * Day-first for typed dates (dd/mm/yyyy), as dates are written in India.
 */
export const cellToYmd = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : toYmd(v);
  if (typeof v === 'number') {
    const parsed = XLSX.SSF.parse_date_code(v);
    return parsed ? ymdOf(parsed.y, parsed.m, parsed.d) : '';
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return ymdOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) return ymdOf(Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]), Number(dmy[2]), Number(dmy[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : toYmd(d);
};

/**
 * Raw sheet rows (array-of-arrays, first row headers) → one object per data row
 * for the server to check. Only the columns are mapped here; every rule (is the
 * quantity whole, does the SKU exist, is the PO line already recorded) is the
 * server's.
 */
export const rowsFromSheet = (rows) => {
  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const col = Object.fromEntries(
    Object.entries(HEADER_MATCH).map(([k, re]) => [k, header.findIndex((h) => re.test(h))]),
  );
  if (col.skuCode < 0 || col.qty < 0) {
    return { error: 'The file needs at least a "SKU Code" and an "Upcoming Qty" column.', rows: [] };
  }
  const cell = (r, k) => (col[k] >= 0 ? r[col[k]] : '');
  const text = (r, k) => String(cell(r, k) ?? '').trim();

  const out = [];
  rows.slice(1).forEach((r, i) => {
    if (!r.some((c) => String(c ?? '').trim() !== '')) return;
    const qty = cell(r, 'qty');
    // A readable date goes as 'YYYY-MM-DD'; anything else typed in the cell goes
    // as written, so the server can say it is not a date instead of it being
    // silently dropped. A blank cell stays blank (the date is optional).
    const etaRaw = cell(r, 'eta');
    out.push({
      row: i + 2,
      skuCode: text(r, 'skuCode'),
      brand: text(r, 'brand'),
      product: text(r, 'product'),
      qty: typeof qty === 'number' ? qty : String(qty ?? '').trim(),
      eta: cellToYmd(etaRaw) || (etaRaw instanceof Date ? '' : String(etaRaw ?? '').trim()),
      ref: text(r, 'ref'),
      supplier: text(r, 'supplier'),
    });
  });
  return { error: null, rows: out };
};

export const readImportFile = async (file) => {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return rowsFromSheet(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
};

/** An empty template with one example row, in a brand this user can see. */
export const downloadTemplate = (brand = '') => {
  const eta = new Date(startOfToday().getTime() + 14 * DAY);
  const ws = XLSX.utils.aoa_to_sheet([
    TEMPLATE_HEADERS,
    // Only SKU Code and Upcoming Qty are required; the rest may be left blank.
    ['SKU-CODE', brand, 'Product description (optional)', 100,
      `${String(eta.getDate()).padStart(2, '0')}/${String(eta.getMonth() + 1).padStart(2, '0')}/${eta.getFullYear()}`,
      'PO-0001', 'Supplier name'],
  ]);
  ws['!cols'] = [14, 10, 40, 14, 18, 22, 32].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Upcoming Stock');
  XLSX.writeFile(wb, 'upcoming-stock-template.xlsx');
};
