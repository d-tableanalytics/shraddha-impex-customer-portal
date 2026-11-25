import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The Sales Desk's STANDALONE INDENTS table.
 *
 * ---------------------------------------------------------------------------
 * WHAT A STANDALONE LINE IS, AND WHY IT NEEDS A TABLE OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * A standalone indent line is one that no row of Booking Items accounts for.
 * Confirmation only writes an order row when `confirmedQty > 0`, so a SKU
 * stock could not cover at all exists purely as a reservation and appears
 * NOWHERE else on this screen — which is exactly the line a desk cross-checking
 * the customer's paper PO must not miss.
 *
 * It cannot simply be a row in Booking Items: that table's columns are facts
 * about an order row (booked, confirmed, pending, price, box number) and a
 * standalone line has none of them. Inventing zeroes would change what every
 * total on that table means.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THESE TESTS EXIST FOR: THE TWO LISTS PARTITION THE INDENT
 * ---------------------------------------------------------------------------
 *
 * Standalone lines go to the Standalone Indents table; partial ones stay in
 * the Indent card. No SKU may be in both — one SKU listed twice on one screen
 * reads as two separate reservations, and the desk sees double the quantity
 * the customer is actually owed. Together the two must be the whole open
 * indent, or a line goes missing instead.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THE SCREEN MUST NOT WORK THE SPLIT OUT ITSELF
 * ---------------------------------------------------------------------------
 *
 * The drawer used to decide it by asking whether the SKU was in `draft`.
 * `draft` is the desk's UNSAVED working copy, so typing the missing SKU into
 * it made the warning about that SKU disappear — before anything had been
 * saved, and precisely while it still mattered. The server sends `standalone`
 * per line, computed by the same `bookingJourney.js` that builds the
 * confirmation email, and the screen honours it.
 *
 * The fixtures are the real payload `GET /sales/bookings/:orderId` produced for
 * a mixed booking (12 of a stocked SKU, 6 of 20 on a short one, and two SKUs
 * with no stock at all), copied from an end-to-end run rather than invented.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({ api, describeRequestFailure: (_e, f) => f, refreshAccessToken: vi.fn() }));

import { SalesBookingDrawer } from "./SalesBookingDrawer";
import { useSalesStore } from "../../store/salesStore";
import { useUserStore } from "../../store/userStore";

const indentLine = (skuCode, quantity, standalone, productName, status = "Pending") => ({
  reservationId: `RES-${skuCode}`,
  skuCode,
  msilCode: `M-${skuCode}`,
  productName,
  quantity,
  standalone,
  status,
  expiresOn: "2026-12-02T07:39:42.915Z",
  supplyDate: null,
  supplyCheck: null,
  unitPrice: null,
  amount: null,
});

/** Two standalone lines and one partial — the mixed case. */
const MIXED_INDENT = {
  indentNumber: "PI-2026-000004",
  totalQuantity: 47,
  standaloneCount: 2,
  standaloneQuantity: 33,
  lines: [
    indentLine("SKU-PART", 14, false, "Torque Wrench 1/2in", "Partially Confirmed"),
    indentLine("SKU-ZERO", 25, true, "Impact Socket Set 10pc"),
    indentLine("SKU-ZERO2", 8, true, "Hex Key Set 9pc"),
  ],
};

const booking = (over = {}) => ({
  orderId: "BO-2026-000004",
  company: "Rao Motors",
  status: "PO Received",
  poNumber: "-",
  locked: false,
  pricing: null,
  totals: { booked: 18, indent: 47, total: 65 },
  lines: [
    { id: "l1", skuCode: "SKU-FULL", msilCode: "M-SKU-FULL", bookedQty: 12, confirmedQty: 12, pendingQty: 0, status: "PO Received", allocations: [] },
    { id: "l2", skuCode: "SKU-PART", msilCode: "M-SKU-PART", bookedQty: 20, confirmedQty: 6, pendingQty: 14, status: "PO Received", allocations: [] },
  ],
  indent: MIXED_INDENT,
  ...over,
});

const open = (b) => act(() => useSalesStore.setState({ selected: b, saving: false }));

/** The Standalone Indents table, or null when the screen is not showing one. */
const standaloneTable = () => screen.queryByTestId("standalone-indents");

/** Rows of a card, flattened, in the order they are painted. */
const rowsOf = (card) =>
  [...card.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")]
      .map((c) => c.textContent.replace(/\s+/g, " ").trim())
      .join(" | "));

/** The Indent card — the PARTIAL half of the split. */
const indentCard = () => screen.getByText(/^Indent$/).closest("div.bg-white");

describe("the Sales Desk standalone indents table", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState({ user: { _id: "a1", role: "Super Admin", permissions: ["*"] }, loading: false });
    api.get.mockResolvedValue({ data: { data: [] } });
    render(<MemoryRouter><SalesBookingDrawer /></MemoryRouter>);
  });

  test("lists every standalone line, with the columns the desk was promised", () => {
    open(booking());
    const rows = rowsOf(standaloneTable());

    expect(rows[0]).toBe(
      "Booking ID | Indent ID | SKU / Product Code | Product Name | Indent Quantity | Status | Price",
    );
    expect(rows.join("\n")).toMatch(
      /BO-2026-000004 \| PI-2026-000004 \| SKU-ZEROM-SKU-ZERO \| Impact Socket Set 10pc \| 25 \|/,
    );
    expect(rows.join("\n")).toMatch(
      /BO-2026-000004 \| PI-2026-000004 \| SKU-ZERO2M-SKU-ZERO2 \| Hex Key Set 9pc \| 8 \|/,
    );
  });

  test("🔴 the two tables PARTITION the indent — no SKU in both", () => {
    open(booking());
    const standalone = rowsOf(standaloneTable()).join("\n");
    const partial = rowsOf(indentCard()).join("\n");

    // Each SKU is in exactly one of the two.
    expect(standalone).toMatch(/SKU-ZERO\b/);
    expect(standalone).toMatch(/SKU-ZERO2/);
    expect(standalone).not.toMatch(/SKU-PART/);

    expect(partial).toMatch(/SKU-PART/);
    expect(partial).not.toMatch(/SKU-ZERO/);
  });

  test("🔴 the quantities add up to the whole open indent, counted once", () => {
    open(booking());

    // 25 + 8 standalone, 14 partial, against a booking with 47 on indent.
    expect(within(standaloneTable()).getByText("33")).toBeTruthy();
    expect(rowsOf(indentCard()).join("\n")).toMatch(/SKU-PART.*\| 14 \|/);
  });

  test("names the booking and the indent on every row, not just in a heading", () => {
    // The question this table answers is "is this indent really against THIS
    // booking?" — an answer carried down from a heading gets carried wrongly.
    open(booking());
    const table = standaloneTable();

    expect(within(table).getAllByText("BO-2026-000004")).toHaveLength(2);
    // Twice in the body, once in the card heading.
    expect(within(table).getAllByText("PI-2026-000004").length).toBeGreaterThanOrEqual(2);
  });

  test("🔴 the SERVER's flag decides, not the line table on screen", () => {
    // SKU-PART IS in `lines`, so the old derivation would have called it
    // partial. The server says standalone — the case of a line the desk has
    // removed, or is about to — and the screen must say what the server says.
    open(booking({
      indent: {
        ...MIXED_INDENT,
        standaloneCount: 3,
        standaloneQuantity: 47,
        lines: MIXED_INDENT.lines.map((l) => ({ ...l, standalone: true })),
      },
    }));

    expect(rowsOf(standaloneTable()).join("\n")).toMatch(/SKU-PART/);
    // Nothing partial is left, so the Indent card has no table of its own.
    expect(screen.getByText(/Every outstanding line is standalone/i)).toBeTruthy();
  });

  test("a SKU the master has no name for shows a dash, not the code again", () => {
    open(booking({
      indent: { ...MIXED_INDENT, lines: [indentLine("SKU-ZERO", 25, true, null)] },
    }));
    expect(rowsOf(standaloneTable()).join("\n")).toMatch(/SKU-ZEROM-SKU-ZERO \| — \| 25/);
  });

  test("🔴 a booking with no standalone indent shows no table at all", () => {
    open(booking({
      indent: {
        indentNumber: "PI-2026-000002",
        totalQuantity: 15,
        standaloneCount: 0,
        standaloneQuantity: 0,
        lines: [indentLine("SKU-PART", 15, false, "Torque Wrench 1/2in", "Partially Confirmed")],
      },
    }));

    expect(standaloneTable()).toBeNull();
    // …and the partial line is untouched, where it always was.
    expect(rowsOf(indentCard()).join("\n")).toMatch(/SKU-PART.*\| 15 \|/);
  });

  test("a booking stock covered in full still says so, and shows no table", () => {
    open(booking({
      lines: [booking().lines[0]],
      indent: { indentNumber: "PI-2026-000001", lines: [], totalQuantity: 0, standaloneCount: 0, standaloneQuantity: 0 },
    }));

    expect(standaloneTable()).toBeNull();
    expect(screen.getByText(/stock covered this booking in full/i)).toBeTruthy();
  });

  test("🔴 which materials are missing is not pricing — it survives without view_pricing", () => {
    useUserStore.setState({ user: { _id: "s1", role: "Sales", permissions: ["view_all_bookings"] }, loading: false });
    open(booking());

    // The money column is gone; the identifiers, names and quantities are
    // operational facts and stay.
    const rows = rowsOf(standaloneTable());
    expect(rows[0]).toBe(
      "Booking ID | Indent ID | SKU / Product Code | Product Name | Indent Quantity | Status",
    );
    expect(rows.join("\n")).toMatch(/Impact Socket Set 10pc \| 25/);
    expect(rows.join("\n")).toMatch(/Hex Key Set 9pc \| 8/);
  });

  test("an older payload with no flag still separates what is missing", () => {
    // Backward compatibility: a cached row predating the server flag falls back
    // to comparing against the line table, which is what the screen did before.
    // SKU-ZERO is not in `lines`, so it is still called out.
    open(booking({
      indent: {
        indentNumber: "PI-2026-000004",
        totalQuantity: 39,
        lines: [
          { ...indentLine("SKU-PART", 14, undefined, "Torque Wrench 1/2in", "Partially Confirmed"), standalone: undefined },
          { ...indentLine("SKU-ZERO", 25, undefined, "Impact Socket Set 10pc"), standalone: undefined },
        ],
      },
    }));

    const standalone = rowsOf(standaloneTable()).join("\n");
    expect(standalone).toMatch(/SKU-ZERO/);
    expect(standalone).not.toMatch(/SKU-PART/);
    expect(rowsOf(indentCard()).join("\n")).toMatch(/SKU-PART/);
  });
});
