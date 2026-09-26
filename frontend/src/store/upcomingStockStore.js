import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { buildSeed, itemKey, nextId, derive, SUPPLIERS } from "../utils/upcomingStockMock";

/**
 * Upcoming Stock — DEMO STATE ONLY.
 *
 * Mock data held in the browser. Nothing here calls the API, and nothing here
 * reads or writes the Inventory Master / Health stores: the "actual stock"
 * figures are part of the mock seed, not the live balances.
 *
 * Kept in sessionStorage so a reservation survives a page reload during a demo
 * but disappears when the tab is closed. `reset()` restores the seed.
 */

const STORAGE_KEY = "erp.demo.upcomingStock";

const indentCounter = (items) =>
  items.reduce(
    (max, i) => i.reservations.reduce((m, r) => Math.max(m, Number(r.indentNo.replace(/\D/g, "")) || 0), max),
    100,
  );

export const nextIndentNo = (items) => `IND-UP-${String(indentCounter(items) + 1).padStart(4, "0")}`;

export const useUpcomingStockStore = create(
  persist(
    (set, get) => ({
      items: buildSeed(),
      imports: [],

      /** Reserve upcoming quantity for a customer. Refuses more than is remaining. */
      reserve: ({ key, qty, customer, indentNo, note, by }) => {
        const item = get().items.find((i) => itemKey(i) === key);
        if (!item) return { success: false, error: "That SKU is no longer in the upcoming list." };
        const { remaining } = derive(item);
        if (!Number.isInteger(qty) || qty <= 0) return { success: false, error: "Enter a whole quantity above 0." };
        if (qty > remaining) return { success: false, error: `Only ${remaining.toLocaleString()} remaining to reserve.` };

        const reservation = {
          id: nextId("rsv"),
          indentNo: indentNo || nextIndentNo(get().items),
          customer,
          qty,
          reservedAt: new Date().toISOString(),
          by: by || "You",
          note: note || "",
        };
        set((s) => ({
          items: s.items.map((i) => (itemKey(i) === key ? { ...i, reservations: [reservation, ...i.reservations] } : i)),
        }));
        return { success: true, reservation };
      },

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
              reservations: [],
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
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ items: s.items, imports: s.imports }),
    },
  ),
);

export default useUpcomingStockStore;
