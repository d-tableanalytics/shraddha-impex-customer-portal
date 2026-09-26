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

// [brand, skuCode, product, category, actual, shipments[[ref, qty, etaDays]], reservations[[customer, qty, daysAgo]]]
const SEED = [
  ['Koken', '14405M-10', '1/2" Sq. Dr. 12-Pt Socket 10mm', 'Sockets', 42,
    [['PO-KK-2609-118', 400, 9]], [['ABC Motors Pvt Ltd', 120, 2], ['Sharma Traders', 60, 1]]],
  ['Koken', '14405M-12', '1/2" Sq. Dr. 12-Pt Socket 12mm', 'Sockets', 0,
    [['PO-KK-2609-118', 300, 9]], [['Maruti Suzuki India Ltd', 300, 3]]],
  ['Koken', '13400M-10', '3/8" Sq. Dr. 6-Pt Socket 10mm', 'Sockets', 186,
    [['PO-KK-2609-118', 250, 9], ['PO-KK-2610-004', 250, 38]], [['Pune Auto Spares', 80, 4]]],
  ['Koken', '13400M-14', '3/8" Sq. Dr. 6-Pt Socket 14mm', 'Sockets', 64,
    [['PO-KK-2609-118', 200, 9]], []],
  ['Koken', '115G.100-12', 'Hex Bit Socket 12mm × 100mm', 'Bit Sockets', 18,
    [['PO-KK-2609-097', 150, -3]], [['ABC Motors Pvt Ltd', 40, 6]]],
  ['Koken', '115G.100-10FR', 'Hex Bit Socket 10mm × 100mm (Fixed Ring)', 'Bit Sockets', 5,
    [['PO-KK-2609-097', 120, -3]], [['Shraddha Motors', 100, 5]]],
  ['Koken', '4768N', '1/2" Sq. Dr. Reversible Ratchet 72T', 'Ratchets', 12,
    [['PO-KK-2610-004', 60, 38]], []],
  ['Koken', '3753Z-150', '3/8" Sq. Dr. Wobble Extension 150mm', 'Extensions', 30,
    [['PO-KK-2609-118', 180, 9]], [['Jain Tools & Hardware', 30, 1]]],
  ['Koken', '14145M-17', '1/2" Sq. Dr. Deep Impact Socket 17mm', 'Impact Sockets', 0,
    [['PO-KK-2609-118', 240, 9]], [['Maruti Suzuki India Ltd', 150, 2], ['Nashik Auto Hub', 50, 1]]],
  ['Koken', 'RS4400M/13', '1/2" Sq. Dr. Socket Set, 13 pcs (Metric)', 'Socket Sets', 7,
    [['PO-KK-2610-004', 40, 38]], [['Precision Engineering Works', 10, 0]]],

  ['BIX', 'BIX-TW-0850', '1/2" Click Torque Wrench 40–200 Nm', 'Torque Tools', 9,
    [['CNTR-TGHU-8841207', 80, 4]], [['ABC Motors Pvt Ltd', 25, 3]]],
  ['BIX', 'BIX-CS-3812', 'Combination Spanner Set 8–24mm, 12 pcs', 'Spanners', 25,
    [['CNTR-TGHU-8841207', 150, 4]], [['Sharma Traders', 40, 2], ['Pune Auto Spares', 30, 2]]],
  ['BIX', 'BIX-HX-L09', 'Long Arm Hex Key Set, 9 pcs', 'Hex Keys', 120,
    [['CNTR-TGHU-8841207', 300, 4]], []],
  ['BIX', 'BIX-PL-7160', 'Circlip Plier Set, 4 pcs', 'Pliers', 0,
    [['CNTR-MSKU-7734210', 200, 16]], [['Jain Tools & Hardware', 90, 1], ['Nashik Auto Hub', 75, 0]]],
  ['BIX', 'BIX-SD-0210', 'Precision Screwdriver Set, 10 pcs', 'Screwdrivers', 48,
    [['CNTR-MSKU-7734210', 250, 16]], [['Shraddha Motors', 50, 4]]],
  ['BIX', 'BIX-IW-1250', '1/2" Pneumatic Impact Wrench 1250 Nm', 'Air Tools', 3,
    [['CNTR-MSKU-7734210', 45, 16]], [['Maruti Suzuki India Ltd', 45, 1]]],

  ['IMADA', 'ZTA-500N', 'Digital Force Gauge ZTA, 500 N', 'Force Gauges', 4,
    [['PO-IM-2609-031', 20, 23]], [['Precision Engineering Works', 6, 2]]],
  ['IMADA', 'DS2-50N', 'Standard Digital Force Gauge DS2, 50 N', 'Force Gauges', 11,
    [['PO-IM-2609-031', 30, 23]], []],
  ['IMADA', 'HTG2-5N', 'Digital Torque Gauge HTG2, 5 N·m', 'Torque Gauges', 2,
    [['PO-IM-2609-024', 12, -1]], [['Maruti Suzuki India Ltd', 8, 5]]],
  ['IMADA', 'MX2-500N', 'Motorized Test Stand MX2, 500 N', 'Test Stands', 0,
    [['PO-IM-2609-031', 6, 23]], [['Precision Engineering Works', 5, 3]]],
  ['IMADA', 'FB-50N', 'Mechanical Push-Pull Gauge FB, 50 N', 'Force Gauges', 15,
    [['PO-IM-2609-031', 40, 23]], [['ABC Motors Pvt Ltd', 10, 1]]],
  ['IMADA', 'SV-55', 'Manual Vertical Test Stand SV-55', 'Test Stands', 6,
    [['PO-IM-2609-024', 10, -1]], []],
];

let seq = 0;
export const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

export const buildSeed = () => {
  let indent = 100;
  return SEED.map(([brand, skuCode, product, category, actual, shipments, reservations]) => ({
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
    reservations: reservations.map(([customer, qty, daysAgo]) => ({
      id: nextId('rsv'),
      indentNo: `IND-UP-${String((indent += 1)).padStart(4, '0')}`,
      customer,
      qty,
      reservedAt: new Date(Date.now() - daysAgo * DAY - 3.5 * 60 * 60 * 1000).toISOString(),
      by: 'Sales Desk',
      note: '',
    })),
  }));
};

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
