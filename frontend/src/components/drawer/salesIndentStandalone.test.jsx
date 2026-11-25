import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The Sales Desk's Indent section: STANDALONE lines versus PARTIAL ones.
 *
 * ---------------------------------------------------------------------------
 * WHAT A STANDALONE LINE IS, AND WHY THE SCREEN MUST NOT WORK IT OUT ITSELF
 * ---------------------------------------------------------------------------
 *
 * A standalone indent line is one that no row of Booking Items accounts for.
 * Confirmation only writes an order row when `confirmedQty > 0`, so a SKU stock
 * could not cover at all exists purely as a reservation and appears NOWHERE
 * else on this screen — which is exactly the line a desk cross-checking the
 * customer's paper PO must not miss.
 *
 * The drawer used to decide that for itself, by asking whether the SKU was in
 * `draft`. `draft` is the desk's UNSAVED working copy, so typing the missing
 * SKU into it made the warning about that SKU disappear — before anything had
 * been saved, and precisely while it still mattered. The server now sends
 * `standalone` per line and the screen honours it; the first test below pins
 * that the flag wins over whatever the line table happens to hold.
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

/** The Indent card's rows, flattened, in the order they are painted. */
const indentRows = () => {
  const card = screen.getByText(/^Indent$/).closest("div.bg-white");
  return [...card.querySelectorAll("tr")].map((tr) =>
    [...tr.querySelectorAll("th,td")]
      .map((c) => c.textContent.replace(/\s+/g, " ").trim())
      .join(" | "));
};

describe("the Sales Desk indent section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUserStore.setState({ user: { _id: "a1", role: "Super Admin", permissions: ["*"] }, loading: false });
    api.get.mockResolvedValue({ data: { data: [] } });
    render(<MemoryRouter><SalesBookingDrawer /></MemoryRouter>);
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

    expect(screen.getAllByText("Standalone")).toHaveLength(3);
    expect(indentRows().join("\n")).not.toMatch(/Partial indents/);
  });

  test("standalone lines come first, under their own heading", () => {
    open(booking());
    const text = indentRows().join("\n");

    expect(text).toMatch(/Standalone indents — no line in Booking Items/);
    expect(text).toMatch(/Partial indents — shortfall on a line in Booking Items/);
    // Order matters: the standalone lines are the ones that cannot be found
    // anywhere else on the screen.
    expect(text.indexOf("Standalone indents")).toBeLessThan(text.indexOf("Partial indents"));
    expect(text.indexOf("SKU-ZERO")).toBeLessThan(text.indexOf("SKU-PART"));
  });

  test("the heading states how many materials have nothing in Booking Items", () => {
    open(booking());
    // Counted off the server's totals, not off the rows on screen.
    expect(screen.getByText(/2 standalone indent line\(s\) \(33 pc\)/)).toBeTruthy();
  });

  test("every line names its material, and the badge marks only the standalone ones", () => {
    open(booking());
    const text = indentRows().join("\n");

    expect(text).toMatch(/SKU-ZERO.*Impact Socket Set 10pc \| 25/);
    expect(text).toMatch(/SKU-ZERO2.*Hex Key Set 9pc \| 8/);
    expect(text).toMatch(/SKU-PART \| M-SKU-PART \| Torque Wrench 1\/2in \| 14/);
    expect(screen.getAllByText("Standalone")).toHaveLength(2);
  });

  test("a SKU the master has no name for shows a dash, not the code again", () => {
    open(booking({
      indent: { ...MIXED_INDENT, lines: [indentLine("SKU-ZERO", 25, true, null)] },
    }));
    expect(indentRows().join("\n")).toMatch(/SKU-ZEROStandalone \| M-SKU-ZERO \| — \| 25/);
  });

  test("a booking whose indent is entirely partial is left exactly as it was", () => {
    open(booking({
      indent: {
        indentNumber: "PI-2026-000002",
        totalQuantity: 15,
        standaloneCount: 0,
        standaloneQuantity: 0,
        lines: [indentLine("SKU-PART", 15, false, "Torque Wrench 1/2in", "Partially Confirmed")],
      },
    }));
    const text = indentRows().join("\n");

    // No group headings, no badge, no count — one kind of line needs no split.
    expect(text).not.toMatch(/Standalone indents/);
    expect(text).not.toMatch(/Partial indents/);
    expect(screen.queryByText("Standalone")).toBeNull();
    expect(screen.queryByText(/standalone indent line/)).toBeNull();
  });

  test("a booking stock covered in full still says so", () => {
    open(booking({
      lines: [booking().lines[0]],
      indent: { indentNumber: "PI-2026-000001", lines: [], totalQuantity: 0, standaloneCount: 0, standaloneQuantity: 0 },
    }));
    expect(screen.getByText(/stock covered this booking in full/i)).toBeTruthy();
    expect(screen.queryByText(/standalone indent line/)).toBeNull();
  });

  test("🔴 which materials are missing is not pricing — it survives without view_pricing", () => {
    useUserStore.setState({ user: { _id: "s1", role: "Sales", permissions: ["view_all_bookings"] }, loading: false });
    open(booking());

    // The money column is gone; the quantities, names and the standalone count
    // are operational facts and stay.
    expect(indentRows()[0]).toBe("SKU / Product Code | MSIL Code | Product Name | Quantity | Status");
    expect(indentRows().join("\n")).toMatch(/Impact Socket Set 10pc/);
    expect(screen.getByText(/2 standalone indent line\(s\) \(33 pc\)/)).toBeTruthy();
  });

  test("an older payload with no flag still marks what is missing", () => {
    // Backward compatibility: a cached list row predating the server flag falls
    // back to comparing against the line table, which is what the screen did
    // before. SKU-ZERO is not in `lines`, so it is still called out.
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

    expect(screen.getAllByText("Standalone")).toHaveLength(1);
    expect(indentRows().join("\n")).toMatch(/SKU-ZEROStandalone/);
  });
});
