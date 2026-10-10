import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { useOrderHistoryStore } from "./orderHistoryStore";
import { useIndentHistoryStore } from "./indentHistoryStore";

/**
 * The search loading state on Booking History and Indent History.
 *
 * Typing used to filter on every keystroke and leave the previous query's rows
 * on screen while it did. Now the box updates at once, `searching` goes true so
 * the table shows a spinner, and the filter runs once typing pauses.
 */

const cases = [
  {
    name: "Booking History",
    store: useOrderHistoryStore,
    rowsKey: "orders",
    seed: [
      { id: "1", orderNumber: "BO-1", poNumber: "PO-A", customer: "Alpha", date: "2026-10-01", lineItems: [{ skuCode: "SKU-1" }] },
      { id: "2", orderNumber: "BO-2", poNumber: "PO-B", customer: "Beta", date: "2026-10-02", lineItems: [{ skuCode: "SKU-2" }] },
    ],
    seedKey: "allOrders",
    query: "BO-2",
  },
  {
    name: "Indent History",
    store: useIndentHistoryStore,
    rowsKey: "indents",
    seed: [
      { id: "1", indentNumber: "IND-1", bookingId: "BO-1", customer: "Alpha", date: "2026-10-01", totalQuantity: 1, lines: [{ skuCode: "SKU-1" }] },
      { id: "2", indentNumber: "IND-2", bookingId: "BO-2", customer: "Beta", date: "2026-10-02", totalQuantity: 1, lines: [{ skuCode: "SKU-2" }] },
    ],
    seedKey: "allIndents",
    query: "IND-2",
  },
];

describe.each(cases)("$name search", ({ store, rowsKey, seed, seedKey, query }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.setState({ [seedKey]: seed, [rowsKey]: seed, searchQuery: "", searching: false, loading: false });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  test("shows the typed text and the loading state at once, results after the pause", () => {
    store.getState().setSearchQuery(query);

    expect(store.getState().searchQuery).toBe(query);
    expect(store.getState().searching).toBe(true);
    // The old rows are still in state, but the table is showing the spinner.
    expect(store.getState()[rowsKey]).toHaveLength(2);

    vi.advanceTimersByTime(300);

    expect(store.getState().searching).toBe(false);
    expect(store.getState()[rowsKey].map((r) => r.id)).toEqual(["2"]);
  });

  test("keeps loading while the user is still typing", () => {
    store.getState().setSearchQuery(query.slice(0, 2));
    vi.advanceTimersByTime(200);
    store.getState().setSearchQuery(query);
    vi.advanceTimersByTime(200);

    // 400ms in, but only 200ms since the last keystroke.
    expect(store.getState().searching).toBe(true);

    vi.advanceTimersByTime(100);
    expect(store.getState().searching).toBe(false);
    expect(store.getState()[rowsKey].map((r) => r.id)).toEqual(["2"]);
  });
});
