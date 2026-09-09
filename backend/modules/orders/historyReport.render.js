import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Rendering the weekly Booking & Indent History report — .xlsx and .pdf.
 *
 * BOTH RENDERERS TAKE THE SAME GATHERED REPORT and neither queries anything:
 * they are given rows and produce bytes. The two formats therefore cannot
 * disagree about the week, and either can be exercised without a database.
 *
 * THE COLUMNS ARE DEFINED ONCE, HERE, and both formats read the same list. It is
 * the same set the screens export (frontend/src/utils/historyExportColumns.js) —
 * customer name, shop, location, type, booking date and PO number in front of
 * the line detail — so the weekly mail and a manual export are the same sheet.
 */

const BRAND_ARGB = 'FF1A5B9E';
const BRAND_RGB = [26, 91, 158];
const SLATE_RGB = [100, 116, 139];

/** What an empty cell says, matching the screens' exports. */
const NA = 'N/A';

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

const fmtDate = (d) => {
  if (!d) return NA;
  const date = new Date(d);
  return Number.isNaN(date.getTime())
    ? NA
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtDateTime = (d, timezone) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

const orNa = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? NA : s;
};

/**
 * The customer block every row of both sheets starts with.
 *
 * Shared between the two column lists rather than written twice: the
 * requirement is that Booking History and Indent History carry the SAME fields,
 * and two lists that merely happen to match today would not stay matching.
 */
const CUSTOMER_COLUMNS = [
  { header: 'Customer Name', width: 28, pdfWidth: 108, get: (r) => orNa(r.customerName) },
  { header: 'Shop No.', width: 12, pdfWidth: 50, get: (r) => orNa(r.shopNumber) },
  { header: 'Location', width: 22, pdfWidth: 92, get: (r) => orNa(r.location) },
  { header: 'Customer Type', width: 14, pdfWidth: 56, get: (r) => orNa(r.customerType) },
];

/** Booking Date and PO Number, in that order, on both sheets. */
const TRANSACTION_COLUMNS = [
  { header: 'Booking Date', width: 14, pdfWidth: 66, get: (r) => fmtDate(r.bookingDate) },
  // N/A, not blank, when no PO has been raised — an empty cell reads as data
  // that failed to load rather than as a booking still waiting for its PO.
  { header: 'PO Number', width: 18, pdfWidth: 76, get: (r) => orNa(r.poNumber) },
];

export const BOOKING_COLUMNS = [
  { header: 'Booking ID', width: 18, pdfWidth: 84, get: (r) => orNa(r.bookingId) },
  ...CUSTOMER_COLUMNS,
  ...TRANSACTION_COLUMNS,
  { header: 'Status', width: 14, pdfWidth: 60, get: (r) => orNa(r.status) },
  { header: 'SKU', width: 16, pdfWidth: 74, get: (r) => orNa(r.skuCode) },
  { header: 'MSIL Code', width: 16, pdfWidth: 70, get: (r) => orNa(r.msilCode) },
  { header: 'Booked Qty', width: 11, pdfWidth: 46, get: (r) => r.bookedQty ?? 0, numeric: true },
  { header: 'Confirmed Qty', width: 13, pdfWidth: 52, get: (r) => r.confirmedQty ?? 0, numeric: true },
  { header: 'Indent Qty', width: 11, pdfWidth: 46, get: (r) => r.indentQty ?? 0, numeric: true },
];

export const INDENT_COLUMNS = [
  { header: 'Indent No', width: 18, pdfWidth: 80, get: (r) => orNa(r.indentNumber) },
  // Blank for a standalone indent — one raised with no booking behind it — and
  // that is a fact about the indent rather than a missing value.
  { header: 'Booking ID', width: 18, pdfWidth: 80, get: (r) => orNa(r.bookingId) },
  ...CUSTOMER_COLUMNS,
  ...TRANSACTION_COLUMNS,
  { header: 'Status', width: 16, pdfWidth: 66, get: (r) => orNa(r.status) },
  { header: 'Indent Date', width: 14, pdfWidth: 62, get: (r) => fmtDate(r.indentDate) },
  { header: 'SKU', width: 16, pdfWidth: 68, get: (r) => orNa(r.skuCode) },
  { header: 'MSIL Code', width: 16, pdfWidth: 66, get: (r) => orNa(r.msilCode) },
  { header: 'Indent Qty', width: 11, pdfWidth: 46, get: (r) => r.indentQty ?? 0, numeric: true },
];

/** `Booking_Indent_History_2026-09-07_2026-09-13.xlsx` — safe on every filesystem. */
export const reportFileName = (report, extension) =>
  `Booking_Indent_History_${report.period.label}.${extension}`;

/* ── Excel ────────────────────────────────────────────────────────────────── */

const addSheet = (wb, name, columns, rows) => {
  const sheet = wb.addWorksheet(name, {
    properties: { defaultRowHeight: 16 },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((c) => ({ header: c.header, key: c.header, width: c.width }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB } };
  header.alignment = { vertical: 'middle' };

  for (const row of rows) {
    const added = sheet.addRow(columns.map((c) => c.get(row)));
    added.font = { size: 10 };
    columns.forEach((c, i) => {
      if (c.numeric) added.getCell(i + 1).alignment = { horizontal: 'right' };
    });
  }

  // Filter and sort by hand — the first instinct is to narrow the sheet to one
  // customer or one status.
  if (rows.length) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  } else {
    sheet.addRow(['No records in this period.']).font = { italic: true, color: { argb: 'FF64748B' } };
  }

  return sheet;
};

export const buildHistoryXlsx = async (report) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shraddha Impex Portal';
  wb.created = report.generatedAt;

  /* ── Summary ────────────────────────────────────────────────────────── */
  const summary = wb.addWorksheet('Summary', { properties: { defaultRowHeight: 18 } });
  summary.columns = [{ width: 34 }, { width: 20 }, { width: 46 }];

  const title = summary.addRow(['Weekly Booking & Indent History Report']);
  title.font = { bold: true, size: 16, color: { argb: BRAND_ARGB } };
  summary.mergeCells('A1:C1');

  summary.addRow([report.period.title, '', '']).font = { bold: true, size: 11 };
  summary.addRow(['Reporting period', `${report.period.fromLabel} to ${report.period.toLabel}`,
    `${report.period.days} day(s), ${report.timezone}`]);
  summary.addRow(['Generated', fmtDateTime(report.generatedAt, report.timezone), '']);
  summary.addRow([]);

  const stat = (label, value, note) => {
    const row = summary.addRow([label, value, note || '']);
    row.getCell(1).font = { bold: true, color: { argb: 'FF334155' } };
    row.getCell(2).alignment = { horizontal: 'right' };
    row.getCell(3).font = { size: 10, color: { argb: 'FF64748B' } };
  };

  stat('Bookings', report.summary.bookings, 'Bookings placed in this period');
  stat('Booking lines', report.summary.bookingLines, 'One row per SKU on the Bookings sheet');
  stat('Booked quantity', report.summary.bookingQty, '');
  stat('Bookings with a PO', report.summary.bookingsWithPo, 'The rest are still awaiting one');
  summary.addRow([]);
  stat('Indents', report.summary.indents, 'Indents raised in this period');
  stat('Indent lines', report.summary.indentLines, 'One row per SKU on the Indents sheet');
  stat('Indent quantity', report.summary.indentQty, 'Units awaiting stock');
  summary.addRow([]);
  stat('Customers', report.summary.customers, 'Distinct customers across both sheets');
  summary.addRow([]);
  summary.addRow([
    'Records are included by creation date, so each one appears in exactly one weekly report.',
  ]).font = { italic: true, size: 10, color: { argb: 'FF64748B' } };
  summary.mergeCells(`A${summary.rowCount}:C${summary.rowCount}`);

  /* ── The two histories ──────────────────────────────────────────────── */
  addSheet(wb, 'Booking History', BOOKING_COLUMNS, report.bookings);
  addSheet(wb, 'Indent History', INDENT_COLUMNS, report.indents);

  const buffer = await wb.xlsx.writeBuffer();
  return {
    format: 'xlsx',
    fileName: reportFileName(report, 'xlsx'),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: Buffer.from(buffer),
  };
};

/* ── PDF ──────────────────────────────────────────────────────────────────── */

/**
 * How many rows of EACH table the PDF carries before it defers to the
 * spreadsheet. A busy week is thousands of lines, which is an attachment nobody
 * opens and every mail server resents. The PDF says exactly how many it left
 * out; the .xlsx sent alongside has every one.
 */
export const PDF_DEFAULT_MAX_ROWS = 400;

export const buildHistoryPdf = async (report, { maxRows = PDF_DEFAULT_MAX_ROWS } = {}) =>
  new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve({
        format: 'pdf',
        fileName: reportFileName(report, 'pdf'),
        contentType: 'application/pdf',
        content: Buffer.concat(chunks),
      }));

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const usable = right - left;

      // ── Header ──────────────────────────────────────────────────────────
      doc.fillColor(BRAND_RGB).font('Helvetica-Bold').fontSize(17)
        .text('Weekly Booking & Indent History', left, 30);
      doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(9)
        .text(`${report.period.title}  ·  ${report.period.days} days to ${report.period.toLabel}`, left, 52);
      doc.text(`Generated ${fmtDateTime(report.generatedAt, report.timezone)} (${report.timezone})`, left, 64);
      doc.moveTo(left, 78).lineTo(right, 78).strokeColor(BRAND_RGB).lineWidth(1).stroke();

      // ── Summary tiles ───────────────────────────────────────────────────
      const tiles = [
        { label: 'Bookings', value: report.summary.bookings },
        { label: 'Booking Lines', value: report.summary.bookingLines },
        { label: 'Booked Qty', value: report.summary.bookingQty },
        { label: 'Indents', value: report.summary.indents },
        { label: 'Indent Lines', value: report.summary.indentLines },
        { label: 'Indent Qty', value: report.summary.indentQty },
        { label: 'Customers', value: report.summary.customers },
      ];
      const gap = 8;
      const tileW = (usable - gap * (tiles.length - 1)) / tiles.length;
      let x = left;
      const tileY = 88;
      for (const tile of tiles) {
        doc.roundedRect(x, tileY, tileW, 44, 4).fillAndStroke([248, 250, 252], [226, 232, 240]);
        doc.fillColor(BRAND_RGB).font('Helvetica-Bold').fontSize(16)
          .text(nf(tile.value), x + 8, tileY + 8, { width: tileW - 16 });
        doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(7)
          .text(tile.label.toUpperCase(), x + 8, tileY + 30, { width: tileW - 16, characterSpacing: 0.4 });
        x += tileW + gap;
      }

      let y = tileY + 58;
      const rowH = 13;
      const bottom = doc.page.height - doc.page.margins.bottom - 20;

      /**
       * One table. Drawn by hand rather than with a table library because pdfkit
       * has none — the same approach the inventory report takes, and the reason
       * every column carries its own `pdfWidth`.
       */
      const drawTable = (heading, columns, rows) => {
        const widthOf = (c) => c.pdfWidth;
        const total = columns.reduce((n, c) => n + widthOf(c), 0);
        // Scale to the page rather than overflow it: the two tables have
        // different column counts and neither should decide the page size.
        const scale = usable / total;

        const drawHeadingRow = () => {
          doc.rect(left, y, usable, rowH + 3).fill(BRAND_RGB);
          let cx = left + 3;
          doc.fillColor([255, 255, 255]).font('Helvetica-Bold').fontSize(7);
          for (const c of columns) {
            doc.text(c.header, cx, y + 4.5, {
              width: widthOf(c) * scale - 5, align: c.numeric ? 'right' : 'left', lineBreak: false,
            });
            cx += widthOf(c) * scale;
          }
          y += rowH + 5;
        };

        const newPage = () => {
          doc.addPage();
          y = doc.page.margins.top;
          drawHeadingRow();
        };

        if (y + 40 > bottom) { doc.addPage(); y = doc.page.margins.top; }
        doc.fillColor(BRAND_RGB).font('Helvetica-Bold').fontSize(11).text(heading, left, y);
        y += 16;

        drawHeadingRow();

        const shown = rows.slice(0, Math.max(0, maxRows));
        shown.forEach((r, i) => {
          if (y + rowH > bottom) newPage();
          if (i % 2 === 1) doc.rect(left, y - 2, usable, rowH).fill([248, 250, 252]);

          let cx = left + 3;
          for (const c of columns) {
            const value = c.get(r);
            doc.fillColor([51, 65, 85]).font('Helvetica').fontSize(6.8)
              .text(c.numeric ? nf(value) : String(value ?? NA), cx, y + 1.5, {
                width: widthOf(c) * scale - 5,
                align: c.numeric ? 'right' : 'left',
                lineBreak: false,
                ellipsis: true,
              });
            cx += widthOf(c) * scale;
          }
          y += rowH;
        });

        if (!rows.length) {
          doc.fillColor(SLATE_RGB).font('Helvetica-Oblique').fontSize(8)
            .text('No records in this period.', left, y + 4, { width: usable });
          y += 18;
        }

        const omitted = rows.length - shown.length;
        if (omitted > 0) {
          if (y + 24 > bottom) newPage();
          doc.fillColor([180, 83, 9]).font('Helvetica-Oblique').fontSize(7.5)
            .text(
              `… and ${nf(omitted)} more row(s), omitted to keep this document readable. `
              + 'The Excel attachment contains the complete list.',
              left, y + 6, { width: usable },
            );
          y += 22;
        }

        y += 14;
      };

      drawTable('Booking History', BOOKING_COLUMNS, report.bookings);
      drawTable('Indent History', INDENT_COLUMNS, report.indents);

      // ── Footer on every page ────────────────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const fy = doc.page.height - doc.page.margins.bottom - 10;
        doc.moveTo(left, fy - 4).lineTo(right, fy - 4).strokeColor([226, 232, 240]).lineWidth(0.5).stroke();
        doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(7)
          .text(
            `Shraddha Impex Portal — automated weekly report · ${report.period.fromLabel} to ${report.period.toLabel}`,
            left, fy, { width: usable / 2, lineBreak: false },
          );
        doc.text(`Page ${i + 1} of ${range.count}`, left + usable / 2, fy, {
          width: usable / 2, align: 'right', lineBreak: false,
        });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });

/* ── Email body ───────────────────────────────────────────────────────────── */

/**
 * Written so the mail is USEFUL WITHOUT OPENING THE ATTACHMENT: the counts are
 * in the body, and someone reading it on a phone can tell what kind of week it
 * was before they get to a desk.
 */
export const buildHistoryEmail = (report, attachments = []) => {
  const s = report.summary;

  const row = (label, value, note) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;color:#334155;"><strong>${label}</strong></td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:bold;color:#0f172a;">${nf(value)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;">${note}</td>
    </tr>`;

  const headline = (s.bookingLines + s.indentLines) === 0
    ? `<p style="margin:0 0 14px;padding:10px 12px;background:#f8fafc;border-left:3px solid #94a3b8;color:#475569;">
         No bookings or indents were created in this period. The attachments are included and empty.
       </p>`
    : `<p style="margin:0 0 14px;padding:10px 12px;background:#f0f9ff;border-left:3px solid #1a5b9e;color:#0c4a6e;">
         <strong>${nf(s.bookings)}</strong> booking(s) and <strong>${nf(s.indents)}</strong> indent(s)
         from <strong>${nf(s.customers)}</strong> customer(s).
         ${s.bookings ? `${nf(s.bookingsWithPo)} of the bookings have a PO raised.` : ''}
       </p>`;

  return `
    <h3 style="margin:0 0 4px;color:#1a5b9e;">Weekly Booking &amp; Indent History — ${report.period.title}</h3>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b;">
      ${report.period.days} day(s) to ${report.period.toLabel} ·
      generated ${fmtDateTime(report.generatedAt, report.timezone)} (${report.timezone})
    </p>
    ${headline}
    <table style="border-collapse:collapse;width:100%;max-width:620px;">
      <tbody>
        ${row('Bookings', s.bookings, 'Placed in this period')}
        ${row('Booking lines', s.bookingLines, 'One row per SKU')}
        ${row('Booked quantity', s.bookingQty, '')}
        ${row('Bookings with a PO', s.bookingsWithPo, 'The rest are awaiting one')}
        ${row('Indents', s.indents, 'Raised in this period')}
        ${row('Indent lines', s.indentLines, 'One row per SKU')}
        ${row('Indent quantity', s.indentQty, 'Units awaiting stock')}
        ${row('Customers', s.customers, 'Across both histories')}
      </tbody>
    </table>
    <p style="margin:16px 0 4px;font-size:12px;color:#64748b;">
      ${attachments.length
        ? `Attached: ${attachments.map((a) => a.fileName).join(', ')}. Each row carries the customer
           name, shop number, location and type, the booking date and the PO number where one has been raised.`
        : 'No attachment could be generated for this run.'}
    </p>
    <p style="margin:0;font-size:11px;color:#94a3b8;">
      Records are included by creation date, so each booking and indent appears in exactly one weekly report.
    </p>
  `;
};

export default {
  buildHistoryXlsx,
  buildHistoryPdf,
  buildHistoryEmail,
  reportFileName,
  BOOKING_COLUMNS,
  INDENT_COLUMNS,
  PDF_DEFAULT_MAX_ROWS,
};
