import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Sales Desk search: debounced, and immune to answers arriving out of order.
 *
 * The box used to request the whole bookings list on every keystroke, and the
 * last response to ARRIVE won — so a slow answer for "B" could land after the
 * answer for "BO-2026-0001" and leave the wrong rows under the right search.
 */

const salesApi = vi.hoisted(() => ({ getBookings: vi.fn() }));
vi.mock("../services/sales", () => ({ salesApi }));
vi.mock("../services/orders", () => ({ ordersApi: {} }));

import { useSalesStore, SEARCH_DEBOUNCE_MS } from "./salesStore";

const listFor = (search) => ({
  data: [{ orderId: `BO-${search || "all"}` }],
  meta: { total: 1, pendingPo: 1, generated: 0 },
});

/** A request whose answer the test releases by hand. */
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const searches = () => salesApi.getBookings.mock.calls.map(([q]) => q.search);
const state = () => useSalesStore.getState();

describe("Sales Desk search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state().reset();
    salesApi.getBookings.mockImplementation(({ search }) => Promise.resolve(listFor(search)));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("typing sends one request, after the pause", async () => {
    for (const term of ["B", "BO", "BO-", "BO-2"]) {
      state().setSearch(term);
      vi.advanceTimersByTime(100);
    }
    expect(salesApi.getBookings).not.toHaveBeenCalled();
    expect(state().search).toBe("BO-2"); // the box itself is never held back

    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(searches()).toEqual(["BO-2"]);
    expect(state().bookings).toEqual([{ orderId: "BO-BO-2" }]);
    expect(state().appliedSearch).toBe("BO-2");
  });

  test("an older, slower answer cannot overwrite a newer one", async () => {
    const slow = deferred();
    const fast = deferred();
    salesApi.getBookings
      .mockImplementationOnce(() => slow.promise)
      .mockImplementationOnce(() => fast.promise);

    state().setSearch("B");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    state().setSearch("BO-2");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(searches()).toEqual(["B", "BO-2"]);

    // The first request was abandoned when the second started.
    const [, { signal: firstSignal }] = salesApi.getBookings.mock.calls[0];
    expect(firstSignal.aborted).toBe(true);

    fast.resolve(listFor("BO-2"));
    await vi.runAllTimersAsync();
    // Even if the abandoned request still answers, it must not be shown.
    slow.resolve(listFor("B"));
    await vi.runAllTimersAsync();

    expect(state().bookings).toEqual([{ orderId: "BO-BO-2" }]);
    expect(state().appliedSearch).toBe("BO-2");
    expect(state().error).toBeNull();
  });

  test("a cancelled request reports no error", async () => {
    const first = deferred();
    salesApi.getBookings.mockImplementationOnce(() => first.promise);
    state().setSearch("B");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    state().setSearch("BO");
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    first.reject(Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" }));
    await vi.runAllTimersAsync();
    expect(state().error).toBeNull();
    expect(state().appliedSearch).toBe("BO");
  });

  test("clearing the box shows everything again at once", async () => {
    state().setSearch("BO");
    state().setSearch("");
    // No pause for a clear, and the half-typed search never goes out.
    expect(searches()).toEqual([""]);
    await vi.runAllTimersAsync();
    expect(searches()).toEqual([""]);
    expect(state().appliedSearch).toBe("");
  });

  test("a refresh after a write is immediate and replaces a pending search", async () => {
    state().setSearch("BO");
    await state().fetchBookings(); // what every write calls
    expect(searches()).toEqual(["BO"]);
    await vi.runAllTimersAsync();
    expect(searches()).toEqual(["BO"]); // the debounced one was superseded, not repeated
  });

  test("the scope tabs are not debounced", async () => {
    state().setScope("pending");
    expect(salesApi.getBookings).toHaveBeenCalledTimes(1);
    expect(salesApi.getBookings.mock.calls[0][0].status).toBe("pending");
  });

  test("a refresh keeps the rows on screen; the first load does not pretend to have any", async () => {
    expect(state().loading).toBe(true);
    await state().fetchBookings();
    expect(state().loading).toBe(false);

    const next = deferred();
    salesApi.getBookings.mockImplementationOnce(() => next.promise);
    const pending = state().fetchBookings();
    expect(state().loading).toBe(false);
    expect(state().refreshing).toBe(true);
    expect(state().bookings).toEqual([{ orderId: "BO-all" }]);
    next.resolve(listFor("x"));
    await pending;
    expect(state().refreshing).toBe(false);
  });

  test("a failed refresh reports the error and keeps the last good list", async () => {
    await state().fetchBookings();
    salesApi.getBookings.mockRejectedValueOnce({ response: { data: { message: "Server busy" } } });
    await state().fetchBookings();
    expect(state().error).toBe("Server busy");
    expect(state().bookings).toEqual([{ orderId: "BO-all" }]);
  });
});
