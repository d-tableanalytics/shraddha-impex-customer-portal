import * as XLSX from 'xlsx';

/**
 * Upcoming Stock — DEMO ONLY.
 *
 * Everything here is mock: the seed catalogue, the shipments and the
 * reservations live in the browser (see store/upcomingStockStore.js) and never
 * reach the server. Nothing on this screen touches Inventory Master, Inventory
 * Health or the stock ledger.
 *
 * Dates are generated relative to today so the demo never goes stale — a
 * shipment "arriving in 9 days" is always nine days out on the day it is shown.
 */

const DAY = 24 * 60 * 60 * 1000;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const isoInDays = (days) => new Date(startOfToday().getTime() + days * DAY).toISOString();

export const itemKey = (item) => `${item.brand}::${item.skuCode}`;

export const SUPPLIERS = {
  Koken: 'Koken Kogyo Co., Ltd. — Japan',
  BIX: 'BIX Tools Mfg. — Taiwan',
  IMADA: 'IMADA Co., Ltd. — Japan',
};

export const DEMO_CUSTOMERS = [
  'ABC Motors Pvt Ltd',
  'Maruti Suzuki India Ltd',
  'Sharma Traders',
  'Shraddha Motors',
  'Pune Auto Spares',
  'Jain Tools & Hardware',
  'Nashik Auto Hub',
  'Precision Engineering Works',
];

/* ── Seed ──────────────────────────────────────────────────────────────── */

// [brand, skuCode, product, category, actual, shipments[[ref, qty, etaDays]], indents[[customer, required, reserved, daysAgo, partial]]]
//
// Every seeded reservation is held against an indent — the open remainder of a
// booking that stock could not cover. `required` is the indent's quantity (what
// Reservation.quantity holds for an open indent), `reserved` how much of it has
// already been reserved from upcoming stock, and `partial` marks an indent that
// was raised alongside a part-fulfilled booking (status Partially Confirmed).
const SEED = [
  ['Koken', '14405M-10', '1/2" Sq. Dr. 12-Pt Socket 10mm', 'Sockets', 42,
    [['PO-KK-2609-118', 400, 9]],
    [['ABC Motors Pvt Ltd', 150, 120, 8, true], ['Sharma Traders', 60, 60, 5], ['Pune Auto Spares', 90, 0, 2]]],
  ['Koken', '14405M-12', '1/2" Sq. Dr. 12-Pt Socket 12mm', 'Sockets', 0,
    [['PO-KK-2609-118', 300, 9]], [['Maruti Suzuki India Ltd', 300, 300, 10]]],
  ['Koken', '13400M-10', '3/8" Sq. Dr. 6-Pt Socket 10mm', 'Sockets', 186,
    [['PO-KK-2609-118', 250, 9], ['PO-KK-2610-004', 250, 38]],
    [['Pune Auto Spares', 80, 80, 6], ['Jain Tools & Hardware', 120, 0, 3, true]]],
  ['Koken', '13400M-14', '3/8" Sq. Dr. 6-Pt Socket 14mm', 'Sockets', 64,
    [['PO-KK-2609-118', 200, 9]], [['Nashik Auto Hub', 60, 0, 4], ['ABC Motors Pvt Ltd', 40, 0, 1]]],
  ['Koken', '115G.100-12', 'Hex Bit Socket 12mm × 100mm', 'Bit Sockets', 18,
    [['PO-KK-2609-097', 150, -3]], [['ABC Motors Pvt Ltd', 60, 40, 9, true]]],
  ['Koken', '115G.100-10FR', 'Hex Bit Socket 10mm × 100mm (Fixed Ring)', 'Bit Sockets', 5,
    [['PO-KK-2609-097', 120, -3]], [['Shraddha Motors', 100, 100, 5]]],
  ['Koken', '4768N', '1/2" Sq. Dr. Reversible Ratchet 72T', 'Ratchets', 12,
    [['PO-KK-2610-004', 60, 38]], [['Precision Engineering Works', 20, 0, 3]]],
  ['Koken', '3753Z-150', '3/8" Sq. Dr. Wobble Extension 150mm', 'Extensions', 30,
    [['PO-KK-2609-118', 180, 9]], [['Jain Tools & Hardware', 45, 30, 3, true]]],
  ['Koken', '14145M-17', '1/2" Sq. Dr. Deep Impact Socket 17mm', 'Impact Sockets', 0,
    [['PO-KK-2609-118', 240, 9]], [['Maruti Suzuki India Ltd', 200, 150, 10], ['Nashik Auto Hub', 50, 50, 4]]],
  ['Koken', 'RS4400M/13', '1/2" Sq. Dr. Socket Set, 13 pcs (Metric)', 'Socket Sets', 7,
    [['PO-KK-2610-004', 40, 38]], [['Precision Engineering Works', 10, 10, 3], ['Sharma Traders', 8, 0, 5]]],

  ['BIX', 'BIX-TW-0850', '1/2" Click Torque Wrench 40–200 Nm', 'Torque Tools', 9,
    [['CNTR-TGHU-8841207', 80, 4]], [['ABC Motors Pvt Ltd', 25, 25, 8], ['Shraddha Motors', 15, 0, 5]]],
  ['BIX', 'BIX-CS-3812', 'Combination Spanner Set 8–24mm, 12 pcs', 'Spanners', 25,
    [['CNTR-TGHU-8841207', 150, 4]], [['Sharma Traders', 40, 40, 5], ['Pune Auto Spares', 50, 30, 2, true]]],
  ['BIX', 'BIX-HX-L09', 'Long Arm Hex Key Set, 9 pcs', 'Hex Keys', 120,
    [['CNTR-TGHU-8841207', 300, 4]], [['Jain Tools & Hardware', 100, 0, 3]]],
  ['BIX', 'BIX-PL-7160', 'Circlip Plier Set, 4 pcs', 'Pliers', 0,
    [['CNTR-MSKU-7734210', 200, 16]], [['Jain Tools & Hardware', 90, 90, 3], ['Nashik Auto Hub', 75, 75, 4]]],
  ['BIX', 'BIX-SD-0210', 'Precision Screwdriver Set, 10 pcs', 'Screwdrivers', 48,
    [['CNTR-MSKU-7734210', 250, 16]], [['Shraddha Motors', 50, 50, 5], ['ABC Motors Pvt Ltd', 30, 0, 1]]],
  ['BIX', 'BIX-IW-1250', '1/2" Pneumatic Impact Wrench 1250 Nm', 'Air Tools', 3,
    [['CNTR-MSKU-7734210', 45, 16]], [['Maruti Suzuki India Ltd', 45, 45, 10]]],

  ['IMADA', 'ZTA-500N', 'Digital Force Gauge ZTA, 500 N', 'Force Gauges', 4,
    [['PO-IM-2609-031', 20, 23]], [['Precision Engineering Works', 8, 6, 3, true]]],
  ['IMADA', 'DS2-50N', 'Standard Digital Force Gauge DS2, 50 N', 'Force Gauges', 11,
    [['PO-IM-2609-031', 30, 23]], [['Maruti Suzuki India Ltd', 10, 0, 10]]],
  ['IMADA', 'HTG2-5N', 'Digital Torque Gauge HTG2, 5 N·m', 'Torque Gauges', 2,
    [['PO-IM-2609-024', 12, -1]], [['Maruti Suzuki India Ltd', 8, 8, 10]]],
  ['IMADA', 'MX2-500N', 'Motorized Test Stand MX2, 500 N', 'Test Stands', 0,
    [['PO-IM-2609-031', 6, 23]], [['Precision Engineering Works', 5, 5, 3], ['ABC Motors Pvt Ltd', 2, 0, 1]]],
  ['IMADA', 'FB-50N', 'Mechanical Push-Pull Gauge FB, 50 N', 'Force Gauges', 15,
    [['PO-IM-2609-031', 40, 23]], [['ABC Motors Pvt Ltd', 10, 10, 8]]],
  ['IMADA', 'SV-55', 'Manual Vertical Test Stand SV-55', 'Test Stands', 6,
    [['PO-IM-2609-024', 10, -1]], []],
];

// Indents the desk has deliberately kept pending: `${skuCode}|${customer}` → reason.
const SEED_HOLDS = {
  '14405M-10|Pune Auto Spares': 'Customer to confirm the revised PO quantity first.',
  '13400M-14|ABC Motors Pvt Ltd': 'Credit limit review in progress.',
};

let seq = 0;
export const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const daysAgoIso = (daysAgo, hours = 3.5) => new Date(Date.now() - daysAgo * DAY - hours * 60 * 60 * 1000).toISOString();

/**
 * Demo indent numbers follow the real scheme, PI-YYYY-###### (see
 * runConfirmBooking in reservation.controller.js). One confirmation produces
 * ONE indent number shared by every short line, so a customer's lines raised on
 * the same day share a number here too.
 */
const demoIndentNumbers = () => {
  const year = new Date().getFullYear();
  const seen = new Map();
  return (customer, daysAgo) => {
    const k = `${customer}|${daysAgo}`;
    if (!seen.has(k)) seen.set(k, `PI-${year}-${String(1281 + seen.size * 7).padStart(6, '0')}`);
    return seen.get(k);
  };
};

const demoPoNumber = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `PO-${stamp}-${4000 + daysAgo * 137}`;
};

export const buildSeed = () => {
  const indentNumber = demoIndentNumbers();
  return SEED.map(([brand, skuCode, product, category, actual, shipments, indents]) => {
    const lines = indents.map(([customer, required, reserved, daysAgo, partial]) => ({
      lineId: nextId('ind'),
      source: 'demo',
      indentNumber: indentNumber(customer, daysAgo),
      skuCode,
      customer,
      requiredQty: required,
      // An indent raised beside a part-fulfilled booking carries that booking's PO.
      status: partial ? 'Partially Confirmed' : 'Pending',
      poNumber: partial ? demoPoNumber(daysAgo) : null,
      raisedAt: daysAgoIso(daysAgo, 6),
      scheduledDate: null,
      daysAgo,
      reserved,
    }));

    return {
      brand,
      skuCode,
      product,
      category,
      uom: 'PCS',
      actual,
      shipments: shipments.map(([ref, qty, etaDays]) => ({
        id: nextId('shp'),
        ref,
        supplier: SUPPLIERS[brand],
        qty,
        eta: isoInDays(etaDays),
        source: 'Opening upcoming stock',
        importedAt: isoInDays(-7),
      })),
      // `reserved` and `daysAgo` are seed-only; the indent itself does not carry them.
      indents: lines.map(({ reserved: _reserved, daysAgo: _daysAgo, ...l }) => l),
      reservations: lines.filter((l) => l.reserved > 0).map((l) => ({
        id: nextId('rsv'),
        indentNo: l.indentNumber,
        indentRef: indentRefOf(l),
        customer: l.customer,
        qty: l.reserved,
        reservedAt: daysAgoIso(Math.max(0, l.daysAgo - 1)),
        by: 'Sales Desk',
        note: '',
      })),
      holds: lines
        .filter((l) => SEED_HOLDS[`${skuCode}|${l.customer}`])
        .map((l) => ({
          lineId: l.lineId,
          indentNumber: l.indentNumber,
          note: SEED_HOLDS[`${skuCode}|${l.customer}`],
          by: 'Sales Desk',
          at: daysAgoIso(1),
        })),
    };
  });
};

/* ── Indents ───────────────────────────────────────────────────────────── */

/** Indent statuses still waiting on stock — the same pair the server treats as open. */
export const OPEN_INDENT_STATUSES = ['Pending', 'Partially Confirmed'];

/** What a reservation keeps of the indent it was made against — a snapshot, like Order.unitPrice. */
export function indentRefOf(line) {
  return {
    lineId: line.lineId,
    indentNumber: line.indentNumber,
    requiredQty: line.requiredQty,
    source: line.source,
  };
}

/**
 * An open indent line from GET /reservations/pending, in the demo's shape. The
 * customer is named the way Indent History names them.
 */
export const fromLiveIndent = (r) => {
  const c = r.customerId && typeof r.customerId === 'object' ? r.customerId : {};
  const po = String(r.poNumber ?? '').trim();
  return {
    lineId: `live:${r._id}`,
    source: 'live',
    indentNumber: r.indentNumber || r.reservationId,
    skuCode: r.skuCode,
    customer: c.customerName || c.user || c.company || c.email || '—',
    requiredQty: Number(r.quantity) || 0,
    status: r.status,
    poNumber: po && po !== '-' ? po : null,
    raisedAt: r.bookingDate || r.reservationDate || r.createdAt || null,
    scheduledDate: r.scheduledDate || null,
  };
};

/** Reservation status of one indent line against upcoming stock. */
/**
 * Reservation status of one indent against UPCOMING stock.
 *
 * Separate from the indent's own status (Pending / Partially Confirmed, shown
 * by IndentStatusBadge), which is about the booking it came from and which
 * nothing here changes. "Kept Pending" is a decision, not an absence: the desk
 * has looked at this indent and chosen not to reserve for it yet.
 */
export const INDENT_RESERVATION_STATUS = {
  'Not Reserved': { chip: 'bg-slate-100 text-slate-600', bar: 'bg-slate-300', mark: '○' },
  'Kept Pending': { chip: 'bg-warning-50 text-warning-700', bar: 'bg-warning-500', mark: '‖' },
  'Partially Reserved': { chip: 'bg-primary-50 text-primary-700', bar: 'bg-primary-500', mark: '◐' },
  'Fully Reserved': { chip: 'bg-success-50 text-success-700', bar: 'bg-success-500', mark: '●' },
};

export const reservationStatusFor = (reservedQty, requiredQty, held = false) => {
  if (reservedQty >= requiredQty && requiredQty > 0) return 'Fully Reserved';
  if (reservedQty > 0) return 'Partially Reserved';
  return held ? 'Kept Pending' : 'Not Reserved';
};

/**
 * Every open indent for this SKU, with how much upcoming stock is held against
 * each and whether it has been kept pending. Demo indents ride on the item;
 * live ones are matched by SKU code. Oldest first — the queue order the
 * auto-booker honours (indentAvailability.service.js).
 */
export const indentLinesFor = (item, liveIndents = []) => {
  const sku = item.skuCode.toLowerCase();
  const holds = new Map((item.holds || []).map((h) => [h.lineId, h]));
  return [
    ...(item.indents || []),
    ...liveIndents.filter((l) => String(l.skuCode || '').toLowerCase() === sku),
  ]
    .filter((l) => OPEN_INDENT_STATUSES.includes(l.status))
    .map((l) => {
      const reservations = item.reservations.filter((r) => r.indentRef?.lineId === l.lineId);
      const reservedQty = reservations.reduce((s, r) => s + r.qty, 0);
      const outstanding = Math.max(l.requiredQty - reservedQty, 0);
      // A hold only means something while there is still something to hold.
      const hold = outstanding > 0 ? holds.get(l.lineId) || null : null;
      return {
        ...l,
        reservations,
        reservedQty,
        outstanding,
        hold,
        reservationStatus: reservationStatusFor(reservedQty, l.requiredQty, Boolean(hold)),
      };
    })
    .sort((a, b) => String(a.raisedAt || '').localeCompare(String(b.raisedAt || '')));
};

/** Totals across a SKU's open indents — what the upcoming stock is being asked to cover. */
export const indentSummary = (lines) => lines.reduce((s, l) => ({
  count: s.count + 1,
  required: s.required + l.requiredQty,
  reserved: s.reserved + l.reservedQty,
  open: s.open + l.outstanding,
  covered: s.covered + (l.reservationStatus === 'Fully Reserved' ? 1 : 0),
  held: s.held + (l.reservationStatus === 'Kept Pending' || (l.hold && l.reservedQty > 0) ? 1 : 0),
}), { count: 0, required: 0, reserved: 0, open: 0, covered: 0, held: 0 });

/* ── Derivation ────────────────────────────────────────────────────────── */

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

const LOW_REMAINING_SHARE = 0.2;

export const daysUntil = (iso) => Math.round((new Date(iso).setHours(0, 0, 0, 0) - startOfToday().getTime()) / DAY);

export const derive = (item) => {
  const upcoming = item.shipments.reduce((s, x) => s + x.qty, 0);
  const reserved = item.reservations.reduce((s, x) => s + x.qty, 0);
  const remaining = Math.max(upcoming - reserved, 0);
  const etas = item.shipments.map((s) => s.eta).sort();
  const nextEta = etas[0] ?? null;

  let status = 'Available';
  if (upcoming === 0) status = 'No Inbound';
  else if (nextEta && daysUntil(nextEta) < 0) status = 'Delayed';
  else if (remaining === 0) status = 'Fully Reserved';
  else if (remaining <= upcoming * LOW_REMAINING_SHARE) status = 'Low Remaining';

  return {
    ...item,
    key: itemKey(item),
    upcoming,
    reserved,
    remaining,
    projected: item.actual + remaining,
    reservedShare: upcoming ? reserved / upcoming : 0,
    nextEta,
    shipmentCount: item.shipments.length,
    status,
  };
};

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

const parseDate = (v) => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'number') {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    const y = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    const d = new Date(y, Number(dmy[2]) - 1, Number(dmy[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Validate raw sheet rows (array-of-arrays, first row headers) against the
 * current upcoming-stock list. Returns one line per data row with its outcome.
 */
export const validateImportRows = (rows, items) => {
  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const col = Object.fromEntries(
    Object.entries(HEADER_MATCH).map(([k, re]) => [k, header.findIndex((h) => re.test(h))]),
  );
  if (col.skuCode < 0 || col.qty < 0) {
    return { error: 'The file needs at least a "SKU Code" and an "Upcoming Qty" column.', lines: [] };
  }

  const bySku = new Map(items.map((i) => [i.skuCode.toLowerCase(), i]));
  const cell = (r, k) => (col[k] >= 0 ? r[col[k]] : '');

  const lines = rows.slice(1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r, i) => {
      const skuCode = String(cell(r, 'skuCode') ?? '').trim();
      const qtyRaw = cell(r, 'qty');
      const qty = Number(qtyRaw);
      const eta = parseDate(cell(r, 'eta'));
      const existing = bySku.get(skuCode.toLowerCase());
      const brand = existing?.brand || String(cell(r, 'brand') ?? '').trim() || 'Koken';
      const problems = [];

      if (!skuCode) problems.push('SKU code is missing');
      if (!Number.isInteger(qty) || qty <= 0) problems.push(`Quantity "${qtyRaw}" is not a whole number above 0`);
      if (!eta) problems.push('Expected arrival date is missing or unreadable');

      return {
        row: i + 2,
        skuCode: existing?.skuCode || skuCode,
        brand,
        product: existing?.product || String(cell(r, 'product') ?? '').trim() || skuCode,
        qty: Number.isFinite(qty) ? qty : 0,
        eta: eta ? eta.toISOString() : null,
        ref: String(cell(r, 'ref') ?? '').trim() || '—',
        supplier: String(cell(r, 'supplier') ?? '').trim() || SUPPLIERS[brand] || '—',
        outcome: problems.length ? 'error' : existing ? 'existing' : 'new',
        problems,
      };
    });

  return { error: null, lines };
};

export const readImportFile = async (file, items) => {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return validateImportRows(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }), items);
};

const ymd = (days) => {
  const d = new Date(startOfToday().getTime() + days * DAY);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

/** A ready-made shipment file for the demo — mixes top-ups, new SKUs and one bad row. */
export const sampleImportRows = () => [
  TEMPLATE_HEADERS,
  ['14405M-12', 'Koken', '', 200, ymd(12), 'PO-KK-2610-011', ''],
  ['BIX-PL-7160', 'BIX', '', 150, ymd(20), 'CNTR-MSKU-7734210', ''],
  ['BIX-IW-1250', 'BIX', '', 30, ymd(20), 'CNTR-MSKU-7734210', ''],
  ['MX2-500N', 'IMADA', '', 4, ymd(27), 'PO-IM-2610-002', ''],
  ['14100M-19', 'Koken', '1/2" Sq. Dr. 6-Pt Socket 19mm', 180, ymd(12), 'PO-KK-2610-011', ''],
  ['BIX-RW-1308', 'BIX', 'Ratcheting Wrench Set 8–19mm, 8 pcs', 90, ymd(20), 'CNTR-MSKU-7734210', ''],
  ['13400M-12', 'Koken', '3/8" Sq. Dr. 6-Pt Socket 12mm', 'TBC', ymd(12), 'PO-KK-2610-011', ''],
];

export const downloadTemplate = () => {
  const ws = XLSX.utils.aoa_to_sheet([
    TEMPLATE_HEADERS,
    ['14405M-10', 'Koken', '1/2" Sq. Dr. 12-Pt Socket 10mm', 250, ymd(14), 'PO-KK-2610-011', SUPPLIERS.Koken],
    ['BIX-CS-3812', 'BIX', 'Combination Spanner Set 8–24mm, 12 pcs', 100, ymd(21), 'CNTR-TGHU-8841207', SUPPLIERS.BIX],
  ]);
  ws['!cols'] = [14, 10, 40, 14, 18, 22, 32].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Upcoming Stock');
  XLSX.writeFile(wb, 'upcoming-stock-template.xlsx');
};
