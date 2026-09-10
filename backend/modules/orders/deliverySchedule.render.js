import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

/**
 * Rendering a booking's DELIVERY SCHEDULE — .xlsx, .pdf and the HTML table that
 * goes in the body of the mail carrying them.
 *
 * ---------------------------------------------------------------------------
 * WHY ALL THREE LIVE IN ONE FILE
 * ---------------------------------------------------------------------------
 *
 * The customer is sent the same table three times over in one email: once as a
 * table they can read on a phone without downloading anything, once as a
 * spreadsheet they can filter, and once as a PDF they can file or print. Three
 * renderers built in three places is three chances for the spreadsheet to say
 * something the body does not, which on a document the customer treats as a
 * commitment is the one failure that matters.
 *
 * So THE COLUMNS ARE DEFINED ONCE — `scheduleColumns()` below — and all three
 * formats walk that same list. Adding a column adds it everywhere; changing what
 * a cell says changes it everywhere.
 *
 * NOTHING HERE QUERIES ANYTHING. Every function takes an already-gathered
 * document (see buildBookingScheduleDoc in utils/deliverySchedule.js) and
 * returns bytes or a string, which is what lets the layout be exercised without
 * a database and what stops the three formats drifting apart.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT IS THE CUSTOMER'S, NOT OURS
 * ---------------------------------------------------------------------------
 *
 * The column set and the two-tier header — FULL ORDER over the ordered
 * quantities, DELIVERY SCHEDULE over what has moved and what has not — are the
 * format the customer already reads these in. It is reproduced rather than
 * improved on: the point of the document is that it drops into a file next to
 * the ones already there.
 *
 *     |-------- FULL ORDER ---------|------- DELIVERY SCHEDULE --------|
 *     | PO No | Sr | Maruti | SKU | Qty | Qty Disp | Date | Pend | Sched |
 *
 * MARUTI CODE IS CONDITIONAL, and that is the only structural difference
 * between one customer's document and another's. See `scheduleColumns()`.
 */

const BRAND_ARGB = 'FF1A5B9E';
const BRAND_RGB = [26, 91, 158];
const SLATE_RGB = [100, 116, 139];
const GROUP_ARGB = 'FF15467A';

/**
 * `03-08-2026` — day-month-year, the format the reference document uses and the
 * one the Indian desk reads dates in.
 *
 * Written out by hand rather than via `toLocaleDateString`, for the reason set
 * out in deliveryScheduleMail.js: that call renders from whatever ICU data is
 * compiled into the Node the server happens to be running, so the same document
 * regenerated after a runtime upgrade would word its dates differently. A
 * document a customer keeps for a year should not do that.
 */
export const fmtDate = (d) => {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
};

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The two header bands the reference document groups its columns under. */
const ORDER_GROUP = 'FULL ORDER';
const SCHEDULE_GROUP = 'DELIVERY SCHEDULE';

/** Column headers referred to by name elsewhere in this file (totals row). */
const PO_COL = 'PO NO.';
const QTY_COL = 'Qty';
const DISPATCH_COL = 'QTY DISPATCH';
const PENDING_COL = 'QTY PENDING';

/**
 * The columns, for one specific customer's document.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT
 * ---------------------------------------------------------------------------
 *
 * Two things about the customer change the header row, so the list cannot be
 * decided until we know who the document is for:
 *
 * 1. MARUTI CODE. An MSIL customer orders BY the Maruti part number — it is the
 *    reference on their side of the transaction, and a schedule without it is
 *    one they have to translate before they can act on it. Every other customer
 *    has no Maruti number at all, and printing a column of blanks invites the
 *    question "why is this empty?" about a field that simply does not apply to
 *    them. So the column is present or absent, never present-and-empty. The rule
 *    for who is an MSIL customer is `customerCategory === 'MSIL'` and lives with
 *    the gather step, not here.
 *
 * 2. THE SKU COLUMN'S NAME. The reference document says "Koken Code" because
 *    Koken is what that customer buys. The portal also sells BIX and IMADA, and
 *    heading an IMADA line "Koken Code" would be wrong in the specific way that
 *    makes a customer distrust the rest of the sheet. When every line of the
 *    booking shares one brand the column is named for it; a mixed booking falls
 *    back to the neutral "SKU Code" rather than picking a winner.
 *
 * `pdfWidth` is a RATIO, not points — the PDF scales the whole set to whatever
 * width the page has (see buildSchedulePdf), so these numbers only have to be
 * right relative to each other.
 */
export const scheduleColumns = ({ showMsilCode = false, skuLabel = 'SKU Code' } = {}) => [
  { header: PO_COL, group: ORDER_GROUP, width: 16, pdfWidth: 72, get: (l) => l.poNumber || '' },
  { header: 'Sr. No.', group: ORDER_GROUP, width: 8, pdfWidth: 30, get: (l) => l.sr, numeric: true },
  ...(showMsilCode
    ? [{ header: 'Maruti Code', group: ORDER_GROUP, width: 18, pdfWidth: 78, get: (l) => l.msilCode || '' }]
    : []),
  { header: skuLabel, group: ORDER_GROUP, width: 20, pdfWidth: 86, get: (l) => l.skuCode || '' },
  { header: QTY_COL, group: ORDER_GROUP, width: 8, pdfWidth: 34, get: (l) => l.qty ?? 0, numeric: true },

  /*
   * A ZERO IS PRINTED AS BLANK on the two dispatch columns, which is what the
   * reference document does and is not merely cosmetic: "0 dispatched" and
   * "nothing has moved yet" are the same fact, and a column of zeroes down a
   * fresh purchase order reads as a report of failure rather than of a schedule
   * not yet begun. Qty Pending is NOT treated this way — a pending of zero means
   * the line is fully dispatched, which is information worth printing.
   */
  { header: DISPATCH_COL, group: SCHEDULE_GROUP, width: 12, pdfWidth: 46, get: (l) => l.qtyDispatched || '', numeric: true },
  { header: 'DISPATCH DATE', group: SCHEDULE_GROUP, width: 14, pdfWidth: 58, get: (l) => fmtDate(l.dispatchDate), date: true },
  { header: PENDING_COL, group: SCHEDULE_GROUP, width: 12, pdfWidth: 46, get: (l) => l.qtyPending ?? 0, numeric: true },
  { header: 'PENDING SCHEDULE', group: SCHEDULE_GROUP, width: 24, pdfWidth: 104, get: (l) => l.pendingSchedule || '' },
];

/**
 * What the totals row says under each column.
 *
 * Shared by all three renderers for the same reason the columns are: a subtotal
 * that disagrees between the spreadsheet and the PDF attached to the same email
 * is worse than no subtotal at all. Blank, not a dash, under the columns a total
 * is meaningless for — so the row reads as a subtotal rather than as a data row
 * with values missing.
 *
 * RETURNS THE RAW VALUE, numbers included, and each renderer stringifies for
 * itself. Excel is the reason: a total handed over as "52" lands as TEXT, which
 * sorts wrongly, refuses to sum, and shows the little green error triangle on a
 * document a customer opens. The PDF and the HTML are drawing glyphs either way,
 * so only the spreadsheet cares — and it is the one that has to be right.
 */
const totalFor = (column, doc) => {
  switch (column.header) {
    case PO_COL: return 'TOTAL';
    case QTY_COL: return doc.totals?.qty ?? 0;
    case DISPATCH_COL: return doc.totals?.dispatched || '';
    case PENDING_COL: return doc.totals?.pending ?? 0;
    default: return '';
  }
};

/** `Delivery_Schedule_PO-2026-000123.xlsx` — safe on every filesystem. */
export const scheduleFileName = (doc, extension) => {
  const ref = String(doc?.reference || doc?.orderId || 'Booking').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `Delivery_Schedule_${ref}.${extension}`;
};

/**
 * The header band row, as `[{ label, span }]`.
 *
 * Derived from the columns' own `group` rather than hard-coded, so a column
 * added to either band widens the band automatically instead of leaving the
 * merge one cell short — which in Excel is not a cosmetic error but a sheet that
 * opens looking corrupt.
 */
const groupBands = (columns) => {
  const bands = [];
  for (const c of columns) {
    const last = bands[bands.length - 1];
    if (last && last.label === c.group) last.span += 1;
    else bands.push({ label: c.group, span: 1 });
  }
  return bands;
};

/* -- Excel ----------------------------------------------------------------- */

export const buildScheduleXlsx = async (doc) => {
  const columns = scheduleColumns(doc);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shraddha Impex Portal';
  wb.created = doc.generatedAt || new Date();

  const sheet = wb.addWorksheet('Delivery Schedule', {
    properties: { defaultRowHeight: 16 },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = columns.map((c) => ({ width: c.width }));

  const lastCol = columns.length;
  const colLetter = sheet.getColumn(lastCol).letter;

  /* -- Who and what this is, before the table ---------------------------
   *
   * The reference document is the table alone, because it arrives inside a
   * folder that already says whose it is. An attachment on an email does not:
   * it is forwarded, saved to a desktop and opened months later with no
   * covering note, so it has to state its own subject.
   */
  const titleRow = sheet.addRow([doc.title || 'Delivery Schedule']);
  titleRow.font = { bold: true, size: 15, color: { argb: BRAND_ARGB } };
  sheet.mergeCells(`A1:${colLetter}1`);

  const meta = (label, value) => {
    if (value === null || value === undefined || value === '') return;
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF334155' } };
    row.getCell(2).font = { size: 10 };
    sheet.mergeCells(`B${row.number}:${colLetter}${row.number}`);
  };

  meta(doc.referenceLabel || 'Reference', doc.reference);
  meta('Booking Reference', doc.orderId);
  meta('Customer', doc.customer?.name);
  meta('PO Date', fmtDate(doc.poDate));
  meta('Delivery Schedule Date', fmtDate(doc.deliveryScheduleDate));
  meta('Total Ordered Qty', doc.totals?.qty ?? 0);
  meta('Total Pending Qty', doc.totals?.pending ?? 0);
  sheet.addRow([]);

  /* -- The two-tier header --------------------------------------------- */
  const bandRow = sheet.addRow([]);
  let col = 1;
  for (const band of groupBands(columns)) {
    bandRow.getCell(col).value = band.label;
    // mergeCells refuses a single-cell range, and a band of one column is a
    // legitimate shape once a conditional column is dropped.
    if (band.span > 1) {
      sheet.mergeCells(bandRow.number, col, bandRow.number, col + band.span - 1);
    }
    col += band.span;
  }
  for (let i = 1; i <= lastCol; i += 1) {
    const cell = bandRow.getCell(i);
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_ARGB } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
    };
  }

  const headRow = sheet.addRow(columns.map((c) => c.header));
  headRow.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  headRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  headRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB } };
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
    };
  });

  // Freeze everything above the first data row, so the header stays put however
  // long the booking is. Computed rather than a literal — the meta block above
  // is conditional, so its height is not knowable in advance.
  sheet.views = [{ state: 'frozen', ySplit: headRow.number }];

  for (const line of doc.lines || []) {
    const row = sheet.addRow(columns.map((c) => c.get(line)));
    row.font = { size: 10 };
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.alignment = { horizontal: c.numeric || c.date ? 'center' : 'left', vertical: 'middle' };
      cell.border = {
        top: { style: 'hair' }, left: { style: 'thin' }, bottom: { style: 'hair' }, right: { style: 'thin' },
      };
    });
  }

  if (!doc.lines?.length) {
    sheet.addRow(['No items on this schedule.']).font = { italic: true, color: { argb: 'FF64748B' } };
  } else {
    sheet.autoFilter = {
      from: { row: headRow.number, column: 1 },
      to: { row: headRow.number, column: lastCol },
    };

    // A totals row, because the first question asked of this sheet is "how much
    // is still outstanding" and nobody should have to select a column to find
    // out.
    const totalRow = sheet.addRow(columns.map((c) => totalFor(c, doc)));
    totalRow.font = { bold: true, size: 10, color: { argb: BRAND_ARGB } };
    totalRow.eachCell((cell, i) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF4FA' } };
      cell.alignment = { horizontal: columns[i - 1]?.numeric ? 'center' : 'left', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    });

    // Repeat the header band on every sheet of paper, not just the first.
    sheet.pageSetup.printTitlesRow = `${bandRow.number}:${headRow.number}`;
  }

  const buffer = await wb.xlsx.writeBuffer();
  return {
    format: 'xlsx',
    fileName: scheduleFileName(doc, 'xlsx'),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: Buffer.from(buffer),
  };
};

/* -- PDF ------------------------------------------------------------------- */

export const buildSchedulePdf = async (doc) =>
  new Promise((resolve, reject) => {
    try {
      const columns = scheduleColumns(doc);
      // PORTRAIT, unlike the weekly reports. This is a document about ONE
      // purchase order that a customer files or prints alongside the PO itself,
      // and nine columns fit an A4 width comfortably — see the pdfWidth ratios,
      // which total well under the usable span.
      const pdf = new PDFDocument({ size: 'A4', margin: 30, bufferPages: true });
      const chunks = [];
      pdf.on('data', (c) => chunks.push(c));
      pdf.on('error', reject);
      pdf.on('end', () => resolve({
        format: 'pdf',
        fileName: scheduleFileName(doc, 'pdf'),
        contentType: 'application/pdf',
        content: Buffer.concat(chunks),
      }));

      const left = pdf.page.margins.left;
      const right = pdf.page.width - pdf.page.margins.right;
      const usable = right - left;

      /* -- Header ------------------------------------------------------- */
      pdf.fillColor(BRAND_RGB).font('Helvetica-Bold').fontSize(16)
        .text(doc.title || 'Delivery Schedule', left, 34);
      pdf.fillColor(SLATE_RGB).font('Helvetica').fontSize(9)
        .text('Shraddha Impex Portal', left, 54);

      let y = 74;
      const facts = [
        [doc.referenceLabel || 'Reference', doc.reference],
        ['Booking Reference', doc.orderId],
        ['Customer', doc.customer?.name],
        ['PO Date', fmtDate(doc.poDate)],
        ['Delivery Schedule Date', fmtDate(doc.deliveryScheduleDate)],
        ['Total Ordered Qty', String(doc.totals?.qty ?? 0)],
        ['Total Pending Qty', String(doc.totals?.pending ?? 0)],
      ].filter(([, v]) => v !== null && v !== undefined && v !== '');

      // Two columns of label/value, so the block stays short on a page whose
      // real content is the table below it.
      const factW = usable / 2;
      facts.forEach(([label, value], i) => {
        const fx = left + (i % 2) * factW;
        const fy = y + Math.floor(i / 2) * 14;
        pdf.fillColor(SLATE_RGB).font('Helvetica-Bold').fontSize(7.5)
          .text(String(label).toUpperCase(), fx, fy, { width: factW * 0.42, lineBreak: false });
        pdf.fillColor([51, 65, 85]).font('Helvetica').fontSize(8.5)
          .text(String(value), fx + factW * 0.44, fy - 1, { width: factW * 0.54, lineBreak: false, ellipsis: true });
      });
      y += Math.ceil(facts.length / 2) * 14 + 8;

      pdf.moveTo(left, y).lineTo(right, y).strokeColor(BRAND_RGB).lineWidth(1).stroke();
      y += 12;

      /* -- The table ----------------------------------------------------
       *
       * Drawn by hand: pdfkit has no table primitive, which is why every column
       * carries a pdfWidth and why the inventory and history reports take the
       * same approach. Scaled to the page rather than trusted to fit, so
       * dropping the Maruti column widens the rest instead of leaving a gap.
       */
      const total = columns.reduce((n, c) => n + c.pdfWidth, 0);
      const scale = usable / total;
      const widthOf = (c) => c.pdfWidth * scale;
      const rowH = 15;
      const bandH = 14;
      // Tall enough for a header that WRAPS. "QTY DISPATCH" and "QTY PENDING"
      // are two lines in their columns — as they are in the reference document —
      // and at 20pt the second line spilled into the first data row.
      const headH = 24;
      const bottom = pdf.page.height - pdf.page.margins.bottom - 24;

      const drawHead = () => {
        // Band row — FULL ORDER | DELIVERY SCHEDULE.
        let bx = left;
        let idx = 0;
        for (const band of groupBands(columns)) {
          const span = columns.slice(idx, idx + band.span).reduce((n, c) => n + widthOf(c), 0);
          pdf.rect(bx, y, span, bandH)
            .fillAndStroke([21, 70, 122], [255, 255, 255]);
          pdf.fillColor([255, 255, 255]).font('Helvetica-Bold').fontSize(7.5)
            .text(band.label, bx, y + 4, { width: span, align: 'center', lineBreak: false });
          bx += span;
          idx += band.span;
        }
        y += bandH;

        // Column row.
        pdf.rect(left, y, usable, headH).fillAndStroke(BRAND_RGB, [255, 255, 255]);
        let cx = left;
        pdf.fillColor([255, 255, 255]).font('Helvetica-Bold').fontSize(6.6);
        for (const c of columns) {
          const w = widthOf(c) - 4;
          // Measured and centred, rather than dropped at a fixed offset: a
          // one-line header and a two-line one have to sit in the same band, and
          // a constant offset can only look right for one of them.
          const h = pdf.heightOfString(c.header, { width: w, align: 'center' });
          pdf.text(c.header, cx + 2, y + Math.max(2, (headH - h) / 2), { width: w, align: 'center' });
          cx += widthOf(c);
        }
        y += headH;
      };

      drawHead();

      const lines = doc.lines || [];
      lines.forEach((line, i) => {
        if (y + rowH > bottom) {
          pdf.addPage();
          y = pdf.page.margins.top;
          drawHead();
        }
        if (i % 2 === 1) pdf.rect(left, y, usable, rowH).fill([248, 250, 252]);

        let cx = left;
        for (const c of columns) {
          pdf.fillColor([51, 65, 85]).font('Helvetica').fontSize(7)
            .text(String(c.get(line) ?? ''), cx + 2, y + 4, {
              width: widthOf(c) - 4,
              align: c.numeric || c.date ? 'center' : 'left',
              lineBreak: false,
              ellipsis: true,
            });
          cx += widthOf(c);
        }
        pdf.moveTo(left, y + rowH).lineTo(right, y + rowH)
          .strokeColor([226, 232, 240]).lineWidth(0.4).stroke();
        y += rowH;
      });

      if (!lines.length) {
        pdf.fillColor(SLATE_RGB).font('Helvetica-Oblique').fontSize(8)
          .text('No items on this schedule.', left, y + 6, { width: usable });
        y += 20;
      } else {
        // Totals, matching the spreadsheet's.
        if (y + rowH > bottom) { pdf.addPage(); y = pdf.page.margins.top; drawHead(); }
        pdf.rect(left, y, usable, rowH).fillAndStroke([239, 244, 250], [226, 232, 240]);
        let cx = left;
        for (const c of columns) {
          pdf.fillColor(BRAND_RGB).font('Helvetica-Bold').fontSize(7)
            .text(String(totalFor(c, doc)), cx + 2, y + 4, {
              width: widthOf(c) - 4,
              align: c.numeric ? 'center' : 'left',
              lineBreak: false,
            });
          cx += widthOf(c);
        }
        y += rowH;
      }

      /* -- Footer on every page ----------------------------------------- */
      const range = pdf.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        pdf.switchToPage(range.start + i);
        const fy = pdf.page.height - pdf.page.margins.bottom - 10;
        pdf.moveTo(left, fy - 5).lineTo(right, fy - 5)
          .strokeColor([226, 232, 240]).lineWidth(0.5).stroke();
        pdf.fillColor(SLATE_RGB).font('Helvetica').fontSize(7)
          .text(
            `Shraddha Impex Portal — delivery schedule for ${doc.reference || doc.orderId}`,
            left, fy, { width: usable / 2, lineBreak: false },
          );
        pdf.text(`Page ${i + 1} of ${range.count}`, left + usable / 2, fy, {
          width: usable / 2, align: 'right', lineBreak: false,
        });
      }

      pdf.end();
    } catch (error) {
      reject(error);
    }
  });

/* -- HTML ------------------------------------------------------------------ */

/**
 * The same table, for the body of the email.
 *
 * Present so the mail is USEFUL WITHOUT OPENING AN ATTACHMENT — read on a phone,
 * a customer can see what is pending without downloading a spreadsheet they
 * cannot open there. Inline styles and a plain `<table>` throughout, because
 * that is the only layout every mail client agrees on.
 */
export const scheduleTableHtml = (doc) => {
  const columns = scheduleColumns(doc);
  const cell = 'padding:6px 8px;border:1px solid #d7e0ea;font-size:12px;';
  const head = 'padding:7px 8px;border:1px solid #ffffff;font-size:11px;color:#ffffff;font-weight:bold;text-align:center;';

  const bandHtml = groupBands(columns)
    .map((b) => `<th colspan="${b.span}" style="${head}background:#15467a;">${esc(b.label)}</th>`)
    .join('');

  const headHtml = columns
    .map((c) => `<th style="${head}background:#1a5b9e;">${esc(c.header)}</th>`)
    .join('');

  const bodyHtml = (doc.lines || [])
    .map((l, i) => {
      const bg = i % 2 === 1 ? 'background:#f8fafc;' : '';
      const cells = columns
        .map((c) => {
          const align = c.numeric || c.date ? 'text-align:center;' : '';
          return `<td style="${cell}${bg}${align}">${esc(c.get(l))}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  const totalsHtml = (doc.lines || []).length
    ? `<tr>${columns
      .map((c) => {
        const align = c.numeric ? 'text-align:center;' : '';
        return `<td style="${cell}${align}background:#eff4fa;font-weight:bold;color:#1a5b9e;">${esc(totalFor(c, doc))}</td>`;
      })
      .join('')}</tr>`
    : '';

  const empty = `<tr><td colspan="${columns.length}" style="${cell}color:#64748b;font-style:italic;">No items on this schedule.</td></tr>`;

  return [
    '<div style="overflow-x:auto;">',
    '<table style="border-collapse:collapse;font-family:Arial,sans-serif;width:100%;">',
    `<thead><tr>${bandHtml}</tr><tr>${headHtml}</tr></thead>`,
    `<tbody>${bodyHtml || empty}${totalsHtml}</tbody>`,
    '</table>',
    '</div>',
  ].join('');
};

export default {
  scheduleColumns,
  scheduleFileName,
  buildScheduleXlsx,
  buildSchedulePdf,
  scheduleTableHtml,
  fmtDate,
};
