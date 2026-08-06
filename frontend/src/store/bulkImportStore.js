import { create } from "zustand";
import { useProductStore } from "./productStore";

const initialSummary = {
  totalRows: 0,
  validRows: 0,
  invalidRows: 0,
  duplicateRows: 0,
  mergedRows: 0,
  totalProducts: 0,
  totalQuantity: 0,
};

// Fully re-evaluates a row after a client-side edit. Server-validated rows are
// NOT sticky: editing the quantity to an invalid value flips a 'valid' row back
// to 'error', and a stock shortfall downgrades it to 'warning'.
export const revalidateRow = (row) => {
  const errors = [];
  const warnings = [];

  if (!row.skuCode?.trim() && !row.msilCode?.trim()) errors.push("Missing SKU and MSIL Code");

  const quantity = Number(row.quantity) || 0;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    errors.push("Quantity must be a whole number greater than zero");
  }

  // Keep any server-side validation errors that a quantity edit cannot fix
  // (unknown product, inactive MSIL code, SKU/MSIL mismatch, ...). Only
  // quantity-related errors are recomputed client-side.
  if (Array.isArray(row.errors)) {
    for (const e of row.errors) {
      if (!/quantity/i.test(e) && !errors.includes(e)) errors.push(e);
    }
  }

  let status;
  if (errors.length > 0) {
    status = "error";
  } else if (!row.product) {
    // Codes were edited or never validated server-side — needs revalidation.
    status = "pending";
  } else if (quantity > (row.product.availableStock ?? 0)) {
    warnings.push(
      `Only ${Math.max(0, row.product.availableStock ?? 0)} in stock. ${quantity - Math.max(0, row.product.availableStock ?? 0)} unit(s) will move to Indent.`,
    );
    status = "warning";
  } else {
    status = "valid";
  }

  return {
    ...row,
    product: row.product || null,
    status,
    errors,
    warnings,
  };
};

export const computeSummary = (rows) => {
  const totalRows = rows.length;
  const validRows = rows.filter(
    (r) => r.status === "valid" || r.status === "warning",
  ).length;
  const invalidRows = rows.filter((r) => r.status === "error").length;
  const mergedRows = rows.filter((r) => r.isMerged).length;

  const validItems = rows.filter(
    (r) => r.status === "valid" || r.status === "warning",
  );
  const totalProducts = validItems.length;
  const totalQuantity = validItems.reduce(
    (acc, r) => acc + (r.quantity || 0),
    0,
  );
  return {
    totalRows,
    validRows,
    invalidRows,
    duplicateRows: 0,
    mergedRows,
    totalProducts,
    totalQuantity,
  };
};

export const useBulkImportStore = create((set) => ({
  file: null,
  rows: [],
  summary: initialSummary,
  setFile: (file) => set({ file }),
  setRows: (rows) => set({ rows, summary: computeSummary(rows) }),
  updateRow: (id, updates) =>
    set((state) => {
      const newRows = state.rows.map((row) => {
        if (row.id === id) {
          const updated = { ...row, ...updates };
          // Editing a code invalidates the previously matched product — the row
          // must go back through server validation.
          const codeChanged =
            (updates.skuCode !== undefined && updates.skuCode !== row.skuCode) ||
            (updates.msilCode !== undefined && updates.msilCode !== row.msilCode);
          if (codeChanged) {
            updated.product = null;
            updated.errors = [];
          }
          return revalidateRow(updated);
        }
        return row;
      });
      return { rows: newRows, summary: computeSummary(newRows) };
    }),
  removeRow: (id) =>
    set((state) => {
      const newRows = state.rows.filter((r) => r.id !== id);
      return { rows: newRows, summary: computeSummary(newRows) };
    }),
  reset: () => set({ file: null, rows: [], summary: initialSummary }),
}));
