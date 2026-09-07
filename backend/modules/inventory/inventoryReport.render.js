import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { REPORT_BANDS, bandStyle } from './inventoryReport.service.js';

/**
 * Rendering the weekly inventory health report — .xlsx and .pdf.
 *
 * BOTH RENDERERS TAKE THE SAME GATHERED REPORT and neither queries anything.
 * They are given rows and a summary and produce bytes; that is the whole
 * contract. It means the two formats cannot disagree about what the week looked
 * like, and it means the renderers can be exercised without a database.
 *
 * The colours are the ones the requirement names — green healthy, amber low,
 * orange critical, red out of stock — and they are defined ONCE, beside the
 * bands themselves in inventoryReport.service.js, so the spreadsheet, the PDF
 * and the email body cannot drift into three different shades of "critical".
 */

const brandBlue = '1A5B9E';
const BRAND_RGB = [26, 91, 158];
const SLATE_RGB = [100, 116, 139];

/**
 * ARGB (what Excel wants) to hex (what pdfkit wants).
 *
 * The band colours are stored once, in Excel's form, because that is the one of
 * the two that cannot express a plain hex. Dropping the leading alpha pair here
 * is the whole conversion, and doing it in a named function keeps a
 * `.replace('FF', '#')` — which quietly mangles any colour whose red channel is
 * also FF — out of the drawing code.
 */
const hexOf = (argb) => `#${String(argb).slice(2)}`;

const nf = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));

const pct = (n) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`);

const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtDateTime = (d, timezone) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

/** `Inventory_Health_2026-W36.xlsx` — safe on every filesystem. */
export const reportFileName = (report, extension) =>
  `Inventory_Health_${report.occurrence.label}.${extension}`;

/**
 * The line the summary shows about which thresholds produced these bands.
 *
 * Always present, because "why is this SKU amber" is the first question a
 * reader has and the answer is a number they cannot see anywhere else on the
 * page. Louder when the report is NOT using the system's own configuration,
 * since then it will not match the Inventory Health screen.
 */
const thresholdLine = (report) => {
  const base = `Bands: Critical at or below ${report.thresholds.critical}% of target, `
    + `Low at or below ${report.thresholds.low}%, Healthy up to ${report.thresholds.healthy}%.`;
  return report.usingOverrides
    ? `${base}  NOTE: report-specific thresholds are in force, so these bands do NOT match `
      + `the Inventory Health screen (configured: critical ${report.configuredThresholds.critical}%, `
      + `low ${report.configuredThresholds.low}%).`
    : base;
};

/* ── Excel ────────────────────────────────────────────────────────────────── */

const COLUMNS = [
  { header: 'SKU / Item ID', width: 20, get: (r) => r.skuCode },
  { header: 'Product Name', width: 38, get: (r) => r.name },
  { header: 'Brand', width: 10, get: (r) => r.brand },
  { header: 'Available Qty', width: 14, get: (r) => r.available, numeric: true },
  { header: 'On Hand', width: 12, get: (r) => r.onHand, numeric: true },
  { header: 'Reserved', width: 12, get: (r) => r.reserved, numeric: true },
  // Null stays null so the cell is blank rather than a zero that reads as a
  // real reorder point of nothing.
  { header: 'Reorder Level', width: 14, get: (r) => (r.reorderLevel === null ? null : Math.round(r.reorderLevel)), numeric: true },
  { header: 'Status', width: 16, get: (r) => r.band, status: true },
  { header: 'Cover %', width: 10, get: (r) => (r.replenishmentPercent === null ? null : Number(r.replenishmentPercent.toFixed(1))), numeric: true },
  { header: 'Last Updated', width: 20, get: (r) => (r.lastUpdated ? new Date(r.lastUpdated) : null), date: true },
];

/**
 * Build the .xlsx.
 *
 * NOT the streaming writer the on-demand exports use. That one exists to keep
 * memory flat while a user waits on a download; this runs once a week, unwatched,
 * and needs per-cell fills and a second sheet — both of which the streaming
 * writer makes awkward or impossible. A few thousand rows in memory for a few
 * seconds is the right trade here and the wrong one there.
 */
export const buildInventoryHealthXlsx = async (report) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shraddha Impex Portal';
  wb.created = report.generatedAt;

  /* ── Summary sheet ──────────────────────────────────────────────────── */
  const summary = wb.addWorksheet('Summary', {
    properties: { defaultRowHeight: 18 },
    pageSetup: { paperSize: 9, orientation: 'portrait' },
  });
  summary.columns = [{ width: 34 }, { width: 18 }, { width: 52 }];

  const title = summary.addRow(['Weekly Inventory Health Report']);
  title.font = { bold: true, size: 16, color: { argb: `FF${brandBlue}` } };
  summary.mergeCells('A1:C1');

  summary.addRow([`Week ${report.occurrence.label}`, '', '']).font = { bold: true, size: 11 };
  summary.addRow(['Generated', fmtDateTime(report.generatedAt, report.timezone), `Timezone: ${report.timezone}`]);
  summary.addRow(['Week beginning', fmtDate(report.occurrence.weekStart), '']);
  if (report.brands) summary.addRow(['Brands', report.brands.join(', '), '']);
  summary.addRow([]);

  const thresholdRow = summary.addRow(['', '', thresholdLine(report)]);
  thresholdRow.getCell(3).alignment = { wrapText: true, vertical: 'top' };
  thresholdRow.getCell(3).font = {
    italic: true, size: 9, color: { argb: report.usingOverrides ? 'FFB45309' : 'FF64748B' },
  };
  thresholdRow.height = 34;
  summary.addRow([]);

  const head = summary.addRow(['Inventory Status', 'Products', 'Meaning']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${brandBlue}` } };
    cell.alignment = { vertical: 'middle' };
  });

  for (const band of REPORT_BANDS) {
    const row = summary.addRow([band.label, report.summary[band.key] ?? 0, band.note]);
    // The colour IS the status here — the same fill the detail sheet uses, so a
    // reader learns the key on the summary and carries it to the rows.
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: band.fill } };
    row.getCell(1).font = { bold: true, color: { argb: band.argb } };
    row.getCell(2).font = { bold: true };
    row.getCell(2).alignment = { horizontal: 'right' };
    row.getCell(3).font = { size: 9, color: { argb: 'FF64748B' } };
  }

  const totalRow = summary.addRow(['Total products', report.summary.total, '']);
  totalRow.font = { bold: true };
  totalRow.getCell(2).alignment = { horizontal: 'right' };
  totalRow.eachCell((cell) => {
    cell.border = { top: { style: 'thin', color: { argb: 'FF94A3B8' } } };
  });

  summary.addRow([]);
  const attention = summary.addRow([
    'Needs attention',
    report.summary.needsAttention,
    'Out of Stock + Critical + Low',
  ]);
  attention.font = { bold: true, color: { argb: 'FFDC2626' } };
  attention.getCell(2).alignment = { horizontal: 'right' };

  /* ── Detail sheet ───────────────────────────────────────────────────── */
  const sheet = wb.addWorksheet('Inventory Health', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${brandBlue}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });

  for (const r of report.rows) {
    const row = sheet.addRow(COLUMNS.map((c) => c.get(r)));
    const style = bandStyle(r.band);

    COLUMNS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.numeric) {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      }
      if (c.date) cell.numFmt = 'dd-mmm-yyyy hh:mm';
      if (c.status) {
        // The colour coding the requirement asks to be "clearly visible": a
        // filled, bold status cell rather than a tinted whole row, which turns
        // a 7,000-row sheet into a wall of colour nobody can read.
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
        cell.font = { bold: true, color: { argb: style.argb } };
        cell.alignment = { horizontal: 'center' };
      }
    });
  }

  // Filter and sort the sheet by hand — the recipient's first instinct will be
  // to narrow it to one status.
  if (report.rows.length) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  }

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
 * How many detail rows the PDF carries before it stops and points at the
 * spreadsheet.
 *
 * A full catalogue is several thousand SKUs, which is two hundred-odd pages —
 * an attachment nobody opens and every mail server resents. The rows are
 * ordered worst-first, so a cap always keeps the ones that need doing and drops
 * the healthy tail. The PDF says exactly how many it left out, and the .xlsx
 * (sent alongside by default) has every one.
 */
export const PDF_DEFAULT_MAX_ROWS = 500;

const PDF_COLUMNS = [
  { header: 'SKU', width: 92, get: (r) => r.skuCode },
  { header: 'Product', width: 150, get: (r) => r.name },
  { header: 'Brand', width: 46, get: (r) => r.brand },
  { header: 'Avail.', width: 46, get: (r) => nf(r.available), align: 'right' },
  { header: 'On Hand', width: 48, get: (r) => nf(r.onHand), align: 'right' },
  { header: 'Reorder', width: 48, get: (r) => (r.reorderLevel === null ? '—' : nf(Math.round(r.reorderLevel))), align: 'right' },
  { header: 'Status', width: 72, get: (r) => r.band, status: true },
  { header: 'Updated', width: 62, get: (r) => fmtDate(r.lastUpdated), align: 'right' },
];

export const buildInventoryHealthPdf = async (report, { maxRows = PDF_DEFAULT_MAX_ROWS } = {}) =>
  new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true });
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
        .text('Weekly Inventory Health Report', left, 34);
      doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(9)
        .text(`Week ${report.occurrence.label}  ·  week beginning ${fmtDate(report.occurrence.weekStart)}`, left, 56);
      doc.text(`Generated ${fmtDateTime(report.generatedAt, report.timezone)} (${report.timezone})`, left, 68);
      if (report.brands) doc.text(`Brands: ${report.brands.join(', ')}`, left, 80);

      doc.moveTo(left, 94).lineTo(right, 94).strokeColor(BRAND_RGB).lineWidth(1).stroke();

      // ── Summary tiles ───────────────────────────────────────────────────
      // The four the requirement names, plus the total. Overstock and Unknown
      // are counted in the table's own key rather than given a tile — they are
      // not actions.
      const tiles = [
        { label: 'Total Products', value: report.summary.total, rgb: BRAND_RGB },
        ...REPORT_BANDS.filter((b) => ['healthy', 'low', 'critical', 'outOfStock'].includes(b.key))
          .map((b) => ({ label: b.label, value: report.summary[b.key] ?? 0, rgb: b.rgb })),
      ];

      const gap = 8;
      const tileW = (usable - gap * (tiles.length - 1)) / tiles.length;
      let x = left;
      const tileY = 106;
      for (const tile of tiles) {
        doc.roundedRect(x, tileY, tileW, 46, 4)
          .fillAndStroke([248, 250, 252], [226, 232, 240]);
        doc.fillColor(tile.rgb).font('Helvetica-Bold').fontSize(18)
          .text(nf(tile.value), x + 10, tileY + 8, { width: tileW - 20 });
        doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(7.5)
          .text(String(tile.label).toUpperCase(), x + 10, tileY + 31, { width: tileW - 20, characterSpacing: 0.5 });
        x += tileW + gap;
      }

      doc.fillColor(SLATE_RGB).font('Helvetica-Oblique').fontSize(7.5)
        .text(thresholdLine(report), left, tileY + 56, { width: usable });

      // ── Detail table ────────────────────────────────────────────────────
      const shown = report.rows.slice(0, Math.max(0, maxRows));
      const omitted = report.rows.length - shown.length;

      let y = doc.y + 10;
      const rowH = 14;
      const bottom = doc.page.height - doc.page.margins.bottom - 22;

      const drawHeader = () => {
        doc.rect(left, y, usable, rowH + 3).fill(BRAND_RGB);
        let cx = left + 4;
        doc.fillColor([255, 255, 255]).font('Helvetica-Bold').fontSize(7.5);
        for (const c of PDF_COLUMNS) {
          doc.text(c.header, cx, y + 5, { width: c.width - 6, align: c.align || 'left', lineBreak: false });
          cx += c.width;
        }
        y += rowH + 5;
      };

      const newPage = () => {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      };

      drawHeader();

      shown.forEach((r, i) => {
        if (y + rowH > bottom) newPage();

        // Zebra striping. Faint — the status colour has to stay the loudest
        // thing on the row.
        if (i % 2 === 1) doc.rect(left, y - 2, usable, rowH).fill([248, 250, 252]);

        const style = bandStyle(r.band);
        let cx = left + 4;
        for (const c of PDF_COLUMNS) {
          const value = c.get(r);
          if (c.status) {
            // A filled chip, so the status reads at a glance on paper as well
            // as on screen — a coloured word alone is too thin to scan.
            const chipW = c.width - 8;
            doc.roundedRect(cx - 2, y - 2, chipW, rowH - 1, 2).fill(hexOf(style.fill));
            doc.fillColor(style.rgb).font('Helvetica-Bold').fontSize(6.8)
              .text(String(value), cx, y + 1.5, { width: chipW - 4, align: 'center', lineBreak: false });
          } else {
            doc.fillColor([51, 65, 85]).font('Helvetica').fontSize(7)
              .text(String(value ?? '—'), cx, y + 1.5, {
                width: c.width - 6, align: c.align || 'left', lineBreak: false, ellipsis: true,
              });
          }
          cx += c.width;
        }
        y += rowH;
      });

      if (omitted > 0) {
        if (y + 26 > bottom) newPage();
        doc.fillColor([180, 83, 9]).font('Helvetica-Oblique').fontSize(8)
          .text(
            `… and ${nf(omitted)} more product(s), omitted to keep this document readable. `
            + 'Rows are ordered most urgent first, so everything needing attention is above. '
            + 'The Excel attachment contains the complete list.',
            left, y + 8, { width: usable },
          );
      }

      if (report.rows.length === 0) {
        doc.fillColor(SLATE_RGB).font('Helvetica-Oblique').fontSize(9)
          .text('No inventory health records were found for this report.', left, y + 8, { width: usable });
      }

      // ── Footer on every page ────────────────────────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const fy = doc.page.height - doc.page.margins.bottom - 12;
        doc.moveTo(left, fy - 4).lineTo(right, fy - 4).strokeColor([226, 232, 240]).lineWidth(0.5).stroke();
        doc.fillColor(SLATE_RGB).font('Helvetica').fontSize(7)
          .text('Shraddha Impex Portal — automated weekly inventory health report', left, fy, {
            width: usable / 2, lineBreak: false,
          });
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
 * The short summary the requirement asks for in the email itself.
 *
 * Written so the mail is USEFUL WITHOUT OPENING THE ATTACHMENT — the counts and
 * the headline are right there. Someone reading it on a phone should be able to
 * tell whether anything needs doing before they get to a desk.
 */
export const buildInventoryHealthEmail = (report, attachments = []) => {
  const s = report.summary;
  const cell = (band) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#${band.argb.slice(2)};margin-right:8px;"></span>
        <strong style="color:#334155;">${band.label}</strong>
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:bold;color:#0f172a;">
        ${nf(s[band.key] ?? 0)}
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;">${band.note}</td>
    </tr>`;

  const headline = s.needsAttention > 0
    ? `<p style="margin:0 0 14px;padding:10px 12px;background:#fef2f2;border-left:3px solid #dc2626;color:#991b1b;">
         <strong>${nf(s.needsAttention)}</strong> of ${nf(s.total)} products need attention
         — ${nf(s.outOfStock)} out of stock, ${nf(s.critical)} critical, ${nf(s.low)} low.
       </p>`
    : `<p style="margin:0 0 14px;padding:10px 12px;background:#f0fdf4;border-left:3px solid #16a34a;color:#166534;">
         No products are out of stock, critical or low. All ${nf(s.total)} products are within their target levels.
       </p>`;

  return `
    <h3 style="margin:0 0 4px;color:#1a5b9e;">Weekly Inventory Health Report — ${report.occurrence.label}</h3>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b;">
      Week beginning ${fmtDate(report.occurrence.weekStart)} ·
      generated ${fmtDateTime(report.generatedAt, report.timezone)}
      ${report.brands ? ` · brands: ${report.brands.join(', ')}` : ''}
    </p>
    ${headline}
    <table style="border-collapse:collapse;width:100%;max-width:560px;">
      <tbody>
        ${REPORT_BANDS.map(cell).join('')}
        <tr>
          <td style="padding:8px 10px;font-weight:bold;color:#0f172a;">Total products</td>
          <td style="padding:8px 10px;text-align:right;font-weight:bold;color:#0f172a;">${nf(s.total)}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
    <p style="margin:16px 0 4px;font-size:12px;color:#64748b;">
      ${attachments.length
        ? `Attached: ${attachments.map((a) => a.fileName).join(', ')}.`
        : 'No attachment could be generated for this run.'}
    </p>
    <p style="margin:0;font-size:11px;color:#94a3b8;">${thresholdLine(report)}</p>
  `;
};

export default {
  buildInventoryHealthXlsx,
  buildInventoryHealthPdf,
  buildInventoryHealthEmail,
  reportFileName,
  PDF_DEFAULT_MAX_ROWS,
};
