import fs from 'fs';
import readline from 'readline';
import XLSX from 'xlsx';

/**
 * File readers (IMS Module M9).
 *
 * Both readers expose the same contract — an async iterable yielding one row at
 * a time — so the import service never knows which format it is consuming.
 *
 * CSV IS TRULY STREAMED. Memory is flat regardless of file size, so it is the
 * format to use for very large imports.
 *
 * XLSX IS READ IN ONE PASS, deliberately, after the streaming route was tried
 * and rejected. `ExcelJS.stream.xlsx.WorkbookReader` (4.4.0) is broken on this
 * stack in two independent ways:
 *
 *   • Shared strings. A text cell holds an index into a table stored in a
 *     separate zip entry that exceljs's own writer places AFTER the sheet.
 *     Whether the reader has that table when it parses the sheet depends on how
 *     the unzip stream interleaves, so the SAME file yields real strings on one
 *     run and `{ sharedString: 3 }` objects on the next.
 *   • Entry handling. On the deferred path it pipes the sheet entry to a temp
 *     file and then also calls `autodrain()` on it, which ends the zip iterator
 *     early — no later entry, including the shared-string table, is ever read.
 *
 * Either fault silently turns every text cell into an object, which would
 * surface as "SKU Code is required" on a file that plainly has one. Silent data
 * corruption in an importer is the worst possible failure, so the correct
 * library is used instead of a clever one.
 *
 * The cost is bounded rather than unbounded: the upload is capped at 40 MB and
 * the row count at 50,000, and the workbook is released as soon as its rows are
 * extracted. Anything larger belongs in CSV, which streams.
 *
 * This file knows nothing about inventory. It turns bytes into arrays of cell
 * values; what those values mean is the template registry's business.
 */

/** Rows beyond this are refused outright rather than half-imported. */
export const MAX_ROWS = 50_000;

/**
 * Read an .xlsx as an async iterable of { rowNumber, values }.
 *
 * `rowNumber` is the position among DATA rows (header excluded), 1-based, so it
 * matches what the error report needs to tell a user. The sheet's own row
 * number is off by one from that and would send people to the wrong line.
 */
export async function* readXlsx(filePath) {
  // `dense` keeps the sheet as arrays rather than an object keyed by "A1",
  // which is both smaller and faster to walk. `cellDates` turns date-formatted
  // cells into real Dates — without it an Effective Date column arrives as the
  // serial number 45678, which would validate happily and mean nothing.
  // Formulas, styles and HTML are dropped: an import reads values.
  const workbook = XLSX.readFile(filePath, {
    dense: true,
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    sheetStubs: false,
  });

  const sheetName = workbook.SheetNames[0];
  // Only the first worksheet is read. A workbook with several sheets is usually
  // one data sheet plus notes, and guessing which is which would be worse than
  // being explicit about it.
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) return;

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,        // arrays, not objects — the header is matched separately
    raw: true,        // no display formatting; the coercers handle types
    blankrows: false,
    defval: null,
  });

  // Released before the rows are walked, so the parsed workbook is not held
  // alive for the whole staging pass on top of the extracted rows.
  workbook.Sheets = null;
  workbook.SheetNames = null;

  let dataRowNumber = 0;
  let headerSeen = false;

  for (const values of rows) {
    const blank = !Array.isArray(values)
      || values.every((v) => v === null || v === undefined || String(v).trim() === '');

    if (!headerSeen) {
      // Leading blank rows are common in hand-made sheets; the first row with
      // content is the header.
      if (blank) continue;
      headerSeen = true;
      yield { header: true, values };
      continue;
    }

    // Trailing blank rows are an artefact of how spreadsheets are edited, not
    // data. Skipping them silently avoids "row 4,312 is empty" on every file.
    if (blank) continue;

    dataRowNumber += 1;
    yield { header: false, rowNumber: dataRowNumber, values };
    if (dataRowNumber >= MAX_ROWS) return;
  }
}

/**
 * Split one CSV line into fields.
 *
 * Hand-rolled rather than pulled from a dependency: the format is small, the
 * only cases that matter are quoted fields, embedded commas and doubled quotes,
 * and adding a parser dependency for that is not a trade worth making.
 *
 * A field containing a newline inside quotes is NOT supported — it would
 * require abandoning line-at-a-time reading, and inventory codes do not contain
 * newlines. A file that needs it should be saved as .xlsx.
 */
const splitCsvLine = (line) => {
  const out = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }  // escaped quote
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field); field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
};

/** Read a .csv as an async iterable, line by line. Same contract as readXlsx. */
export async function* readCsv(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let dataRowNumber = 0;
  let headerSeen = false;

  try {
    for await (const rawLine of lines) {
      // A UTF-8 BOM lands in the first header cell and breaks the match.
      const line = dataRowNumber === 0 && !headerSeen ? rawLine.replace(/^﻿/, '') : rawLine;
      if (line.trim() === '') continue;

      const values = splitCsvLine(line);
      if (!headerSeen) {
        headerSeen = true;
        yield { header: true, values };
        continue;
      }

      if (values.every((v) => v === '')) continue;
      dataRowNumber += 1;
      yield { header: false, rowNumber: dataRowNumber, values };
      if (dataRowNumber >= MAX_ROWS) return;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Pick the reader for a file type. */
export const readerFor = (fileType) => {
  if (fileType === 'csv') return readCsv;
  if (fileType === 'xlsx' || fileType === 'xls') return readXlsx;
  throw Object.assign(new Error(`Unsupported file type "${fileType}".`), { status: 400, code: 'UNSUPPORTED_FILE_TYPE' });
};

export default { readXlsx, readCsv, readerFor, MAX_ROWS };
