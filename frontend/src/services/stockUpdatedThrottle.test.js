import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Inventory refetches driven by `inventory:stock-updated`.
 *
 * An import or a bulk adjustment posts one event per SKU, and every event used
 * to refetch the whole list — dozens of overlapping requests for one change.
 * These pin the throttle: the first event refreshes at once, a burst collapses
 * into one trailing refresh, and the last event of a burst is never lost.
 */

const fakeSocket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    handlers,
    on: vi.fn((event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    }),
    off: vi.fn((event, fn) => handlers.get(event)?.delete(fn)),
    emit: (event, payload) => [...(handlers.get(event) || [])].forEach((fn) => fn(payload)),
    listeners: (event) => handlers.get(event)?.size ?? 0,
  };
});
vi.mock("socket.io-client", () => ({ io: () => fakeSocket }));
vi.mock("react-hot-toast", () => ({ default: vi.fn() }));

import { onStockUpdated, STOCK_REFRESH_THROTTLE_MS } from "./socketService";
import { throttleTrailing } from "../utils/throttle";

const EVENT = "inventory:stock-updated";

describe("stock-updated refetches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a burst of events causes one immediate and one trailing refetch", () => {
    const refetch = vi.fn();
    const off = onStockUpdated(refetch);

    for (let i = 0; i < 40; i++) {
      fakeSocket.emit(EVENT, { skuCode: `SKU-${i}` });
      vi.advanceTimersByTime(10);
    }
    expect(refetch).toHaveBeenCalledTimes(1); // the first, at once

    vi.advanceTimersByTime(STOCK_REFRESH_THROTTLE_MS);
    expect(refetch).toHaveBeenCalledTimes(2); // the rest, collapsed into one
    // The trailing call carries the LAST event, so nothing after it is missed.
    expect(refetch.mock.calls[1][0]).toEqual({ skuCode: "SKU-39" });

    vi.advanceTimersByTime(STOCK_REFRESH_THROTTLE_MS * 5);
    expect(refetch).toHaveBeenCalledTimes(2); // quiet afterwards
    off();
  });

  test("a long stream of events refreshes about once a second, never stops", () => {
    const refetch = vi.fn();
    const off = onStockUpdated(refetch);
    for (let i = 0; i < 50; i++) {
      fakeSocket.emit(EVENT, {});
      vi.advanceTimersByTime(100); // 5 seconds of events in total
    }
    vi.advanceTimersByTime(STOCK_REFRESH_THROTTLE_MS);
    expect(refetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(refetch.mock.calls.length).toBeLessThanOrEqual(7);
    off();
  });

  test("unsubscribing removes the listener and drops a pending trailing refetch", () => {
    const refetch = vi.fn();
    const off = onStockUpdated(refetch);
    expect(fakeSocket.listeners(EVENT)).toBe(1);
    fakeSocket.emit(EVENT, {});
    fakeSocket.emit(EVENT, {});
    off();
    expect(fakeSocket.listeners(EVENT)).toBe(0);
    vi.advanceTimersByTime(STOCK_REFRESH_THROTTLE_MS * 2);
    expect(refetch).toHaveBeenCalledTimes(1); // nothing fires into an unmounted page
  });

  test("remounting does not stack subscriptions", () => {
    const refetch = vi.fn();
    onStockUpdated(refetch)();
    onStockUpdated(refetch)();
    const off = onStockUpdated(refetch);
    expect(fakeSocket.listeners(EVENT)).toBe(1);
    off();
  });

  test("throttling can be turned off for a caller that needs every event", () => {
    const refetch = vi.fn();
    const off = onStockUpdated(refetch, { throttleMs: 0 });
    fakeSocket.emit(EVENT, {});
    fakeSocket.emit(EVENT, {});
    expect(refetch).toHaveBeenCalledTimes(2);
    off();
  });

  test("throttleTrailing: a single call runs once, immediately", () => {
    const fn = vi.fn();
    const t = throttleTrailing(fn, 1000);
    t("a");
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });
});
