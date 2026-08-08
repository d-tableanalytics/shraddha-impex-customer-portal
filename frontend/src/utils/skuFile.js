import * as XLSX from 'xlsx';

/**
 * Pull SKU codes out of an uploaded workbook.
 *
 * Takes a column called something like "SKU" when the sheet has headers, and
 * falls back to the first column when it does not — a list of codes pasted into
 * a blank sheet is the most common shape this receives, and refusing it for
 * lacking a header would be pedantry.
 *
 * Shared by the admin stock check and the customer bulk upload so the two agree
 * on what counts as a SKU column; they previously would have drifted.
 */
export const readSkuCodes = (rows) => {
  if (rows.length === 0) return [];

  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const skuIndex = header.findIndex((h) => /^(sku|sku ?code|item ?code|part ?no\.?)$/.test(h));

  const startRow = skuIndex >= 0 ? 1 : 0;
  const column = skuIndex >= 0 ? skuIndex : 0;

  return rows
    .slice(startRow)
    .map((r) => String(r?.[column] ?? '').trim())
    .filter(Boolean);
};

/** Read the first sheet of an uploaded file and return its SKU codes. */
export const readSkuCodesFromFile = async (file) => {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return readSkuCodes(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
};

/**
 * Extract both SKU codes and MSIL codes from spreadsheet rows.
 *
 * Returns `{ skuCodes: string[], msilCodes: string[] }` — each array is
 * deduped and order-preserved. A sheet with only one of the two columns is
 * fine; the other array will simply be empty.
 */
export const readCodes = (rows) => {
  if (rows.length === 0) return { skuCodes: [], msilCodes: [] };

  const header = (rows[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const skuIndex = header.findIndex((h) => /^(sku|sku ?code|item ?code|part ?no\.?)$/.test(h));
  const msilIndex = header.findIndex((h) => /^(msil|msil ?code)$/.test(h));

  const hasHeaders = skuIndex >= 0 || msilIndex >= 0;
  const startRow = hasHeaders ? 1 : 0;
  // When no headers are found, fall back to the first column as SKU (same as
  // readSkuCodes) and leave MSIL empty.
  const skuCol = skuIndex >= 0 ? skuIndex : (hasHeaders ? -1 : 0);
  const msilCol = msilIndex >= 0 ? msilIndex : -1;

  const skuSeen = new Set();
  const msilSeen = new Set();
  const skuCodes = [];
  const msilCodes = [];

  for (let i = startRow; i < rows.length; i++) {
    const r = rows[i];
    if (skuCol >= 0) {
      const v = String(r?.[skuCol] ?? '').trim();
      if (v && !skuSeen.has(v)) { skuSeen.add(v); skuCodes.push(v); }
    }
    if (msilCol >= 0) {
      const v = String(r?.[msilCol] ?? '').trim();
      if (v && !msilSeen.has(v)) { msilSeen.add(v); msilCodes.push(v); }
    }
  }

  return { skuCodes, msilCodes };
};

/** Read the first sheet of an uploaded file and return both SKU + MSIL codes. */
export const readCodesFromFile = async (file) => {
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return readCodes(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
};

export default { readSkuCodes, readSkuCodesFromFile, readCodes, readCodesFromFile };
