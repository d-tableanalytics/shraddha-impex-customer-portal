/**
 * The relieving and experience letter, as a PDF.
 *
 * The reference renders this with `pdf-lib`. There is no PDF library in this
 * backend and none of the other modules needs one, so rather than pull a
 * dependency in for a single page of text, the file is emitted directly.
 *
 * That is a smaller decision than it looks: the letter is plain text in one of
 * the fourteen standard PDF fonts, which every reader has built in, so no font
 * embedding — the part of PDF generation that genuinely wants a library — is
 * involved. What is left is an object table and a content stream.
 *
 * The layout mirrors the reference's: navy banner, date, "TO WHOM IT MAY
 * CONCERN", body, sign-off.
 */

/** A4 in PostScript points, as the reference uses. */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;

/** The brand navy, as an RGB triple in the 0–1 range PDF wants. */
const NAVY = [0.008, 0.251, 0.545];
const DARK = [0.102, 0.137, 0.196];

/**
 * Escape a string for a PDF literal.
 *
 * Backslash first — escaping it after the parens would double-escape the
 * backslashes those introduce. Characters outside WinAnsi are dropped rather
 * than written raw, which would produce a corrupt stream.
 */
const pdfText = (value) =>
  String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '');

/**
 * Render the letter.
 *
 * @returns {Promise<Buffer>} the PDF bytes.
 */
export async function renderRelievingLetter({
  employeeName,
  designation = '',
  department = '',
  dateOfJoining = '',
  lastWorkingDay = '',
  companyName = 'Shraddha Impex',
}) {
  const ops = [];
  const write = (line) => ops.push(line);

  // ---- banner ------------------------------------------------------------
  const bannerHeight = 40;
  const bannerY = PAGE_HEIGHT - 80;
  write(`${NAVY.join(' ')} rg`);
  write(`0 ${bannerY} ${PAGE_WIDTH} ${bannerHeight} re f`);

  write('BT');
  write('1 1 1 rg');
  write('/F2 14 Tf');
  write(`${MARGIN} ${bannerY + 14} Td`);
  write(`(${pdfText('RELIEVING & EXPERIENCE LETTER')}) Tj`);
  write('ET');

  // ---- body --------------------------------------------------------------
  let y = bannerY - 40;
  const line = (text, { font = 'F1', size = 10, gap = 16 } = {}) => {
    if (text !== '') {
      write('BT');
      write(`${DARK.join(' ')} rg`);
      write(`/${font} ${size} Tf`);
      write(`${MARGIN} ${y} Td`);
      write(`(${pdfText(text)}) Tj`);
      write('ET');
    }
    y -= gap;
  };

  line(`Date: ${new Date().toISOString().slice(0, 10)}`, { gap: 30 });
  line('TO WHOM IT MAY CONCERN', { font: 'F2', size: 12, gap: 24 });

  const where = [
    designation ? `as ${designation}` : '',
    department ? `in the ${department} department` : '',
  ]
    .filter(Boolean)
    .join(' ');

  for (const text of [
    `This is to certify that ${employeeName} was employed with ${companyName}`,
    `${where ? `${where}, ` : ''}from ${dateOfJoining} to ${lastWorkingDay}.`,
    '',
    'During the tenure, the employee handled the responsibilities assigned with',
    'due diligence and integrity. All company dues, assets, and clearances have',
    'been settled satisfactorily.',
    '',
    'We wish them the very best in their future endeavours.',
    '',
    'Warm regards,',
    `${companyName} — Human Resources`,
  ]) {
    line(text);
  }

  return assemblePdf(ops.join('\n'));
}

/**
 * Wrap a content stream in the smallest valid PDF document.
 *
 * The cross-reference table stores each object's byte offset, so offsets are
 * measured as the body is built rather than guessed.
 */
function assemblePdf(contentStream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets = [];

  objects.forEach((object, index) => {
    offsets.push(header.length + Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = header.length + Buffer.byteLength(body, 'latin1');

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'latin1');
}

export default { renderRelievingLetter };
