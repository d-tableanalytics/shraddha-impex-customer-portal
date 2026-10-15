import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * What Booking History asks the server for.
 *
 * Opening the page used to fire `/orders` twice (the toolbar fetched the whole
 * list again just to build its company dropdown) and download three brands of
 * product catalogue at `limit=2000` each, in case an export followed. These pin
 * one `/orders`, no catalogue on open, and an export that looks up exactly the
 * SKUs it contains — including ones the 2,000-row cap used to drop.
 */

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../services/api", () => ({
  api,
  describeRequestFailure: (_e, f) => f,
  refreshAccessToken: vi.fn(),
}));

const exportUtils = vi.hoisted(() => ({ exportToExcel: vi.fn(() => true), exportToPDF: vi.fn(() => true), printData: vi.fn(() => true) }));
vi.mock("../../utils/exportUtils", () => exportUtils);

import { OrderHistory } from "./OrderHistory";
import { useUserStore } from "../../store/userStore";
import { resetSessionStores } from "../../store/sessionReset";

const row = (orderId, skuCode, over = {}) => ({
  _id: `${orderId}-${skuCode}`, orderId, skuCode, brand: "Koken", company: "ABC Motors",
  status: "PO Received", createdAt: "2026-10-01T10:00:00Z", requestedQty: 5, bookedQty: 5,
  confirmedQty: 5, pendingQty: 0, poNumber: "-", user: "c1", ...over,
});

const ORDERS = [
  row("BO-2026-000001", "SKU-0005"),
  // Alphabetically far past the first 2,000 Ko-ken SKUs — the old export
  // printed "—" for exactly this kind of line.
  row("BO-2026-000001", "SKU-7600"),
  row("BO-2026-000002", "SKU-0005", { company: "Zed Traders", user: "c2" }),
];

const getCalls = (prefix) => api.get.mock.calls.filter(([url]) => String(url).startsWith(prefix));

describe("Booking History requests", () => {
  beforeEach(() => {
    resetSessionStores();
    useUserStore.setState({ user: { _id: "a1", role: "Admin", permissions: ["*"] }, loading: false });
    api.get.mockImplementation((url) => {
      if (url === "/orders") return Promise.resolve({ data: { data: ORDERS } });
      if (url === "/reservations/pending") return Promise.resolve({ data: { data: [] } });
      if (url === "/reservations/cancelled-count") return Promise.resolve({ data: { data: { count: 2 } } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    api.post.mockImplementation((url, body) => {
      if (url !== "/products/lookup") return Promise.reject(new Error(`unexpected POST ${url}`));
      return Promise.resolve({
        data: {
          data: body.skuCodes.map((sku) => ({ lookupCode: sku, skuCode: sku, found: true, brand: "Koken", available: sku === "SKU-7600" ? 42 : 3 })),
          summary: {},
        },
      });
    });
  });

  const renderPage = () => render(<MemoryRouter><OrderHistory /></MemoryRouter>);

  test("opening the page loads the bookings once and no product catalogue", async () => {
    renderPage();
    await waitFor(() => expect(getCalls("/orders")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getCalls("/orders")).toHaveLength(1);
    expect(getCalls("/products")).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
    expect(getCalls("/reservations/pending")).toHaveLength(1);
  });

  test("the customer filter is built from the bookings already loaded", async () => {
    renderPage();
    expect(await screen.findByRole("option", { name: "Zed Traders" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "ABC Motors" })).toBeTruthy();
    expect(getCalls("/orders")).toHaveLength(1);
  });

  test("every customer option selects that customer's bookings", async () => {
    // A customer whose master record names them: `customer` (what the filter
    // compares) is "Rahul Sharma", while the stamped company is "ABC Motors".
    // The dropdown used to offer the company, which then matched nothing.
    const named = { customerName: "Rahul Sharma", company: "ABC Motors" };
    const rows = [
      row("BO-2026-000001", "SKU-0005", { customerProfile: named }),
      row("BO-2026-000002", "SKU-0005", { company: "Zed Traders", user: "c2" }),
    ];
    api.get.mockImplementation((url) => {
      if (url === "/orders") return Promise.resolve({ data: { data: rows } });
      if (url === "/reservations/pending") return Promise.resolve({ data: { data: [] } });
      return Promise.resolve({ data: { data: { count: 0 } } });
    });
    renderPage();
    await screen.findByRole("option", { name: "Rahul Sharma" });
    expect(screen.queryByRole("option", { name: "ABC Motors" })).toBeNull();

    const { useOrderHistoryStore } = await import("../../store/orderHistoryStore");
    const select = screen.getByTitle("Filter by customer");
    for (const option of [...select.options].filter((o) => o.value !== "all")) {
      fireEvent.change(select, { target: { value: option.value } });
      const shown = useOrderHistoryStore.getState().orders;
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((o) => o.customer === option.value)).toBe(true);
    }
    fireEvent.change(select, { target: { value: "Rahul Sharma" } });
    expect(useOrderHistoryStore.getState().orders.map((o) => o.orderNumber)).toEqual(["BO-2026-000001"]);
  });

  test("export looks up exactly its SKUs, at export time, and fills every line", async () => {
    renderPage();
    await screen.findByRole("option", { name: "Zed Traders" });
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Export to Excel"));
    await waitFor(() => expect(exportUtils.exportToExcel).toHaveBeenCalledTimes(1));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/products/lookup");
    expect([...body.skuCodes].sort()).toEqual(["SKU-0005", "SKU-7600"]);

    const [rows, columns, fileName] = exportUtils.exportToExcel.mock.calls[0];
    expect(fileName).toBe("Booking_History");
    expect(columns.find((c) => c.key === "available")?.label).toBe("Available Quantity");
    const availableOf = (orderNumber, sku) =>
      rows.find((r) => r.orderNumber === orderNumber && r.skuCode === sku)?.available;
    expect(availableOf("BO-2026-000001", "SKU-7600")).toBe(42);
    expect(availableOf("BO-2026-000001", "SKU-0005")).toBe(3);
    expect(availableOf("BO-2026-000002", "SKU-0005")).toBe(3);
  });

  test("an export whose stock cannot be read fails visibly instead of printing blanks", async () => {
    api.post.mockRejectedValue(new Error("down"));
    renderPage();
    await screen.findByRole("option", { name: "Zed Traders" });
    fireEvent.click(screen.getByText("Export to Excel"));
    const toast = (await import("react-hot-toast")).default;
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(exportUtils.exportToExcel).not.toHaveBeenCalled();
  });
});
