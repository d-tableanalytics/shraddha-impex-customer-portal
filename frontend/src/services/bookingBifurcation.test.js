import { describe, test, expect, vi, beforeEach } from "vitest";

/**
 * THE CUSTOMER PORTAL READS THE SERVER'S BIFURCATION, NOT ITS OWN ARITHMETIC.
 *
 * `groupIntoBookings` used to derive the booking's indent total in the browser
 * by summing each row's `pendingQty` — the shortfall FROZEN onto the order row
 * at confirmation. That is wrong in two ways:
 *
 *   • a SKU stock could not cover AT ALL never gets an order row, so a booking
 *     whose shortfall was total showed an indent of zero;
 *   • closing an indent cancels the reservations and leaves the order rows
 *     untouched, so a cancelled or expired booking went on reporting units
 *     nobody was waiting for.
 *
 * The sales desk read the live reservation balance and got it right, so the
 * two portals disagreed about the same booking. These tests pin that the
 * browser now defers to the server, and that an older server (no field) still
 * works through the previous derivation.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./api", () => ({ api, describeRequestFailure: (_e, f) => f, refreshAccessToken: vi.fn() }));

const { ordersApi } = await import("./orders");

/** One order row as the server returns it. */
const row = (over = {}) => ({
  _id: `id-${Math.random()}`,
  orderId: "BO-2026-000001",
  brand: "Koken",
  skuCode: "SKU-A",
  status: "PO Received",
  company: "ABC Motors",
  date: "2026-11-01T00:00:00.000Z",
  requestedQty: 70,
  bookedQty: 100,
  confirmedQty: 70,
  pendingQty: 30,
  ...over,
});

const load = async (rows) => {
  api.get.mockResolvedValueOnce({ data: { data: rows } });
  const [booking] = await ordersApi.getAll();
  return booking;
};

beforeEach(() => { api.get.mockReset(); });

describe("the booking bifurcation reaching the Customer Portal", () => {
  test("is taken from the server when the server sends it", async () => {
    const bifurcation = {
      totalBookedQty: 100, allocatedQty: 70, pendingIndentQty: 30,
      dispatchedQty: 0, cancelledQty: 0, bookedQtyEver: 100, bySku: [],
    };
    const booking = await load([row({ bifurcation })]);
    expect(booking.bifurcation).toEqual(bifurcation);
    expect(booking.totalIndentQuantity).toBe(30);
    expect(booking.totalBookedQuantity).toBe(100);
  });

  test("follows the LIVE indent down as stock arrives, where pendingQty does not", async () => {
    // 15 of the 30 arrived and were auto-booked. The row still says 30.
    const booking = await load([row({
      confirmedQty: 85,
      pendingQty: 30,
      bifurcation: {
        totalBookedQty: 100, allocatedQty: 85, pendingIndentQty: 15,
        dispatchedQty: 0, cancelledQty: 0, bookedQtyEver: 100, bySku: [],
      },
    })]);
    expect(booking.totalIndentQuantity).toBe(15);
    expect(booking.bifurcation.allocatedQty).toBe(85);
    expect(
      booking.bifurcation.allocatedQty + booking.bifurcation.pendingIndentQty,
    ).toBe(booking.bifurcation.totalBookedQty);
  });

  test("reports an indent for a booking whose rows show none", async () => {
    // Every row fully confirmed, but a SKU stock could not cover at all exists
    // only as a reservation and has no row here at all.
    const booking = await load([row({
      skuCode: "SKU-B", confirmedQty: 10, pendingQty: 0, bookedQty: 10,
      bifurcation: {
        totalBookedQty: 60, allocatedQty: 10, pendingIndentQty: 50,
        dispatchedQty: 0, cancelledQty: 0, bookedQtyEver: 10, bySku: [],
      },
    })]);
    expect(booking.totalIndentQuantity).toBe(50);
  });

  test("is read off whichever row carries it", async () => {
    const bifurcation = {
      totalBookedQty: 110, allocatedQty: 80, pendingIndentQty: 30,
      dispatchedQty: 0, cancelledQty: 0, bookedQtyEver: 110, bySku: [],
    };
    // The server stamps every row; a response where only one carried it must
    // still work, because nothing promises which row the client sees first.
    const booking = await load([
      row({ skuCode: "SKU-A" }),
      row({ skuCode: "SKU-B", confirmedQty: 10, pendingQty: 0, bookedQty: 10, bifurcation }),
    ]);
    expect(booking.bifurcation).toEqual(bifurcation);
  });

  test("falls back to the old client-side sums when the server sends none", async () => {
    const booking = await load([
      row({ skuCode: "SKU-A", bookedQty: 100, pendingQty: 30 }),
      row({ skuCode: "SKU-B", bookedQty: 10, confirmedQty: 10, pendingQty: 0 }),
    ]);
    expect(booking.bifurcation).toBeNull();
    // Exactly what it produced before, so a half-rolled deployment is not a
    // blank screen.
    expect(booking.totalBookedQuantity).toBe(110);
    expect(booking.totalIndentQuantity).toBe(30);
  });

  test("a zero indent from the server is honoured, not mistaken for absent", async () => {
    // `?? ` not `|| `: pendingIndentQty 0 is an answer, and falling through to
    // the frozen sum would resurrect a stale 30 on a fully fulfilled booking.
    const booking = await load([row({
      pendingQty: 30,
      bifurcation: {
        totalBookedQty: 100, allocatedQty: 100, pendingIndentQty: 0,
        dispatchedQty: 0, cancelledQty: 0, bookedQtyEver: 100, bySku: [],
      },
    })]);
    expect(booking.totalIndentQuantity).toBe(0);
  });
});
