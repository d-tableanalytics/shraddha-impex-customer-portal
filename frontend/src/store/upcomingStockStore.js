import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { buildSeed, itemKey, nextId, derive, indentRefOf, SUPPLIERS } from "../utils/upcomingStockMock";

/**
 * Upcoming Stock — DEMO STATE ONLY.
 *
 * Mock data held in the browser. Nothing here writes to the API, and nothing
 * here reads or writes the Inventory Master / Health stores: the "actual stock"
 * figures are part of the mock seed, not the live balances.
 *
 * Live indents may be SHOWN beside the demo ones (read from GET
 * /reservations/pending by the page), but a reservation made against one is
 * held here only — the indent itself is never changed.
 *
 * Kept in sessionStorage so a reservation survives a page reload during a demo
 * but disappears when the tab is closed. `reset()` restores the seed.
 */

const STORAGE_KEY = "erp.demo.upcomingStock";

/**
 * A reservation made WITHOUT an indent gets its own reference, UR-####. It is
 * deliberately not PI-…: that prefix is the real indent number (see
 * runConfirmBooking in reservation.controller.js), and a demo reference must
 * never look like one.
 */
const REF_PREFIX = "UR-";

const refCounter = (items) =>
  items.reduce(
    (max, i) => i.reservations.reduce((m, r) => {
      const ref = String(r.indentNo || "");
      return ref.startsWith(REF_PREFIX) ? Math.max(m, Number(ref.slice(REF_PREFIX.length)) || 0) : m;
    }, max),
    100,
  );

export const nextIndentNo = (items) => `${REF_PREFIX}${String(refCounter(items) + 1).padStart(4, "0")}`;

const reservedAgainst = (item, lineId) =>
  item.reservations.filter((r) => r.indentRef?.lineId === lineId).reduce((s, r) => s + r.qty, 0);

export const useUpcomingStockStore = create(
  persist(
    (set, get) => ({
      items: buildSeed(),
      imports: [],

      /**
       * Reserve upcoming quantity. Refuses more than is remaining, and — when
       * made against an indent — more than that indent still needs. Both limits
       * are re-checked here rather than trusted from the form.
       *
       * `indent` is the line being covered (see indentLinesFor). A snapshot of it
       * is kept on the reservation, so a live indent that later closes still
       * explains what the quantity was reserved for.
       */
      reserve: ({ key, qty, customer, indentNo, note, by, indent = null }) => {
        const item = get().items.find((i) => itemKey(i) === key);
        if (!item) return { success: false, error: "That SKU is no longer in the upcoming list." };
        const { remaining } = derive(item);
        if (!Number.isInteger(qty) || qty <= 0) return { success: false, error: "Enter a whole quantity above 0." };
        if (qty > remaining) return { success: false, error: `Only ${remaining.toLocaleString()} remaining to reserve.` };
        if (indent) {
          const outstanding = Math.max(indent.requiredQty - reservedAgainst(item, indent.lineId), 0);
          if (outstanding === 0) return { success: false, error: `Indent ${indent.indentNumber} is already fully reserved.` };
          if (qty > outstanding) {
            return { success: false, error: `Indent ${indent.indentNumber} needs only ${outstanding.toLocaleString()} more.` };
          }
        }

        const reservation = {
          id: nextId("rsv"),
          indentNo: indent ? indent.indentNumber : (indentNo || nextIndentNo(get().items)),
          indentRef: indent ? indentRefOf(indent) : null,
          customer: indent ? indent.customer : customer,
          qty,
          reservedAt: new Date().toISOString(),
          by: by || "You",
          note: note || "",
        };
        set((s) => ({
          items: s.items.map((i) => (itemKey(i) === key
            ? {
              ...i,
              reservations: [reservation, ...i.reservations],
              // Reserving for a held indent is the decision to stop holding it.
              holds: indent ? (i.holds || []).filter((h) => h.lineId !== indent.lineId) : i.holds,
            }
            : i)),
        }));
        return { success: true, reservation };
      },

      /**
       * Keep an indent Pending: a recorded decision NOT to reserve upcoming
       * stock for it yet. The indent's own status is untouched — it stays
       * Pending / Partially Confirmed exactly as the server holds it; this only
       * marks that the desk looked at it and chose to wait.
       */
      keepPending: ({ key, indent, note, by }) => {
        const item = get().items.find((i) => itemKey(i) === key);
        if (!item) return { success: false, error: "That SKU is no longer in the upcoming list." };
        if (indent.requiredQty - reservedAgainst(item, indent.lineId) <= 0) {
          return { success: false, error: `Indent ${indent.indentNumber} is already fully reserved.` };
        }
        const hold = {
          lineId: indent.lineId,
          indentNumber: indent.indentNumber,
          note: note || "",
          by: by || "You",
          at: new Date().toISOString(),
        };
        set((s) => ({
          items: s.items.map((i) => (itemKey(i) === key
            ? { ...i, holds: [...(i.holds || []).filter((h) => h.lineId !== indent.lineId), hold] }
            : i)),
        }));
        return { success: true, hold };
      },

      /** Take an indent off hold, so it is offered for reservation again. */
      resumeIndent: (key, lineId) =>
        set((s) => ({
          items: s.items.map((i) => (itemKey(i) === key
            ? { ...i, holds: (i.holds || []).filter((h) => h.lineId !== lineId) }
            : i)),
        })),

      release: (key, reservationId) =>
        set((s) => ({
          items: s.items.map((i) =>
            itemKey(i) === key ? { ...i, reservations: i.reservations.filter((r) => r.id !== reservationId) } : i,
          ),
        })),

      /** Add validated import lines as shipments. Unknown SKUs are added with 0 actual stock. */
      importShipments: (lines, fileName) => {
        const importedAt = new Date().toISOString();
        const items = [...get().items];
        const index = new Map(items.map((i, n) => [i.skuCode.toLowerCase(), n]));
        let created = 0;

        lines.forEach((l) => {
          const shipment = {
            id: nextId("shp"),
            ref: l.ref,
            supplier: l.supplier || SUPPLIERS[l.brand] || "—",
            qty: l.qty,
            eta: l.eta,
            source: fileName,
            importedAt,
          };
          const at = index.get(l.skuCode.toLowerCase());
          if (at === undefined) {
            index.set(l.skuCode.toLowerCase(), items.length);
            items.push({
              brand: l.brand,
              skuCode: l.skuCode,
              product: l.product,
              category: "Imported",
              uom: "PCS",
              actual: 0,
              shipments: [shipment],
              indents: [],
              reservations: [],
              holds: [],
            });
            created += 1;
          } else {
            items[at] = { ...items[at], shipments: [...items[at].shipments, shipment] };
          }
        });

        const entry = {
          id: nextId("imp"),
          fileName,
          importedAt,
          lines: lines.length,
          qty: lines.reduce((s, l) => s + l.qty, 0),
          created,
        };
        set((s) => ({ items, imports: [entry, ...s.imports] }));
        return entry;
      },

      reset: () => set({ items: buildSeed(), imports: [] }),
    }),
    {
      name: STORAGE_KEY,
      // Bumped whenever the seed's shape changes. A tab still holding an older
      // shape starts again from the seed rather than rendering half a model.
      version: 3,
      migrate: () => ({ items: buildSeed(), imports: [] }),
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ items: s.items, imports: s.imports }),
    },
  ),
);

export default useUpcomingStockStore;
