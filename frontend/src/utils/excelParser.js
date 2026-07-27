import * as XLSX from "xlsx";
import { revalidateRow } from "../store/bulkImportStore";

// `showMsilCode` mirrors the caller's MSIL visibility rule. When false the MSIL
// column is ignored even if the sheet contains one, so a Non-MSIL customer who
// uploads an MSIL-style template is never failed on a code that doesn't apply
// to them — their rows are resolved by SKU Code alone.
export const parseExcelFile = async (file, showMsilCode = true) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: "binary" });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        // Convert sheet to JSON
        const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        // Process rows, skip header
        const rows = [];
        const mergedRowsMap = new Map();
        const headers = rawRows[0] || [];
        // Find column indices
        const getIndex = (names) => {
          return headers.findIndex((h) =>
            names.some(
              (n) =>
                typeof h === "string" &&
                h.toLowerCase().includes(n.toLowerCase()),
            ),
          );
        };
        const cSKU = getIndex(["SKU Code", "SKU", "Product Code", "Product"]);
        const cMSIL = showMsilCode ? getIndex(["MSIL Code", "MSIL"]) : -1;
        const cQty = getIndex(["Quantity", "Qty"]);

        for (let i = 1; i < rawRows.length; i++) {
          const rowData = rawRows[i];
          // Skip completely empty rows
          if (!rowData || rowData.length === 0) continue;
          const skuCode = cSKU >= 0 ? String(rowData[cSKU] || "").trim() : "";
          const msilCode = cMSIL >= 0 ? String(rowData[cMSIL] || "").trim() : "";
          const quantity = cQty >= 0 ? Number(rowData[cQty]) || 0 : 0;
          // Skip rows with no data at all (blank lines within the sheet).
          if (!skuCode && !msilCode && !quantity) continue;
          const newRow = {
            id: `row-${i}-${Date.now()}`,
            originalRowNumber: i + 1,
            skuCode,
            msilCode,
            quantity,
          };

          const validatedRow = revalidateRow(newRow);

          // Handle duplicates by merging
          // We merge rows based on the combination of SKU and MSIL if both are present,
          // or whichever is present.
          const mergeKey = `${skuCode}_${msilCode}`;
          
          if (mergeKey !== "_" && mergedRowsMap.has(mergeKey)) {
            const existingRow = mergedRowsMap.get(mergeKey);
            const updatedRow = {
              ...existingRow,
              quantity: existingRow.quantity + quantity,
              isMerged: true,
            };
            const revalidatedMerged = revalidateRow(updatedRow);
            mergedRowsMap.set(mergeKey, revalidatedMerged);
          } else {
            if (mergeKey !== "_") {
              mergedRowsMap.set(mergeKey, validatedRow);
            } else {
              // Rows without any identifying codes can't be safely merged
              rows.push(validatedRow);
            }
          }
        }
        // Combine merged rows and non-merged invalid rows
        const finalRows = [...rows, ...Array.from(mergedRowsMap.values())];
        // Sort by original row number
        finalRows.sort((a, b) => a.originalRowNumber - b.originalRowNumber);
        resolve(finalRows);
      } catch (error) {
        reject(new Error("Failed to parse Excel file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsBinaryString(file);
  });
};

// A single bulk upload template that accepts either SKU Code or MSIL Code.
export const TEMPLATE_CONFIG = {
  label: "Bulk Upload Template",
  fileName: "Bulk_Order_Template.xlsx",
  headers: ["SKU Code", "MSIL Code", "Quantity"],
  sample: [],
};

// Non-MSIL customers never order by MSIL Code, so they get a template without
// that column and no sample rows.
export const TEMPLATE_CONFIG_NO_MSIL = {
  ...TEMPLATE_CONFIG,
  headers: ["SKU Code", "Quantity"],
  sample: [],
};

export const downloadTemplate = (showMsilCode = true) => {
  const cfg = showMsilCode ? TEMPLATE_CONFIG : TEMPLATE_CONFIG_NO_MSIL;
  const templateData = [cfg.headers];

  const ws = XLSX.utils.aoa_to_sheet(templateData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Template");
  XLSX.writeFile(wb, cfg.fileName);
};

export const downloadErrorReport = (rows, showMsilCode = true) => {
  const errorData = [
    showMsilCode
      ? ["Row Number", "SKU Code", "MSIL Code", "Quantity", "Errors"]
      : ["Row Number", "SKU Code", "Quantity", "Errors"],
  ];
  rows
    .filter((r) => r.status === "error")
    .forEach((row) => {
      errorData.push([
        String(row.originalRowNumber),
        row.skuCode,
        ...(showMsilCode ? [row.msilCode] : []),
        String(row.quantity),
        row.errors.join("; "),
      ]);
    });

  const ws = XLSX.utils.aoa_to_sheet(errorData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Error Report");
  XLSX.writeFile(wb, "Bulk_Order_Errors.xlsx");
};
